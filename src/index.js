import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} from 'discord.js';
import { DateTime } from 'luxon';
import { RESTRICTED_COMMANDS, SERVER_RULES } from './config.js';
import {
  BENCH,
  JOBS,
  MELEE_JOBS,
  OPTIONAL_JOB_ROLES,
  REQUIRED_JOB_GROUPS,
  ROLES,
  ROLE_JOBS,
  TANK_JOBS,
  describeJobs,
  describeSignup,
  jobsForRoles,
  missingJobs,
  orderedSelection,
  parsePost,
  placementOf,
  renderRun,
  roleStatus,
  selectionToSignup,
} from './roster.js';
import { allRuns, deleteRun, findRunById, getRun, newRunId, setRun } from './runs.js';
import { parseTime } from './time.js';
import { autocompleteZones, getUserZone, resolveZone, setUserZone } from './timezones.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// A completed run's private channel is deleted this long after /managerun marks it completed.
const CHANNEL_DELETE_DELAY_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------
function runCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption((o) =>
      o.setName('amount').setDescription('Amount (e.g. 5m, $20)').setRequired(true).setMaxLength(50))
    .addStringOption((o) =>
      o.setName('text').setDescription('Custom text (e.g. "M4S clear")').setRequired(true).setMaxLength(300))
    .addStringOption((o) =>
      o.setName('time').setDescription('When, in your timezone (e.g. "sept 28 @ 4 PM")').setRequired(true).setMaxLength(100))
    .addStringOption((o) =>
      o.setName('clearee')
        .setDescription('Who the run is for: pick someone from the list, or type any name')
        .setRequired(true)
        .setMaxLength(100)
        .setAutocomplete(true))
    .addStringOption((o) =>
      o.setName('role')
        .setDescription("Clearee's role slot (they're filled in there automatically)")
        .setRequired(true)
        .addChoices(...ROLES.map((r) => ({ name: r, value: r }))))
    .addStringOption((o) =>
      o.setName('timezone')
        .setDescription('Your timezone (only needed once; it gets remembered)')
        .setAutocomplete(true));
}

const commands = [
  runCommand('createrun', 'Create a run post that people can sign up for'),
  runCommand('createrun-test', '[Test] Create a run with a Merc Run ID and its own private channel'),
  new SlashCommandBuilder()
    .setName('managerun')
    .setDescription('Mark a run completed or failed, reschedule it, or delete it')
    .addStringOption((o) =>
      o.setName('run_id')
        .setDescription('The 6-digit Merc Run ID')
        .setRequired(true)
        .setMinLength(6)
        .setMaxLength(6)
        .setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('settimezone')
    .setDescription('Save your timezone so /createrun understands your times')
    .addStringOption((o) =>
      o.setName('timezone').setDescription('e.g. America/New_York, EST, UTC+8').setRequired(true).setAutocomplete(true)),
].map((c) => c.toJSON());

// ---------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------
function runButtons(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('run:join').setLabel('Sign up').setEmoji('✅').setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder().setCustomId('run:leave').setLabel('Leave').setEmoji('❌').setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

const PICK_HELP =
  '**Pick one role** to lock it in, or **several roles to flex**. Pick them **in order of preference**: ' +
  'you get the first one on your list that\'s free, and move up your list when a higher choice opens up. ' +
  'To change the order, untick a role and tick it again (it goes to the end).\n' +
  'Whoever signs up first has priority. If your pick is held by someone earlier, you go on the ' +
  '**Waitlist** and are moved in automatically when it opens up.\n' +
  'Add **BENCH** to be a backup instead of taking a slot. You can add the roles you can cover.\n' +
  'For **MT/OT** you must pick your tank jobs, and for **M1/M2** your melee jobs (more than one is fine). ' +
  'Jobs for healer and ranged roles are optional.';

const STATUS_TEXT = {
  open: 'Open',
  flex: 'Held by a flex player who can move. Picking only this takes it.',
  taken: 'Taken. Picking only this puts you on the waitlist.',
};

// The picker's current selection is stored in the Confirm button's custom ID (max 100 chars):
//   run:confirm:<messageId>:<roles>:<jobs>
// roles = one digit per pick, in pick order (index into ROLES + BENCH); jobs = base-36 bitmask of JOBS.
const PICK_VALUES = [...ROLES, BENCH];
const encodeValues = (values) => values.map((v) => PICK_VALUES.indexOf(v)).filter((i) => i >= 0).join('');
const decodeValues = (code = '') => (/^\d*$/.test(code)
  ? [...code].map((c) => PICK_VALUES[Number(c)]).filter(Boolean)
  : code.split('.').filter(Boolean)); // older "MT.OT" format
const encodeJobs = (jobs) =>
  jobs.reduce((n, j) => (JOBS.includes(j) ? n | (1 << JOBS.indexOf(j)) : n), 0).toString(36);
const decodeJobs = (code = '') => {
  const n = parseInt(code || '0', 36);
  return Number.isNaN(n) ? [] : JOBS.filter((_, i) => n & (1 << i));
};

function jobMenu(customId, placeholder, options, jobs, minValues) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder.slice(0, 150))
      .setMinValues(minValues)
      .setMaxValues(options.length)
      .addOptions(options.map(({ job, forRoles }) => ({
        label: job,
        value: job,
        description: `Can play ${job} as ${forRoles}`,
        default: jobs.includes(job),
      }))),
  );
}

/**
 * Sign-up picker: role menu, then job menus for the picked roles, then Confirm.
 * At most 5 rows: roles, tank jobs, melee jobs, optional jobs, Confirm.
 * @param {string} messageId run post ID
 * @param {Record<string,string>} status from roleStatus()
 * @param {string[]} selected currently selected values, in pick order
 * @param {string[]} jobs currently selected jobs
 * @param {boolean} canConfirm whether the selection is valid
 */
function rolePicker(messageId, status, selected = [], jobs = [], canConfirm = false) {
  const picked = selected.filter((v) => v !== BENCH);
  const options = [
    ...ROLES.map((r) => {
      const rank = picked.indexOf(r);
      return {
        label: rank === -1 ? r : `${r} (choice #${rank + 1})`,
        value: r,
        description: STATUS_TEXT[status[r]],
        default: rank !== -1,
      };
    }),
    {
      label: 'BENCH',
      value: BENCH,
      description: 'Backup only. Add any roles you can cover.',
      default: selected.includes(BENCH),
    },
  ];

  const select = new StringSelectMenuBuilder()
    .setCustomId(`run:select:${messageId}`)
    .setPlaceholder('Choose one or more roles')
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(options);

  const rows = [new ActionRowBuilder().addComponents(select)];

  // Required: tank jobs for MT/OT, melee jobs for M1/M2.
  for (const g of REQUIRED_JOB_GROUPS) {
    const forRoles = picked.filter((r) => g.roles.includes(r)).join('/');
    if (!forRoles) continue;
    rows.push(jobMenu(
      `run:jobs-${g.key}:${messageId}`,
      `Required: which ${g.label} jobs can you play? (${forRoles})`,
      g.jobs.map((job) => ({ job, forRoles })),
      jobs,
      1,
    ));
  }

  // Optional: jobs for healer and ranged roles.
  const optRoles = picked.filter((r) => OPTIONAL_JOB_ROLES.includes(r));
  if (optRoles.length) {
    rows.push(jobMenu(
      `run:jobs-opt:${messageId}`,
      `Optional: which jobs can you play? (${optRoles.join('/')})`,
      optRoles.flatMap((r) => ROLE_JOBS[r].map((job) => ({ job, forRoles: r }))),
      jobs,
      0,
    ));
  }

  const signup = selectionToSignup('', selected, jobs);
  const confirm = new ButtonBuilder()
    .setCustomId(`run:confirm:${messageId}:${encodeValues(selected)}:${encodeJobs(signup.jobs)}`)
    .setLabel(canConfirm ? `Confirm: ${describeSignup(signup)}`.slice(0, 80) : 'Confirm')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!canConfirm);

  rows.push(new ActionRowBuilder().addComponents(confirm));
  return rows;
}

function manageButtons(messageId, run) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`manage:complete:${messageId}`).setLabel('Completed').setEmoji('✅')
        .setStyle(ButtonStyle.Success).setDisabled(run.status === 'completed'),
      new ButtonBuilder().setCustomId(`manage:fail:${messageId}`).setLabel('Failed').setEmoji('❌')
        .setStyle(ButtonStyle.Danger).setDisabled(run.status === 'failed'),
      new ButtonBuilder().setCustomId(`manage:reschedule:${messageId}`).setLabel('Reschedule').setEmoji('🕒')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`manage:delete:${messageId}`).setLabel('Delete run').setEmoji('🗑️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function rescheduleModal(messageId, run) {
  return new ModalBuilder()
    .setCustomId(`manage:reschedule-submit:${messageId}`)
    .setTitle(`Reschedule run ${run.runId}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('time')
          .setLabel('New time (in your timezone)')
          .setPlaceholder('e.g. sept 30 @ 8 PM')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
    );
}

// Serialize edits per run post so two people can't grab the same slot at once.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  return next;
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// ---------------------------------------------------------------------------
// Run display helpers
// ---------------------------------------------------------------------------
const STATUS_LABEL = { completed: 'Completed ✅', failed: 'Failed ❌' };
const isClosed = (run) => run.status === 'completed' || run.status === 'failed';

// /createrun-test posts show the Merc Run ID. Older test runs don't have `showId` saved.
const showsRunId = (run) => run.showId ?? Boolean(run.runId);

function statusText(run) {
  if (run.status === 'completed') return 'Completed';
  if (run.status === 'failed') return 'Failed';
  return run.rescheduled ? 'Open (rescheduled)' : 'Open';
}

/** Header shown at the top of the post: the ping, then (for test runs) the Merc Run ID, then the run. */
function displayHeader(run) {
  const label = STATUS_LABEL[run.status] ?? (run.rescheduled ? 'Rescheduled' : '');
  let text;
  if (showsRunId(run)) text = `**Merc Run ID: ${run.runId}**${label ? ` (${label})` : ''}\n${run.header}`;
  else text = label ? `**${label}**\n${run.header}` : run.header;
  return run.ping ? `${run.ping}\n${text}` : text;
}

/** What a new run post pings: the server's ping role if it has one (see config.js), otherwise @here. */
function pingFor(guildId) {
  const roleId = SERVER_RULES[guildId]?.pingRole;
  return roleId
    ? { text: `<@&${roleId}>`, allowedMentions: { roles: [roleId] }, roleId }
    : { text: '@here', allowedMentions: { parse: ['everyone'] }, roleId: null };
}

// The clearee is shown by name in the run post instead of being @mentioned. `cleareeKey` is the
// ID used for their roster slot: their user ID, or a placeholder if they aren't a server member.
function labelsFor(run) {
  const key = run.cleareeKey ?? run.cleareeId;
  return key && run.cleareeName ? { [key]: run.cleareeName } : {};
}

const render = (run, signups = run.signups) =>
  renderRun(displayHeader(run), signups, run.placed, labelsFor(run));

const isUserId = (id) => /^\d{15,21}$/.test(id ?? '');

/** Everyone who should be able to see a run's private channel (real Discord users only). */
function channelMembers(run) {
  return [...new Set([run.creatorId, run.cleareeId, ...run.signups.map((s) => s.userId)].filter(isUserId))];
}

// ---------------------------------------------------------------------------
// Clearee lookup
// ---------------------------------------------------------------------------
const memberNames = (m) =>
  [m.displayName, m.nickname, m.user.globalName, m.user.username].filter(Boolean).map((n) => n.toLowerCase());

/**
 * Match the clearee text to a server member: a picked suggestion or mention (<@id>), a user ID,
 * or a name that exactly matches someone's server nickname, display name or username.
 * Returns the member, or null if nobody matches (the run then just uses the text).
 */
async function findClearee(guild, input) {
  const text = input.trim();
  const id = text.match(/^<@!?(\d{15,21})>$/)?.[1] ?? text.match(/^(\d{15,21})$/)?.[1];
  if (id) return guild.members.fetch(id).catch(() => null);

  const name = text.replace(/^@/, '').toLowerCase();
  if (!name) return null;
  const found = await guild.members.search({ query: name, limit: 25 }).catch(() => null);
  const exact = [...(found?.values() ?? [])].filter((m) => memberNames(m).includes(name));
  return exact.length === 1 ? exact[0] : null; // several people with that name: don't guess
}

async function autocompleteClearee(interaction, query) {
  const q = query.trim().replace(/^@/, '');
  if (!q || !interaction.guild) return [];
  const found = await interaction.guild.members.search({ query: q, limit: 25 }).catch(() => null);
  return [...(found?.values() ?? [])]
    .filter((m) => !m.user.bot)
    .map((m) => {
      const extra = m.user.username !== m.displayName ? ` (${m.user.username})` : '';
      return { name: `${m.displayName}${extra}`.slice(0, 100), value: `<@${m.id}>` };
    });
}

// Stop typed text from pinging @everyone / @here (the run post allows those for its own ping).
const noMassPing = (s) => s.replace(/@(everyone|here)/gi, '@\u200b$1');

// ---------------------------------------------------------------------------
// Per-server role rules (see config.js)
// ---------------------------------------------------------------------------
function memberRoleIds(member) {
  const roles = member?.roles;
  if (!roles) return [];
  return Array.isArray(roles) ? roles : [...roles.cache.keys()];
}

/** Whether the member passes this server's rule ('commandRoles' or 'signupRoles'). */
function hasRuleRole(interaction, rule) {
  const required = SERVER_RULES[interaction.guildId]?.[rule];
  if (!required?.length) return true;
  const mine = memberRoleIds(interaction.member);
  return required.some((id) => mine.includes(id));
}

const needRoleText = (interaction, rule, action) =>
  `Only members with the ${SERVER_RULES[interaction.guildId][rule].map((id) => `<@&${id}>`).join(' or ')} ` +
  `role can ${action}.`;

function canManage(interaction, run) {
  if (!hasRuleRole(interaction, 'commandRoles')) return false;
  return interaction.user.id === run.creatorId ||
    Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels));
}

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------
const slug = (s) => s.toLowerCase()
  .replace(/[^\p{L}\p{N}_-]+/gu, '-')
  .replace(/-{2,}/g, '-')
  .replace(/^-+|-+$/g, '');

/** /createrun channel name: amount, text and the day of the run, e.g. "5m-m4s-clear-sep-28". */
function dayChannelName(title, date) {
  const day = slug(date.setLocale('en-US').toFormat('LLL d'));
  const base = slug(title).slice(0, 99 - day.length).replace(/-+$/, '');
  return base ? `${base}-${day}` : day;
}

// ---------------------------------------------------------------------------
// Private run channels
// ---------------------------------------------------------------------------
const MEMBER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

async function createPrivateChannel(interaction, run, name) {
  const { guild } = interaction;
  const inCategory = interaction.channel?.parent?.type === ChannelType.GuildCategory;
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: inCategory ? interaction.channel.parentId : null,
    topic: `Merc Run ID ${run.runId}: ${run.title}`.slice(0, 1024),
    reason: `Merc run ${run.runId} created by ${interaction.user.tag}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.client.user.id,
        type: OverwriteType.Member,
        allow: [...MEMBER_ALLOW, PermissionFlagsBits.ManageChannels],
      },
      ...channelMembers(run).map((id) => ({ id, type: OverwriteType.Member, allow: MEMBER_ALLOW })),
    ],
  });
}

async function fetchPrivateChannel(run) {
  if (!run.privateChannelId) return null;
  return client.channels.fetch(run.privateChannelId).catch(() => null);
}

/** Give a user access to the run's private channel (if it has one). No message is posted. */
async function addToPrivateChannel(run, userId) {
  try {
    const channel = await fetchPrivateChannel(run);
    if (!channel || channel.permissionOverwrites.cache.has(userId)) return;
    await channel.permissionOverwrites.edit(
      userId,
      { ViewChannel: true, SendMessages: true, ReadMessageHistory: true },
      { type: OverwriteType.Member, reason: `Signed up for merc run ${run.runId}` },
    );
  } catch (err) {
    console.error(`Couldn't add ${userId} to the channel for run ${run.runId}:`, err.message);
  }
}

/** Remove a user from the run's private channel. The creator and clearee always keep access. No message is posted. */
async function removeFromPrivateChannel(run, userId) {
  if (userId === run.creatorId || userId === run.cleareeId) return;
  try {
    const channel = await fetchPrivateChannel(run);
    if (!channel) return;
    await channel.permissionOverwrites.delete(userId, `Left merc run ${run.runId}`);
  } catch (err) {
    console.error(`Couldn't remove ${userId} from the channel for run ${run.runId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Roster copy in the private channel (the only message the bot posts there)
// ---------------------------------------------------------------------------

/** The run post's text without the @here / role ping line (no point pinging in the private channel). */
function rosterCopyContent(run, postContent) {
  const pingLine = run.ping ? `${run.ping}\n` : '';
  return pingLine && postContent.startsWith(pingLine) ? postContent.slice(pingLine.length) : postContent;
}

/** Update the roster copy in the private channel to match the run post. Never throws. */
async function syncRosterCopy(run, postContent) {
  if (!run.privateChannelId || !run.rosterCopyId) return;
  try {
    const channel = await fetchPrivateChannel(run);
    const copy = channel && (await channel.messages.fetch(run.rosterCopyId).catch(() => null));
    if (!copy) return;
    await copy.edit({ content: rosterCopyContent(run, postContent), allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`Couldn't update the roster copy for run ${run.runId}:`, err.message);
  }
}

// Rename a /createrun channel to the new day after a reschedule. Not awaited, because Discord
// only allows 2 renames per channel every 10 minutes and would otherwise hold up the reply.
function renameDayChannel(run, date) {
  fetchPrivateChannel(run)
    .then((channel) => channel?.setName(dayChannelName(run.title, date), `Merc run ${run.runId} rescheduled`))
    .catch((err) => console.error(`Couldn't rename the channel for run ${run.runId}:`, err.message));
}

// Delete private channels whose 3-hour countdown has run out. Runs every minute, so pending
// deletions still happen after a restart.
async function sweepChannels() {
  const now = Date.now();
  for (const [messageId, pending] of allRuns()) {
    if (!pending.channelDeleteAt || pending.channelDeleteAt > now) continue;
    await withLock(messageId, async () => {
      const run = getRun(messageId);
      if (!run?.channelDeleteAt || run.channelDeleteAt > Date.now()) return;
      let channel = null;
      try {
        channel = await client.channels.fetch(run.privateChannelId);
      } catch (err) {
        // 10003 = channel already gone, 50001 = bot no longer has access (e.g. removed from the server).
        if (![10003, 50001].includes(err.code)) throw err;
      }
      if (channel) await channel.delete(`Merc run ${run.runId} completed`);
      setRun(messageId, { ...run, privateChannelId: null, channelDeleteAt: null });
      console.log(`Deleted the private channel for completed run ${run.runId}.`);
    }).catch((err) => console.error(`Couldn't delete the channel for run ${pending.runId}:`, err.message));
  }
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------
async function handleCreateRun(interaction, { test = false } = {}) {
  const amount = noMassPing(interaction.options.getString('amount', true));
  const text = noMassPing(interaction.options.getString('text', true));
  const timeInput = interaction.options.getString('time', true);
  const cleareeInput = interaction.options.getString('clearee', true);
  const role = interaction.options.getString('role', true);
  const tzInput = interaction.options.getString('timezone');

  if (!interaction.inGuild()) {
    return interaction.reply(ephemeral('This command only works in a server.'));
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  if (!me.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) {
    return interaction.reply(ephemeral(
      'I need the **Manage Channels** and **Manage Roles** permissions to create private run channels. ' +
      'Ask a server admin to give them to my role.',
    ));
  }

  let zone = getUserZone(interaction.user.id);
  if (tzInput) {
    zone = resolveZone(tzInput);
    if (!zone) return interaction.reply(ephemeral(`Unknown timezone \`${tzInput}\`. Pick one from the list.`));
    setUserZone(interaction.user.id, zone);
  }

  const parsed = parseTime(timeInput, zone);
  if (parsed.error) return interaction.reply(ephemeral(parsed.error));

  // Reply privately to the creator. The run itself is sent as a normal message so the ping
  // notifies people (mentions added by editing a message don't).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // The clearee doesn't have to be a server member. If the text matches one, they get the slot
  // and are added to the private channel; otherwise the text is just shown as their name.
  const cleareeMember = await findClearee(interaction.guild, cleareeInput);
  const runId = newRunId();
  const cleareeName = cleareeMember
    ? escapeMarkdown(cleareeMember.displayName)
    : escapeMarkdown(noMassPing(cleareeInput.trim().replace(/^@/, ''))) || 'clearee';
  const cleareeKey = cleareeMember?.id ?? `clearee-${runId}`;

  // The clearee is named, not @mentioned, in the channel the run is posted in.
  const header = `${amount} ${text} <t:${parsed.ts}:f> for ${cleareeName} ${role}`;
  const ping = pingFor(interaction.guildId);
  const run = {
    header,
    ping: ping.text,
    title: `${amount} ${text}`,
    startsAt: parsed.ts,
    signups: [{ userId: cleareeKey, mode: 'firm', roles: [role] }],
    placed: {},
    status: 'open',
    runId,
    showId: test,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    privateChannelId: null,
    channelDeleteAt: null,
    creatorId: interaction.user.id,
    cleareeId: cleareeMember?.id ?? null,
    cleareeKey,
    cleareeName,
  };

  // /createrun-test: merc-run-<id>. /createrun: amount, text and day, e.g. 5m-m4s-clear-sep-28.
  const channelName = test ? `merc-run-${run.runId}` : dayChannelName(run.title, parsed.date);
  let privateChannel;
  try {
    privateChannel = await createPrivateChannel(interaction, run, channelName);
  } catch (err) {
    console.error(`Couldn't create the channel for run ${run.runId}:`, err);
    return interaction.editReply(`Couldn't create the private channel for this run: ${err.message}`);
  }
  run.privateChannelId = privateChannel.id;

  const rendered = render(run);
  run.placed = rendered.placed;
  let post;
  try {
    const channel = interaction.channel ?? (await client.channels.fetch(interaction.channelId));
    post = await channel.send({
      content: rendered.content,
      components: [runButtons()],
      allowedMentions: ping.allowedMentions,
    });
  } catch (err) {
    console.error(`Couldn't post run ${run.runId}:`, err);
    await privateChannel.delete('Run post failed').catch(() => {});
    return interaction.editReply(
      `Couldn't post the run here: ${err.message}\nI need **View Channel** and **Send Messages** in this channel.`,
    );
  }
  setRun(post.id, run);

  // Copy of the run post in the private channel. It's kept in sync whenever the roster changes.
  const copy = await privateChannel.send({
    content: rosterCopyContent(run, rendered.content),
    allowedMentions: { parse: [] },
  }).catch((err) => {
    console.error(`Couldn't post the roster copy for run ${run.runId}:`, err.message);
    return null;
  });
  if (copy) {
    run.rosterCopyId = copy.id;
    setRun(post.id, run);
    await copy.pin('Run roster').catch(() => {}); // needs Manage Messages; fine if it can't
  }

  let done = `Run posted: ${post.url}\nMerc Run ID: **${run.runId}** · Channel: <#${privateChannel.id}>`;
  const pingRole = ping.roleId && interaction.guild.roles.cache.get(ping.roleId);
  const canPing = post.channel.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone) ||
    (pingRole && pingRole.mentionable);
  if (!canPing) {
    done += `\n⚠️ I don't have **Mention @everyone, @here and All Roles** here, so ${ping.text} didn't notify anyone.`;
  }
  if (!cleareeMember) {
    done += `\nNo server member matched "${cleareeName}", so the clearee is shown by name only and wasn't added to the channel.`;
  }
  await interaction.editReply({ content: done, allowedMentions: { parse: [] } });
}

async function handleSetTimezone(interaction) {
  const input = interaction.options.getString('timezone', true);
  const zone = resolveZone(input);
  if (!zone) return interaction.reply(ephemeral(`Unknown timezone \`${input}\`. Pick one from the list.`));
  setUserZone(interaction.user.id, zone);
  const now = DateTime.now().setZone(zone).toFormat("ccc, LLL d 'at' h:mm a");
  return interaction.reply(ephemeral(`Timezone saved as **${zone}** (your time now: ${now}).`));
}

function manageSummary(run) {
  const lines = [
    `**Merc Run ID: ${run.runId}**`,
    run.header,
    `Status: **${statusText(run)}**`,
  ];
  if (run.privateChannelId) {
    lines.push(`Channel: <#${run.privateChannelId}>`);
    if (run.channelDeleteAt) {
      lines.push(`The channel will be deleted <t:${Math.floor(run.channelDeleteAt / 1000)}:R>.`);
    }
  } else {
    lines.push('Channel: deleted');
  }
  lines.push('', 'What do you want to do?');
  return lines.join('\n');
}

async function handleManageRun(interaction) {
  if (!interaction.inGuild()) return interaction.reply(ephemeral('This command only works in a server.'));

  const runId = interaction.options.getString('run_id', true).trim();
  const found = findRunById(interaction.guildId, runId);
  if (!found) return interaction.reply(ephemeral(`There's no run with Merc Run ID **${runId}** in this server.`));
  if (!canManage(interaction, found.run)) {
    return interaction.reply(ephemeral('Only the person who created this run, or someone with Manage Channels, can manage it.'));
  }

  return interaction.reply({
    content: manageSummary(found.run),
    components: manageButtons(found.messageId, found.run),
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------------------
// /managerun actions
// ---------------------------------------------------------------------------

/** Re-render the run post from saved state. Returns false if the post no longer exists. */
async function updatePost(messageId, run) {
  const channel = await client.channels.fetch(run.channelId).catch(() => null);
  const post = channel && (await channel.messages.fetch(messageId).catch(() => null));
  if (!post) return false;
  const rendered = render(run);
  run.placed = rendered.placed;
  await post.edit({
    content: rendered.content,
    components: [runButtons(isClosed(run))],
    allowedMentions: { parse: [] },
  });
  await syncRosterCopy(run, rendered.content);
  return true;
}

async function closeRun(interaction, messageId, status) {
  await interaction.deferUpdate();
  return withLock(messageId, async () => {
    const run = getRun(messageId);
    if (!run) return interaction.editReply({ content: 'That run no longer exists.', components: [] });

    run.status = status;
    run.channelDeleteAt = status === 'completed' && run.privateChannelId
      ? Date.now() + CHANNEL_DELETE_DELAY_MS
      : null;
    const postExists = await updatePost(messageId, run);
    setRun(messageId, run);

    // The private channel only has the roster copy, which updatePost() already refreshed.
    const deleteAt = run.channelDeleteAt ? Math.floor(run.channelDeleteAt / 1000) : null;
    let reply;
    if (status === 'completed') {
      reply = `Run **${run.runId}** marked as completed.` +
        (deleteAt ? ` Its private channel will be deleted <t:${deleteAt}:R>.` : '');
    } else {
      reply = `Run **${run.runId}** marked as failed. Sign-ups are closed until it's rescheduled.`;
    }
    if (!postExists) reply += '\n(The run post was deleted, so only the saved record was updated.)';
    return interaction.editReply({ content: reply, components: [] });
  });
}

async function deleteWholeRun(interaction, messageId) {
  await interaction.deferUpdate();
  return withLock(messageId, async () => {
    const run = getRun(messageId);
    if (!run) return interaction.editReply({ content: 'That run no longer exists.', components: [] });

    const channel = await client.channels.fetch(run.channelId).catch(() => null);
    const post = channel && (await channel.messages.fetch(messageId).catch(() => null));
    if (post) await post.delete().catch(() => {});
    const privateChannel = await fetchPrivateChannel(run);
    if (privateChannel) await privateChannel.delete(`Merc run ${run.runId} deleted by ${interaction.user.tag}`).catch(() => {});
    deleteRun(messageId);

    // If /managerun was used inside the private channel, that channel is gone now, so this can fail.
    return interaction.editReply({ content: `Run **${run.runId}** deleted.`, components: [] }).catch(() => {});
  });
}

async function handleManageButton(interaction, action, messageId) {
  const run = getRun(messageId);
  if (!run) return interaction.update({ content: 'That run no longer exists.', components: [] });
  if (!canManage(interaction, run)) {
    return interaction.reply(ephemeral('Only the person who created this run, or someone with Manage Channels, can manage it.'));
  }

  switch (action) {
    case 'complete':
      return closeRun(interaction, messageId, 'completed');
    case 'fail':
      return closeRun(interaction, messageId, 'failed');
    case 'reschedule':
      return interaction.showModal(rescheduleModal(messageId, run));
    case 'delete':
      return interaction.update({
        content: `Delete run **${run.runId}**? This removes the run post and its private channel, and can't be undone.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`manage:delete-yes:${messageId}`).setLabel('Yes, delete it')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`manage:cancel:${messageId}`).setLabel('Cancel')
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    case 'delete-yes':
      return deleteWholeRun(interaction, messageId);
    case 'cancel':
      return interaction.update({ content: manageSummary(run), components: manageButtons(messageId, run) });
    default:
      return undefined;
  }
}

async function handleRescheduleSubmit(interaction, messageId) {
  const existing = getRun(messageId);
  if (!existing) return interaction.reply(ephemeral('That run no longer exists.'));
  if (!canManage(interaction, existing)) {
    return interaction.reply(ephemeral('Only the person who created this run, or someone with Manage Channels, can manage it.'));
  }

  const input = interaction.fields.getTextInputValue('time');
  const parsed = parseTime(input, getUserZone(interaction.user.id));
  if (parsed.error) return interaction.reply(ephemeral(parsed.error));

  if (interaction.isFromMessage()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  return withLock(messageId, async () => {
    const run = getRun(messageId);
    if (!run) return interaction.editReply({ content: 'That run no longer exists.', components: [] });

    const stamp = `<t:${parsed.ts}:f>`;
    run.header = /<t:-?\d+(?::[tTdDfFR])?>/.test(run.header)
      ? run.header.replace(/<t:-?\d+(?::[tTdDfFR])?>/, stamp)
      : `${run.header} ${stamp}`;
    run.startsAt = parsed.ts;
    run.status = 'open';
    run.rescheduled = true;
    run.channelDeleteAt = null;
    const postExists = await updatePost(messageId, run);
    setRun(messageId, run);

    if (!showsRunId(run) && run.privateChannelId) renameDayChannel(run, parsed.date);

    let reply = `Run **${run.runId}** rescheduled to <t:${parsed.ts}:F>. Sign-ups are open again.`;
    if (!run.privateChannelId) reply += '\n(Its private channel was already deleted.)';
    if (!postExists) reply += '\n(The run post was deleted, so only the saved record was updated.)';
    return interaction.editReply({ content: reply, components: [] });
  });
}

function autocompleteRuns(interaction, query) {
  const q = query.trim().toLowerCase();
  const zone = getUserZone(interaction.user.id) ?? 'UTC';
  return allRuns()
    .map(([, run]) => run)
    .filter((run) => run.runId && run.guildId === interaction.guildId && canManage(interaction, run))
    .filter((run) => !q || run.runId.startsWith(q) || (run.title ?? '').toLowerCase().includes(q))
    .sort((a, b) => (b.startsAt ?? 0) - (a.startsAt ?? 0))
    .slice(0, 25)
    .map((run) => {
      const when = run.startsAt
        ? DateTime.fromSeconds(run.startsAt).setZone(zone).toFormat('LLL d, h:mm a ZZZZ')
        : '';
      const name = [run.runId, run.title ?? 'Run', when, statusText(run)].filter(Boolean).join(' · ');
      return { name: name.slice(0, 100), value: run.runId };
    });
}

// ---------------------------------------------------------------------------
// Sign-up handlers
// ---------------------------------------------------------------------------
async function fetchPost(interaction, messageId) {
  const channel = interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId));
  return channel.messages.fetch(messageId).catch(() => null);
}

/** Saved state for a run post, or state rebuilt from the post text if none was saved. */
function runFromPost(post) {
  const saved = getRun(post.id);
  if (saved) return saved;
  const parsed = parsePost(post.content);
  const ts = parsed.header.match(/<t:(-?\d+)/);
  return { ...parsed, startsAt: ts ? Number(ts[1]) : null, channelId: post.channelId, guildId: post.guildId };
}

/** Everyone except this user, plus what the roles look like to them. */
function viewFor(run, userId) {
  const others = run.signups.filter((s) => s.userId !== userId);
  return { others, status: roleStatus(others, run.placed) };
}

const selectionValues = (s) => (s.mode === 'bench' ? [...s.roles, BENCH] : [...s.roles]);

/** The selection (roles in pick order, and jobs) stored in the picker's Confirm button. */
function previousPicks(message) {
  for (const row of message?.components ?? []) {
    for (const c of row.components ?? []) {
      if (c.customId?.startsWith('run:confirm:')) {
        const [, , , values, jobs] = c.customId.split(':');
        return { values: decodeValues(values), jobs: decodeJobs(jobs) };
      }
    }
  }
  return { values: [], jobs: [] };
}

/** Whether a selection can be confirmed, and what's still missing if not. */
function checkSelection(signup) {
  if (signup.mode !== 'bench' && !signup.roles.length) {
    return { ok: false, problems: ['Pick at least one role, or BENCH.'] };
  }
  const problems = missingJobs(signup.roles, signup.jobs).map((g) =>
    `⚠️ Pick at least one **${g.label} job** (${g.jobs.join('/')}) for ${g.picked.join('/')} in the menu below.`);
  return { ok: !problems.length, problems };
}

const closedMessage = (run) =>
  `This run is marked **${statusText(run).toLowerCase()}**, so sign-ups are closed.`;

/** What happened (or, with preview, what would happen) to a sign-up. */
function outcomeText(signup, rendered, preview = false) {
  const p = placementOf(signup, rendered);
  const you = preview ? "You'll be" : "✅ You're";
  if (p.bench) {
    return signup.roles.length
      ? `${you} on the bench as a backup for **${signup.roles.join('/')}**.`
      : `${you} on the bench.`;
  }
  if (p.waitlist) {
    const held = signup.roles.length === 1
      ? `**${signup.roles[0]}** is held by someone who signed up earlier`
      : `**${signup.roles.join('/')}** are all held by people who signed up earlier`;
    return `${you} on the **Waitlist**: ${held}. You'll be moved in automatically if a slot opens up.`;
  }
  if (p.movable) {
    return `${you} in **${p.role}** for now. If someone picks ${p.role} as their only role, ` +
      "you'll move to another of your roles.";
  }
  return `${you} in **${p.role}**.`;
}

async function handleJoin(interaction) {
  if (!hasRuleRole(interaction, 'signupRoles')) {
    return interaction.reply(ephemeral(needRoleText(interaction, 'signupRoles', 'sign up for runs')));
  }
  const post = interaction.message;
  const run = runFromPost(post);
  if (isClosed(run)) return interaction.reply(ephemeral(closedMessage(run)));

  const mine = run.signups.find((s) => s.userId === interaction.user.id);
  const { status } = viewFor(run, interaction.user.id);

  const current = mine
    ? `You're signed up as **${describeSignup(mine)}**` +
      (mine.jobs?.length ? ` (${describeJobs(mine)})` : '') +
      '. Picking again replaces that (and puts you at the back of the line).\n\n'
    : '';

  return interaction.reply({
    content: current + PICK_HELP,
    components: rolePicker(post.id, status, mine ? selectionValues(mine) : [], mine?.jobs ?? []),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSelect(interaction, messageId, kind) {
  if (!hasRuleRole(interaction, 'signupRoles')) {
    return interaction.update({ content: needRoleText(interaction, 'signupRoles', 'sign up for runs'), components: [] });
  }
  // Discord only sends the values of the menu that changed. The rest of the selection is kept in
  // the Confirm button. It also doesn't say which order roles were ticked in, so the order from
  // the last update is kept and newly ticked roles go on the end.
  const prev = previousPicks(interaction.message);
  let values = prev.values;
  let jobs = prev.jobs;
  if (kind === 'select') {
    values = orderedSelection(prev.values, interaction.values);
  } else {
    const menuJobs = kind === 'jobs-tank' ? TANK_JOBS
      : kind === 'jobs-melee' ? MELEE_JOBS
        : jobsForRoles(values.filter((r) => OPTIONAL_JOB_ROLES.includes(r)));
    jobs = [...jobs.filter((j) => !menuJobs.includes(j)), ...interaction.values];
  }

  const post = await fetchPost(interaction, messageId);
  if (!post) {
    deleteRun(messageId);
    return interaction.update({ content: 'That run post no longer exists.', components: [] });
  }

  const run = runFromPost(post);
  if (isClosed(run)) return interaction.update({ content: closedMessage(run), components: [] });

  const { others, status } = viewFor(run, interaction.user.id);
  const signup = selectionToSignup(interaction.user.id, values, jobs);
  const preview = render(run, [...others, signup]);
  const check = checkSelection(signup);

  const lines = [outcomeText(signup, preview, true)];
  if (signup.jobs.length) lines.push(`Jobs: **${describeJobs(signup)}**`);
  if (check.ok) lines.push(`Press **Confirm** to sign up as **${describeSignup(signup)}**.`);
  else lines.push(...check.problems);

  return interaction.update({
    content: lines.join('\n'),
    components: rolePicker(messageId, status, values, signup.jobs, check.ok),
  });
}

async function handleConfirm(interaction, messageId, encodedValues, encodedJobs) {
  if (!hasRuleRole(interaction, 'signupRoles')) {
    return interaction.update({ content: needRoleText(interaction, 'signupRoles', 'sign up for runs'), components: [] });
  }
  const values = decodeValues(encodedValues);
  const jobs = decodeJobs(encodedJobs);

  return withLock(messageId, async () => {
    const post = await fetchPost(interaction, messageId);
    if (!post) {
      deleteRun(messageId);
      return interaction.update({ content: 'That run post no longer exists.', components: [] });
    }

    const run = runFromPost(post);
    if (isClosed(run)) return interaction.update({ content: closedMessage(run), components: [] });

    const userId = interaction.user.id;
    const isNew = !run.signups.some((s) => s.userId === userId);
    const others = run.signups.filter((s) => s.userId !== userId);
    const signup = selectionToSignup(userId, values, jobs);
    const check = checkSelection(signup);
    if (!check.ok) {
      return interaction.update({ content: check.problems.join('\n'), components: [] });
    }

    // A new or changed pick goes to the back of the line. Anyone who signed up earlier keeps
    // priority, so if the pick is held by an earlier sign-up this user is waitlisted.
    const signups = [...others, signup];
    const rendered = render(run, signups);
    if (rendered.content.length > 2000) {
      return interaction.update({ content: 'This run post is full and can\'t fit more sign-ups.', components: [] });
    }

    await post.edit({ content: rendered.content, allowedMentions: { parse: [] } });
    const updated = { ...run, signups, placed: rendered.placed };
    setRun(messageId, updated);
    await interaction.update({
      content: outcomeText(signup, rendered) + (signup.jobs.length ? `\nJobs: **${describeJobs(signup)}**` : ''),
      components: [],
    });
    await syncRosterCopy(updated, rendered.content);
    if (isNew) await addToPrivateChannel(updated, userId);
  });
}

async function handleLeave(interaction) {
  return withLock(interaction.message.id, async () => {
    const post = await interaction.message.fetch();
    const run = runFromPost(post);
    if (isClosed(run)) return interaction.reply(ephemeral(closedMessage(run)));

    const mine = run.signups.find((s) => s.userId === interaction.user.id);
    if (!mine) return interaction.reply(ephemeral("You aren't signed up for this run."));

    const signups = run.signups.filter((s) => s !== mine);
    const rendered = render(run, signups);
    await interaction.update({ content: rendered.content, allowedMentions: { parse: [] } });
    const updated = { ...run, signups, placed: rendered.placed };
    setRun(post.id, updated);
    await interaction.followUp(ephemeral(`Removed you from the run (you were **${describeSignup(mine)}**).`));
    await syncRosterCopy(updated, rendered.content);
    await removeFromPrivateChannel(updated, interaction.user.id);
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// GUILD_ID controls where slash commands are registered:
//   (empty)          -> globally: every server the bot is in (can take up to an hour to show)
//   all              -> instantly in every server the bot is in, including servers it joins later
//   id1,id2,id3      -> instantly in just those servers
const guildSetting = (GUILD_ID ?? '').trim();
const registerMode = !guildSetting ? 'global' : guildSetting.toLowerCase() === 'all' ? 'all' : 'list';
const guildIds = registerMode === 'list'
  ? guildSetting.split(/[\s,]+/).filter(Boolean)
  : [];

function wantsGuild(guildId) {
  return registerMode === 'all' || (registerMode === 'list' && guildIds.includes(guildId));
}

async function registerInGuild(guild) {
  try {
    await guild.commands.set(commands);
    console.log(`Registered ${commands.length} commands in "${guild.name}" (${guild.id}).`);
  } catch (err) {
    console.error(`Couldn't register commands in "${guild.name}" (${guild.id}): ${err.message}`);
  }
}

async function registerCommands(c) {
  if (registerMode === 'global') {
    await c.application.commands.set(commands);
    console.log(`Registered ${commands.length} global commands (may take up to an hour to show).`);
    // Remove leftover per-server copies from earlier testing so commands don't show up twice.
    for (const guild of c.guilds.cache.values()) {
      const existing = await guild.commands.fetch().catch(() => null);
      if (existing?.size) await guild.commands.set([]).catch(() => {});
    }
    return;
  }

  // Per-server mode: clear global copies so commands don't show up twice.
  await c.application.commands.set([]);

  if (registerMode === 'all') {
    for (const guild of c.guilds.cache.values()) await registerInGuild(guild);
    return;
  }

  for (const id of guildIds) {
    const guild = c.guilds.cache.get(id);
    if (guild) await registerInGuild(guild);
    else console.warn(`GUILD_ID ${id}: the bot isn't in that server yet. Invite it and it'll register automatically.`);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}. In ${c.guilds.cache.size} server(s).`);
  await registerCommands(c);
  await sweepChannels();
  setInterval(sweepChannels, 60 * 1000);
});

// Register right away when the bot is added to a new server (per-server modes only).
client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined "${guild.name}" (${guild.id}).`);
  if (wantsGuild(guild.id)) await registerInGuild(guild);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      if (focused.name === 'run_id') return await interaction.respond(autocompleteRuns(interaction, focused.value));
      if (focused.name === 'clearee') return await interaction.respond(await autocompleteClearee(interaction, focused.value));
      return await interaction.respond(autocompleteZones(focused.value));
    }

    if (interaction.isChatInputCommand()) {
      if (RESTRICTED_COMMANDS.includes(interaction.commandName) && !hasRuleRole(interaction, 'commandRoles')) {
        return await interaction.reply(
          ephemeral(needRoleText(interaction, 'commandRoles', `use \`/${interaction.commandName}\``)),
        );
      }
      switch (interaction.commandName) {
        case 'createrun': return await handleCreateRun(interaction);
        case 'createrun-test': return await handleCreateRun(interaction, { test: true });
        case 'managerun': return await handleManageRun(interaction);
        case 'settimezone': return await handleSetTimezone(interaction);
        default: return;
      }
    }

    if (interaction.isButton()) {
      const [ns, action, messageId, picks, jobs] = interaction.customId.split(':');
      if (ns === 'manage') return await handleManageButton(interaction, action, messageId);
      if (ns !== 'run') return;
      if (action === 'join') return await handleJoin(interaction);
      if (action === 'leave') return await handleLeave(interaction);
      if (action === 'confirm') return await handleConfirm(interaction, messageId, picks, jobs);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const [ns, action, messageId] = interaction.customId.split(':');
      if (ns === 'run' && ['select', 'jobs-tank', 'jobs-melee', 'jobs-opt'].includes(action)) {
        return await handleSelect(interaction, messageId, action);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      const [ns, action, messageId] = interaction.customId.split(':');
      if (ns === 'manage' && action === 'reschedule-submit') return await handleRescheduleSubmit(interaction, messageId);
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const msg = ephemeral('Something went wrong. Make sure I can view this channel and read message history.');
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);
