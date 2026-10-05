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
  UserSelectMenuBuilder,
  escapeMarkdown,
} from 'discord.js';
import { DateTime } from 'luxon';
import {
  ACTIVE_ROSTER_ROLE,
  BOT_OWNER_ID,
  DEFAULT_RUN_START_PING,
  PRIVATE_RUN_CHANNEL_ID,
  RESTRICTED_COMMANDS,
  RUN_CHANNEL_CATEGORY,
  RUN_START_PING,
  SERVER_RULES,
  START_PROMPT_ENABLED,
} from './config.js';
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
  parseJobInput,
  parsePost,
  placementOf,
  renderRun,
  roleStatus,
  selectionToSignup,
} from './roster.js';
import { allRuns, deleteRun, findRunById, getRun, newRunId, setRun } from './runs.js';
import { parseTime } from './time.js';
import { autocompleteZones, getUserZone, resolveZone, setUserZone } from './timezones.js';
import {
  clearPreference,
  getPreference,
  getReminderMinutes,
  setPreference,
  setReminderMinutes,
} from './preferences.js';
import {
  getGrants,
  getGuildGrants,
  grantRole,
  grantUser,
  revokeRole,
  revokeUser,
} from './permissions.js';
import { getStartPromptSettings, setStartPromptEnabled, setStartPromptRole } from './startPrompt.js';
import { getLogChannel, setLogChannel } from './logChannels.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// A completed run's private channel is deleted this long after /managerun marks it completed.
const CHANNEL_DELETE_DELAY_MS = 3 * 60 * 60 * 1000;

// DM reminder choices offered in /setpreference.
const REMINDER_OPTIONS = [60, 30, 15, 10, 5];
const reminderLabel = (m) => (m === 60 ? '1 hour before' : `${m} minutes before`);

// Commands an admin can grant/revoke access to for a specific role or member via /permissions,
// on top of the server's normal commandRoles/preferenceRoles.
const GRANTABLE_COMMANDS = ['createrun', 'privaterun', 'adoptrun', 'managerun', 'runs', 'setpreference', 'removeadoptedrun'];

const COMMAND_BLURBS = {
  createrun: 'Post a new run and create its private channel',
  privaterun: 'Like /createrun, but restricted to one channel, and never pings anyone',
  adoptrun: "Attach a Merc Run ID to a manually posted run so the bot can manage it",
  managerun: 'Mark a run completed or failed, reschedule it, edit its roster, or delete it',
  removeadoptedrun: "Stop tracking a run (keeps its channel, permissions and messages untouched)",
  runs: 'List current runs and their private channels',
  setpreference: 'Save your usual roles/jobs and choose DM reminder times',
  settimezone: 'Save or change your timezone',
  permissions: 'Grant or revoke who can use restricted commands (admins only)',
  startprompt: "Configure the run-starting DM, including an optional role to ping (admins only)",
  fixrun: "Repost a missing roster copy in any run's private channel (admins only)",
  setlogchannel: 'Set or clear the channel roster activity gets logged to (admins only)',
  help: 'Show this help message',
};

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------
// Modals support at most 5 text inputs, so that's the most extra clearees a /createrun form can ask for.
const MAX_EXTRA_CLEAREES = 5;

function runCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption((o) =>
      o.setName('amount').setDescription('Amount (e.g. 5m, $20)').setRequired(true).setMaxLength(50))
    .addStringOption((o) =>
      o.setName('merc_run_type').setDescription('Merc run type (e.g. "M4S clear")').setRequired(true).setMaxLength(300))
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
      o.setName('job')
        .setDescription("Clearee's job(s) for that role, e.g. GNB or NIN/SAM")
        .setRequired(true)
        .setMaxLength(100)
        .setAutocomplete(true))
    .addStringOption((o) =>
      o.setName('time').setDescription('When, in your timezone (e.g. "sept 28 @ 4 PM")').setRequired(true).setMaxLength(100))
    .addIntegerOption((o) =>
      o.setName('extra_clearees')
        .setDescription("Extra clearees? Fill in each one's name/role/job in a form after you submit")
        .setMinValue(1)
        .setMaxValue(MAX_EXTRA_CLEAREES))
    .addStringOption((o) =>
      o.setName('timezone')
        .setDescription('Your timezone (only needed once; it gets remembered)')
        .setAutocomplete(true))
    .addStringOption((o) =>
      o.setName('notes')
        .setDescription('Optional note shown on the post (e.g. "no echo", "prog from P4")')
        .setMaxLength(300));
}

const commands = [
  runCommand('createrun', 'Create a run post that people can sign up for'),
  // Disabled for now. Uncomment to bring back /createrun-test (its handler is still below).
  // runCommand('createrun-test', '[Test] Create a run with a Merc Run ID and its own private channel'),
  runCommand('privaterun', 'Like /createrun, but restricted to one channel, and never pings anyone'),
  new SlashCommandBuilder()
    .setName('managerun')
    .setDescription('Mark a run completed or failed, reschedule it, edit its roster, or delete it')
    .addStringOption((o) =>
      o.setName('run_id')
        .setDescription('The 6-digit Merc Run ID')
        .setRequired(true)
        .setMinLength(6)
        .setMaxLength(6)
        .setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('runs')
    .setDescription('List current runs and their private channels'),
  new SlashCommandBuilder()
    .setName('adoptrun')
    .setDescription('Attach a Merc Run ID to a manually posted run so the bot can manage it')
    .addStringOption((o) =>
      o.setName('message_id')
        .setDescription("The run post's message ID (use this command in the same channel as the post)")
        .setRequired(true)
        .setMaxLength(32))
    .addChannelOption((o) =>
      o.setName('private_channel')
        .setDescription('The private channel already made for this run')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addStringOption((o) =>
      o.setName('time')
        .setDescription("Only needed if the post doesn't already have a Discord timestamp")
        .setMaxLength(100)),
  new SlashCommandBuilder()
    .setName('setpreference')
    .setDescription('Save your usual roles and jobs so Sign up is filled in for you'),  new SlashCommandBuilder()
    .setName('settimezone')
    .setDescription('Save your timezone so /createrun understands your times')
    .addStringOption((o) =>
      o.setName('timezone').setDescription('e.g. America/New_York, EST, UTC+8').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to sign up for runs and which commands you can use here'),
  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription("Grant or revoke who can use this server's restricted commands")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) => sc
      .setName('grant')
      .setDescription("Let a role or member use a command, on top of the server's normal rules")
      .addStringOption((o) => o.setName('command').setDescription('Command to grant').setRequired(true)
        .addChoices(...GRANTABLE_COMMANDS.map((c) => ({ name: `/${c}`, value: c }))))
      .addRoleOption((o) => o.setName('role').setDescription('Role to grant (pick this or member)'))
      .addUserOption((o) => o.setName('member').setDescription('Member to grant (pick this or role)')))
    .addSubcommand((sc) => sc
      .setName('revoke')
      .setDescription('Remove a previously granted role or member')
      .addStringOption((o) => o.setName('command').setDescription('Command to revoke').setRequired(true)
        .addChoices(...GRANTABLE_COMMANDS.map((c) => ({ name: `/${c}`, value: c }))))
      .addRoleOption((o) => o.setName('role').setDescription('Role to revoke (pick this or member)'))
      .addUserOption((o) => o.setName('member').setDescription('Member to revoke (pick this or role)')))
    .addSubcommand((sc) => sc
      .setName('list')
      .setDescription('Show every role/member grant in this server')),
  new SlashCommandBuilder()
    .setName('startprompt')
    .setDescription("Configure the DM sent when a run's scheduled time arrives")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) => sc.setName('enable').setDescription('Turn the run-starting DM on for this server'))
    .addSubcommand((sc) => sc.setName('disable').setDescription('Turn the run-starting DM off for this server'))
    .addSubcommand((sc) => sc
      .setName('role')
      .setDescription("Also DM everyone with a role when a run starts (omit to clear it)")
      .addRoleOption((o) => o.setName('role').setDescription('Role to DM (leave blank to clear)'))),
  new SlashCommandBuilder()
    .setName('fixrun')
    .setDescription("Scan every run in this server and repost a missing roster copy in its private channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) =>
      o.setName('run_id')
        .setDescription('Only fix this run (leave blank to check every run)')
        .setMinLength(6)
        .setMaxLength(6)
        .setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('removeadoptedrun')
    .setDescription("Stop tracking a run (keeps its channel, permissions and messages untouched)")
    .addStringOption((o) =>
      o.setName('run_id')
        .setDescription('The 6-digit Merc Run ID')
        .setRequired(true)
        .setMinLength(6)
        .setMaxLength(6)
        .setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('setlogchannel')
    .setDescription('Set (or clear) the channel roster activity gets logged to')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((o) =>
      o.setName('channel')
        .setDescription('Log channel (leave blank to turn logging off)')
        .addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder()
    .setName('botupdate')
    .setDescription("Check GitHub for an update right now, instead of waiting for the daily check")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
    new ButtonBuilder().setCustomId('run:manage').setLabel('Manage Signup').setEmoji('🛠️')
      .setStyle(ButtonStyle.Secondary).setDisabled(disabled),
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
//   run:confirm:<messageId>:<roles>:<jobs>  or  edit:confirm:<messageId>:<userId>:<roles>:<jobs>
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
 * @param {'run'|'edit'} ns 'edit' when a run manager is picking for someone else
 * @param {string} target run post ID, or "<messageId>:<userId>" for 'edit'
 * @param {Record<string,string>} status from roleStatus()
 * @param {string[]} selected currently selected values, in pick order
 * @param {string[]} jobs currently selected jobs
 * @param {boolean} canConfirm whether the selection is valid
 */
function rolePicker(ns, target, status, selected = [], jobs = [], canConfirm = false) {
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
    .setCustomId(`${ns}:select:${target}`)
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
      `${ns}:jobs-${g.key}:${target}`,
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
      `${ns}:jobs-opt:${target}`,
      `Optional: which jobs can you play? (${optRoles.join('/')})`,
      optRoles.flatMap((r) => ROLE_JOBS[r].map((job) => ({ job, forRoles: r }))),
      jobs,
      0,
    ));
  }

  const signup = selectionToSignup('', selected, jobs);
  const confirm = new ButtonBuilder()
    .setCustomId(`${ns}:confirm:${target}:${encodeValues(selected)}:${encodeJobs(signup.jobs)}`)
    .setLabel(canConfirm ? `Confirm: ${describeSignup(signup)}`.slice(0, 80) : 'Confirm')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!canConfirm);

  const confirmRow = new ActionRowBuilder().addComponents(confirm);
  if (ns === 'edit') {
    confirmRow.addComponents(new ButtonBuilder().setCustomId(`edit:panel:${target.split(':')[0]}`)
      .setLabel('Back').setStyle(ButtonStyle.Secondary));
  }
  if (ns === 'pref') {
    confirmRow.addComponents(new ButtonBuilder().setCustomId('pref:clear')
      .setLabel('Clear preference').setStyle(ButtonStyle.Danger));
  }
  rows.push(confirmRow);
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
      new ButtonBuilder().setCustomId(`manage:edit:${messageId}`).setLabel('Edit roster').setEmoji('📝')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`manage:delete:${messageId}`).setLabel('Delete run').setEmoji('🗑️')
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`manage:details:${messageId}`).setLabel('Edit details').setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// Same handlers as /managerun's buttons (manage:complete/fail/reschedule), just a smaller set
// posted automatically when a run's scheduled time arrives.
function startPromptButtons(messageId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`manage:complete:${messageId}`).setLabel('Completed').setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`manage:fail:${messageId}`).setLabel('Failed').setEmoji('❌')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`manage:reschedule:${messageId}`).setLabel('Reschedule').setEmoji('🕒')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

/** Multi-select for DM reminder timing. Saves immediately, no separate confirm step. */
function reminderMenu(selected = []) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('remind:select')
      .setPlaceholder('DM reminders before runs you\'re signed up for')
      .setMinValues(0)
      .setMaxValues(REMINDER_OPTIONS.length)
      .addOptions(REMINDER_OPTIONS.map((m) => ({
        label: reminderLabel(m),
        value: String(m),
        default: selected.includes(m),
      }))),
  );
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

/** Edit amount/merc run type/time without touching the roster. Time is optional (blank keeps it). */
function detailsModal(messageId, run) {
  const { amount, text } = runAmountAndText(run);
  return new ModalBuilder()
    .setCustomId(`manage:details-submit:${messageId}`)
    .setTitle(`Edit run ${run.runId}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Amount')
          .setStyle(TextInputStyle.Short)
          .setValue(amount)
          .setRequired(true)
          .setMaxLength(50),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('merc_run_type')
          .setLabel('Merc run type')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(text)
          .setRequired(true)
          .setMaxLength(300),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('time')
          .setLabel('New time (blank = keep current)')
          .setPlaceholder('e.g. sept 30 @ 8 PM')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
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
  if (run.note) text += `\n**Note:** ${run.note}`;
  return run.ping ? `${run.ping}\n${text}` : text;
}

/** What a new run post pings: the server's ping role if it has one (see config.js), otherwise @here. */
function pingFor(guildId) {
  const roleId = SERVER_RULES[guildId]?.pingRole;
  return roleId
    ? { text: `<@&${roleId}>`, allowedMentions: { roles: [roleId] }, roleId }
    : { text: '@here', allowedMentions: { parse: ['everyone'] }, roleId: null };
}

// The clearee is shown by name in the run post instead of being @mentioned, unless they're a
// member who can see the channel (then they're @mentioned like a normal sign-up). `cleareeKey` is
// the ID used for their roster slot: their user ID, or a placeholder if they aren't a server member.
function labelsFor(run) {
  const labels = { ...run.manualLabels };
  const key = run.cleareeKey ?? run.cleareeId;
  if (key && run.cleareeName && !run.cleareePinged) labels[key] = run.cleareeName;
  for (const extra of run.extraClearees ?? []) {
    if (extra.key && extra.name && !extra.pinged) labels[extra.key] = extra.name;
  }
  return labels;
}

const render = (run, signups = run.signups) =>
  renderRun(displayHeader(run), signups, run.placed, labelsFor(run));

const isUserId = (id) => /^\d{15,21}$/.test(id ?? '');

/** Whether userId currently holds a slot in this run (not bench/waitlisted). */
function isActiveRosterMember(run, userId) {
  const { result } = render(run);
  return ROLES.some((r) => result.slots[r]?.userId === userId);
}

/**
 * Posts a single-line entry to this server's log channel (if one is set via /setlogchannel) for
 * roster activity — signing up, leaving, or changing a pick. Never throws, and does nothing at all
 * if no log channel is configured, so it never adds noise for servers that don't want it.
 */
async function logActivity(guildId, text) {
  const channelId = getLogChannel(guildId);
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`Couldn't post to the log channel for guild ${guildId}:`, err.message);
  }
}

/**
 * Whether userId currently holds a slot in ANY of this guild's open runs. Checking across every
 * run (not just the one that just changed) matters because the role is shared server-wide: being
 * waitlisted in one run must never strip a role earned by being active in a different one.
 */
function isActiveInGuild(guildId, userId) {
  for (const [, other] of allRuns()) {
    if (other.guildId === guildId && other.status === 'open' && isActiveRosterMember(other, userId)) return true;
  }
  return false;
}

/**
 * Keep ACTIVE_ROSTER_ROLE in sync for `userIds` (normally a run's current sign-ups, plus anyone who
 * just left/was removed from it) by checking every open run in the guild, not just one.
 */
async function syncActiveRosterRole(guildId, guild, userIds) {
  const roleId = ACTIVE_ROSTER_ROLE[guildId];
  if (!roleId || !guild) return;
  // Only members who already pass this server's signupRoles rule (e.g. UMAD's "mercs" role) can ever
  // hold the active roster role — a clearee added via /createrun, or anyone picked up from a manually
  // posted run via /adoptrun, never gets it just for holding a slot.
  const requiredRoles = SERVER_RULES[guildId]?.signupRoles;
  const isMerc = (member) => !requiredRoles?.length || requiredRoles.some((id) => member.roles.cache.has(id));

  for (const userId of new Set([...userIds].filter(isUserId))) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    const shouldHave = isActiveInGuild(guildId, userId) && isMerc(member);
    const has = member.roles.cache.has(roleId);
    if (shouldHave && !has) {
      await member.roles.add(roleId).catch((err) =>
        console.error(`Couldn't add the active roster role to ${userId}:`, err.message));
    } else if (!shouldHave && has) {
      await member.roles.remove(roleId).catch((err) =>
        console.error(`Couldn't remove the active roster role from ${userId}:`, err.message));
    }
  }
}

/** Everyone who should be able to see a run's private channel (real Discord users only). */
function channelMembers(run) {
  return [...new Set([
    run.creatorId, run.cleareeId, ...(run.extraClearees ?? []).map((e) => e.id), ...run.signups.map((s) => s.userId),
  ].filter(isUserId))];
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

// Suggests jobs for the role in `roleOption`. Several can be chained with "/", e.g. "GNB/" suggests "GNB/DRK".
function autocompleteJobs(interaction, query, roleOption) {
  const pool = ROLE_JOBS[interaction.options.getString(roleOption)] ?? JOBS;
  const parts = query.toUpperCase().split(/[\s,/]+/);
  const partial = parts.pop();
  const picked = pool.filter((j) => parts.includes(j));
  const values = [
    ...(picked.length && !partial ? [picked.join('/')] : []),
    ...pool.filter((j) => !picked.includes(j) && j.startsWith(partial)).map((j) => [...picked, j].join('/')),
  ];
  return values.slice(0, 25).map((v) => ({ name: v, value: v }));
}

// Stop typed text from pinging @everyone / @here (the run post allows those for its own ping).
const noMassPing = (s) => s.replace(/@(everyone|here)/gi, '@\u200b$1');

/** Short run name used outside the post itself, e.g. "5m M4S clear for StephK". */
const runName = (run) => (run.title && run.cleareeName ? `${run.title} for ${run.cleareeName}` : run.title ?? run.header);

// Runs made before `amount`/`text` were saved separately fall back to splitting the combined title.
function runAmountAndText(run) {
  if (run.amount && run.text) return { amount: run.amount, text: run.text };
  const [amount, ...rest] = (run.title ?? '').split(' ');
  return { amount: amount ?? '', text: rest.join(' ') };
}

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

/**
 * Whether the member can use a restricted command: a server admin, someone passing the server's
 * `commandRoles` rule (if set), or someone granted this specific command via /permissions.
 * Restricted commands (`rule === 'commandRoles'`) default to admin-only when a server hasn't set
 * `commandRoles` at all; other rules (preferenceRoles, signupRoles) stay open by default.
 */
function hasCommandAccess(interaction, command, rule = 'commandRoles') {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;

  const required = SERVER_RULES[interaction.guildId]?.[rule];
  if (required?.length) {
    if (memberRoleIds(interaction.member).some((id) => required.includes(id))) return true;
  } else if (rule !== 'commandRoles') {
    return true;
  }

  const { roles, users } = getGrants(interaction.guildId, command);
  if (users.includes(interaction.user.id)) return true;
  return memberRoleIds(interaction.member).some((id) => roles.includes(id));
}

/** Denial message for a restricted command, whether or not the server has set `commandRoles`. */
function commandAccessDeniedText(interaction, action) {
  const required = SERVER_RULES[interaction.guildId]?.commandRoles;
  const who = required?.length
    ? `members with the ${required.map((id) => `<@&${id}>`).join(' or ')} role, server administrators,`
    : 'server administrators';
  return `Only ${who} or members granted access via \`/permissions\` can ${action}.`;
}

function canManage(interaction, run) {
  if (!hasCommandAccess(interaction, 'managerun')) return false;
  return interaction.user.id === run.creatorId ||
    Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels));
}

/** Explains both halves of canManage(): who can use /managerun here, AND who counts as this run's manager. */
function notManagerText(interaction) {
  const required = SERVER_RULES[interaction.guildId]?.commandRoles;
  const who = required?.length
    ? `members with the ${required.map((id) => `<@&${id}>`).join(' or ')} role, server administrators,`
    : 'server administrators';
  return `Only ${who} or members granted access via \`/permissions\` can use \`/managerun\` here — ` +
    "and even then, only the run's creator or someone with Manage Channels can manage this specific run.";
}

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------
const slug = (s) => s.toLowerCase()
  .replace(/[^\p{L}\p{N}_-]+/gu, '-')
  .replace(/-{2,}/g, '-')
  .replace(/^-+|-+$/g, '');

/** /createrun channel name: amount, text, clearee, weekday and date, e.g. "5m-m4s-clear-stephk-monday-sep-28". */
function dayChannelName(title, cleareeName, date) {
  const zoned = date.setLocale('en-US');
  const day = slug(`${zoned.toFormat('cccc')} ${zoned.toFormat('LLL d')}`);
  const suffix = [slug(cleareeName), day].filter(Boolean).join('-');
  const base = slug(title).slice(0, 98 - suffix.length).replace(/-+$/, '');
  return base ? `${base}-${suffix}` : suffix;
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
  const parent = RUN_CHANNEL_CATEGORY[run.guildId] ?? (inCategory ? interaction.channel.parentId : null);
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent,
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

/**
 * Give a user access to the run's private channel (if it has one). No message is posted. Skipped
 * when the "private channel" is actually the run's own channel (buttonless /adoptrun) — there's no
 * separate private channel to grant access to, and it's not meant to be access-controlled anyway.
 */
async function addToPrivateChannel(run, userId) {
  if (run.privateChannelId === run.channelId) return;
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
  if (run.privateChannelId === run.channelId) return;
  if ([run.creatorId, run.cleareeId, ...(run.extraClearees ?? []).map((e) => e.id)].includes(userId)) return;
  try {
    const channel = await fetchPrivateChannel(run);
    if (!channel) return;
    await channel.permissionOverwrites.delete(userId, `Left merc run ${run.runId}`);
  } catch (err) {
    console.error(`Couldn't remove ${userId} from the channel for run ${run.runId}:`, err.message);
  }
}

/**
 * Re-grants view access to anyone who should see this run's private channel but can't (e.g. their
 * overwrite was removed by hand, or never fully applied). Run periodically, not just on sign-up,
 * since that's the only way to catch access lost outside the bot's own actions.
 */
async function syncChannelAccess(run) {
  if (run.privateChannelId === run.channelId) return;
  const channel = await fetchPrivateChannel(run);
  if (!channel) return;
  for (const userId of channelMembers(run)) {
    const overwrite = channel.permissionOverwrites.cache.get(userId);
    if (overwrite?.allow.has(PermissionFlagsBits.ViewChannel)) continue;
    await channel.permissionOverwrites.edit(
      userId,
      { ViewChannel: true, SendMessages: true, ReadMessageHistory: true },
      { type: OverwriteType.Member, reason: `Re-granting access to merc run ${run.runId}` },
    ).catch((err) =>
      console.error(`Couldn't re-grant ${userId} access to the channel for run ${run.runId}:`, err.message));
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

/**
 * Finds a roster copy the bot already posted but never saved the ID for — runs adopted before
 * roster copies existed, or where posting succeeded but pinning it didn't (missing Manage Messages).
 * Checks pinned messages first (the common case), then falls back to scanning recent history so an
 * unpinned copy is still found instead of getting duplicated. Either way, only a button-less bot
 * message counts — the main run post (with Sign up/Leave/Manage Signup) is never posted here, and
 * the "starting soon" ping is excluded by its wording, so there's no risk of mixing them up.
 */
async function findUntrackedRosterCopy(channel) {
  const isCandidate = (m) => m.author.id === client.user.id && m.components.length === 0 &&
    !m.content.includes('Run is starting');

  const pins = await channel.messages.fetchPins().catch(() => null);
  const pinnedMatch = pins?.items.map((p) => p.message).find(isCandidate);
  if (pinnedMatch) return pinnedMatch;

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  const matches = recent?.filter(isCandidate);
  if (!matches?.size) return null;
  // The roster copy is always the first message the bot posts in the channel, so the oldest match wins.
  return matches.reduce((oldest, m) => (m.createdTimestamp < oldest.createdTimestamp ? m : oldest));
}

/**
 * Update (or create) the roster copy in the private channel to match the run post. Independent of
 * whether the run post itself still exists or could be reposted, so it's kept current either way.
 * Never throws.
 */
async function syncRosterCopy(postId, run, postContent) {
  // Skipped when the "private channel" is the run's own channel (some manually-set-up runs adopted
  // via /adoptrun use the same channel for both) — the run post there already shows the roster.
  if (!run.privateChannelId || run.privateChannelId === run.channelId) return;
  try {
    const channel = await fetchPrivateChannel(run);
    if (!channel) return;
    const content = rosterCopyContent(run, postContent);

    let copy = run.rosterCopyId && (await channel.messages.fetch(run.rosterCopyId).catch(() => null));
    if (!copy) copy = await findUntrackedRosterCopy(channel);

    if (copy) {
      await copy.edit({ content, allowedMentions: { parse: [] } });
    } else {
      copy = await channel.send({ content, allowedMentions: { parse: [] } }).catch((err) => {
        console.error(`Couldn't post the roster copy for run ${run.runId}:`, err.message);
        return null;
      });
      if (copy) await copy.pin('Run roster').catch(() => {}); // needs Manage Messages; fine if it can't
    }

    if (copy && copy.id !== run.rosterCopyId) {
      run.rosterCopyId = copy.id;
      setRun(postId, run);
    }
  } catch (err) {
    console.error(`Couldn't update the roster copy for run ${run.runId}:`, err.message);
  }
}

/**
 * Checks the saved roster copy message still exists and recovers it if not — catches runs adopted
 * before roster copies existed (no ID ever saved) as well as a copy deleted by hand. Skips the full
 * recovery scan whenever the saved message still fetches fine, so this stays cheap to run on a timer.
 * Skipped entirely when the private channel is the same as the run's own channel, since the run
 * post there (with Sign up/Leave/Manage Signup) already serves as the roster — a copy would just
 * be a duplicate.
 */
async function ensureRosterCopy(messageId, run) {
  if (!run.privateChannelId || run.privateChannelId === run.channelId) return;
  const channel = await fetchPrivateChannel(run);
  if (!channel) return;
  if (run.rosterCopyId && (await channel.messages.fetch(run.rosterCopyId).catch(() => null))) return;
  await syncRosterCopy(messageId, run, render(run).content);
}

// Rename a /createrun channel to the new day after a reschedule. Not awaited, because Discord
// only allows 2 renames per channel every 10 minutes and would otherwise hold up the reply.
function renameDayChannel(run, date) {
  fetchPrivateChannel(run)
    .then((channel) => channel?.setName(
      dayChannelName(run.title, run.cleareeName, date),
      `Merc run ${run.runId} rescheduled`,
    ))
    .catch((err) => console.error(`Couldn't rename the channel for run ${run.runId}:`, err.message));
}

/** Posts the "starting soon" ping in a run's private channel, once. roleId null means @here. */
async function sendRolePing(run, roleId) {
  const channel = await client.channels.fetch(run.privateChannelId);
  let mention = roleId ? `<@&${roleId}>` : '@here';
  let allowedMentions = roleId ? { roles: [roleId] } : { parse: ['everyone'] };

  // The active-roster role is shared across every run in the guild, so it can't tell runs apart —
  // someone active in another run (or no longer placed in this one) could get pinged by mistake.
  // Mentioning this run's actual active roster directly avoids that entirely.
  if (ACTIVE_ROSTER_ROLE[run.guildId]) {
    const { result } = render(run);
    const activeIds = ROLES.map((r) => result.slots[r]?.userId).filter(isUserId);
    mention = activeIds.length ? activeIds.map((id) => `<@${id}>`).join(' ') : '@here';
    allowedMentions = activeIds.length ? { users: activeIds } : { parse: ['everyone'] };
  }

  await channel.send({
    content: `${mention} Run is starting <t:${run.startsAt}:R>! PF will be up shortly.\n` +
      'Default **PF Password** should be __***8008***__.',
    allowedMentions,
  });
}

/**
 * Pings @here once in the run's private channel when it's marked completed, never anywhere else.
 * `deleteAt` is the unix-seconds timestamp the channel gets deleted at, shown as a live countdown.
 */
async function sendCompletionAnnouncement(run, deleteAt) {
  try {
    const channel = await fetchPrivateChannel(run);
    if (!channel) return;
    await channel.send({
      content: '@here Congrats! This run has been completed. This channel will be deleted ' +
        `<t:${deleteAt}:R>. Please grab any screenshots you'd like, and good luck in future endeavors!`,
      allowedMentions: { parse: ['everyone'] },
    });
  } catch (err) {
    console.error(`Couldn't post the completion message for run ${run.runId}:`, err.message);
  }
}

/** DMs one user a reminder for a run they're signed up for. */
async function sendDmReminder(run, userId, minutes) {
  const user = await client.users.fetch(userId);
  const link = run.privateChannelId ? `\nChannel: <#${run.privateChannelId}>` : '';
  await user.send(
    `⏰ Reminder: **${runName(run)}** starts <t:${run.startsAt}:R> on <t:${run.startsAt}:F> (${reminderLabel(minutes)}).${link}`,
  );
}

/**
 * DMs the run's creator, plus anyone holding the role assigned for this server (/startprompt
 * role), when the scheduled time arrives — prompting them to mark it completed/failed or
 * reschedule it. Everyone is deduped first, so holding both never means two DMs. Same
 * manage:complete/fail/reschedule buttons /managerun uses, so clicking them is gated the same way
 * (commandRoles, an admin, or a /permissions grant) — Reschedule just opens that same modal and
 * doesn't change anything until it's submitted.
 */
async function sendStartPrompt(run, messageId) {
  const prompt = `**${runName(run)}** was scheduled to start <t:${run.startsAt}:R>. ` +
    'Mark it completed or failed, or reschedule it:';

  const userIds = new Set();
  if (isUserId(run.creatorId)) userIds.add(run.creatorId);

  const roleId = getStartPromptSettings(run.guildId).roleId;
  if (roleId) {
    const guild = await client.guilds.fetch(run.guildId).catch(() => null);
    // Requires the privileged Server Members intent (enabled below and in the Developer Portal);
    // the role's member cache isn't populated without it.
    if (guild) await guild.members.fetch().catch((err) => console.error(`Couldn't fetch members of ${guild.id}:`, err.message));
    const role = guild?.roles.cache.get(roleId);
    for (const member of role?.members.values() ?? []) userIds.add(member.id);
  }

  for (const userId of userIds) {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) continue;
    await user.send({ content: prompt, components: startPromptButtons(messageId) })
      .catch((err) => console.error(`Couldn't DM the start prompt to ${userId}:`, err.message));
  }
}

/** Whether a server has the run-starting DM on: the /startprompt override, else the code default. */
function isStartPromptEnabled(guildId) {
  const override = getStartPromptSettings(guildId).enabled;
  return override ?? Boolean(START_PROMPT_ENABLED[guildId]);
}

/** Whether this role (not a specific member) passes commandRoles or a /permissions grant for `command`. */
function hasRoleCommandAccess(guildId, roleId, command) {
  if (SERVER_RULES[guildId]?.commandRoles?.includes(roleId)) return true;
  return getGrants(guildId, command).roles.includes(roleId);
}

// Role ping and DM reminders for runs starting soon. Runs every minute alongside sweepChannels,
// re-using the same timer instead of one per run, and tracks what's already been sent on the run
// itself so a restart never sends a duplicate.
async function sweepReminders() {
  const now = Date.now();
  for (const [messageId, run] of allRuns()) {
    // Runs independently of status/timing, so access lost by hand is caught even on closed runs.
    if (run.privateChannelId) {
      await syncChannelAccess(run)
        .catch((err) => console.error(`Couldn't sync channel access for run ${run.runId}:`, err.message));
      await ensureRosterCopy(messageId, run)
        .catch((err) => console.error(`Couldn't ensure the roster copy for run ${run.runId}:`, err.message));
    }

    if (run.status !== 'open' || !run.startsAt) continue;
    const msUntilStart = run.startsAt * 1000 - now;

    // Catches runs that existed before this role was set up, or whose roster hasn't changed since.
    if (ACTIVE_ROSTER_ROLE[run.guildId]) {
      const guild = await client.guilds.fetch(run.guildId).catch(() => null);
      if (guild) await syncActiveRosterRole(run.guildId, guild, run.signups.map((s) => s.userId));
    }

    if (msUntilStart <= 0) {
      if (isStartPromptEnabled(run.guildId) && !run.startPromptSent) {
        run.startPromptSent = true;
        setRun(messageId, run);
        await sendStartPrompt(run, messageId)
          .catch((err) => console.error(`Couldn't send the start prompt for run ${run.runId}:`, err.message));
      }
      continue;
    }

    const rolePing = RUN_START_PING[run.guildId] ?? DEFAULT_RUN_START_PING;
    if (run.privateChannelId && !run.rolePingSent &&
        msUntilStart <= rolePing.minutesBefore * 60 * 1000) {
      run.rolePingSent = true;
      setRun(messageId, run);
      await sendRolePing(run, rolePing.roleId)
        .catch((err) => console.error(`Couldn't send the start ping for run ${run.runId}:`, err.message));
    }

    for (const signup of run.signups) {
      const minutes = getReminderMinutes(signup.userId);
      if (!minutes.length || !isActiveRosterMember(run, signup.userId)) continue;
      const sent = run.dmRemindersSent?.[signup.userId] ?? [];
      const due = minutes.filter((m) => !sent.includes(m) && msUntilStart <= m * 60 * 1000);
      if (!due.length) continue;

      run.dmRemindersSent = { ...run.dmRemindersSent, [signup.userId]: [...sent, ...due] };
      setRun(messageId, run);
      for (const m of due) {
        await sendDmReminder(run, signup.userId, m)
          .catch((err) => console.error(`Couldn't DM a reminder to ${signup.userId} for run ${run.runId}:`, err.message));
      }
    }
  }
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
      deleteRun(messageId);
      console.log(`Deleted the private channel for completed run ${run.runId} and forgot the run.`);
    }).catch((err) => console.error(`Couldn't delete the channel for run ${pending.runId}:`, err.message));
  }
}

/** Forget a run whose private channel was deleted (by the bot, by hand, or while the bot was offline). */
function forgetRunForChannel(channelId) {
  for (const [messageId, run] of allRuns()) {
    if (run.privateChannelId !== channelId) continue;
    withLock(messageId, async () => {
      deleteRun(messageId);
      console.log(`The private channel for run ${run.runId} was deleted, so the run was forgotten.`);
    }).catch((err) => console.error(`Couldn't forget run ${run.runId}:`, err.message));
  }
}

// On startup: forget completed runs without a channel, and runs whose channel is already gone.
async function pruneRuns() {
  for (const [messageId, run] of allRuns()) {
    if (!run.privateChannelId) {
      if (run.status === 'completed') deleteRun(messageId);
      continue;
    }
    try {
      await client.channels.fetch(run.privateChannelId);
    } catch (err) {
      if (err.code === 10003) forgetRunForChannel(run.privateChannelId); // Unknown Channel
    }
  }
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------
/** Validate typed jobs for a role. Returns { jobs } or { error }. */
function checkJobInput(role, input, option, required) {
  const { jobs, invalid } = parseJobInput(role, input);
  if (invalid.length) {
    return { error: `Not a ${role} job in **${option}**: **${escapeMarkdown(invalid.join(', '))}**. ` +
      `Pick from ${ROLE_JOBS[role].join('/')}.` };
  }
  if (required && !jobs.length) {
    return { error: `The **${option}** option is required for ${role}. Pick from ${ROLE_JOBS[role].join('/')}.` };
  }
  return { jobs };
}

/** The clearee as a server member if the text matches one, otherwise just the typed name. */
async function resolveClearee(guild, input, fallbackKey) {
  const member = await findClearee(guild, input);
  const name = member
    ? escapeMarkdown(member.displayName)
    : escapeMarkdown(noMassPing(input.trim().replace(/^@/, ''))) || 'clearee';
  return { member, name, key: member?.id ?? fallbackKey };
}

const cleareeLabel = (name, jobs, role) => `${name} ` + (jobs.length ? `(${jobs.join('/')}) - ${role}` : role);

// Pending /createrun submissions waiting on the "extra clearees" modal, keyed by a token embedded in
// the modal's customId (modals can't carry the original options directly). Cleared once submitted, or
// after a few minutes if the form is never filled in.
const pendingCreateRuns = new Map();
const PENDING_CREATE_RUN_TTL_MS = 10 * 60 * 1000;

function stashCreateRunContext(ctx) {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pendingCreateRuns.set(token, ctx);
  setTimeout(() => pendingCreateRuns.delete(token), PENDING_CREATE_RUN_TTL_MS).unref?.();
  return token;
}

/** One text input per extra clearee: "Name, Role, Job(s)" in a single line, since modals are plain text only. */
function extraCleareesModal(token, count) {
  const modal = new ModalBuilder().setCustomId(`createrun:extra-submit:${token}`).setTitle('Extra clearees');
  for (let i = 1; i <= count; i++) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`extra${i}`)
          .setLabel(`Extra clearee ${i}: name, role, job(s)`)
          .setPlaceholder('e.g. Alex, H1, WHM')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
    );
  }
  return modal;
}

async function handleCreateRun(interaction, { test = false, noPing = false, requiredChannelId = null } = {}) {
  const amount = noMassPing(interaction.options.getString('amount', true));
  const text = noMassPing(interaction.options.getString('merc_run_type', true));
  const timeInput = interaction.options.getString('time', true);
  const cleareeInput = interaction.options.getString('clearee', true);
  const role = interaction.options.getString('role', true);
  const jobInput = interaction.options.getString('job', true);
  const noteInput = interaction.options.getString('notes')?.trim();
  const note = noteInput ? noMassPing(noteInput) : null;
  const tzInput = interaction.options.getString('timezone');
  const extraCount = interaction.options.getInteger('extra_clearees') ?? 0;

  if (!interaction.inGuild()) {
    return interaction.reply(ephemeral('This command only works in a server.'));
  }
  if (requiredChannelId && interaction.channelId !== requiredChannelId) {
    return interaction.reply(ephemeral(`This command can only be used in <#${requiredChannelId}>.`));
  }

  const main = checkJobInput(role, jobInput, 'job', true);
  if (main.error) return interaction.reply(ephemeral(main.error));
  const { jobs } = main;

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

  const ctx = { amount, text, cleareeInput, role, jobs, note, parsed, test, noPing, requiredChannelId };

  // A modal must be the interaction's first response, so this can't be deferred first — the heavier
  // work (resolving clearees, creating the channel, posting) happens once the form comes back.
  if (extraCount > 0) {
    const token = stashCreateRunContext(ctx);
    return interaction.showModal(extraCleareesModal(token, extraCount));
  }

  // Reply privately to the creator. The run itself is sent as a normal message so the ping
  // notifies people (mentions added by editing a message don't).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return finishCreateRun(interaction, ctx, []);
}

async function handleCreateRunExtraSubmit(interaction, token) {
  const ctx = pendingCreateRuns.get(token);
  pendingCreateRuns.delete(token);
  if (!ctx) return interaction.reply(ephemeral('That took too long — run `/createrun` again.'));

  const extras = [];
  const usedRoles = new Set([ctx.role]);
  let i = 0;
  for (const field of interaction.fields.fields.values()) {
    i++;
    const [nameRaw, roleRaw, jobRaw = ''] = field.value.split(',').map((s) => s.trim());
    if (!nameRaw || !roleRaw) {
      return interaction.reply(ephemeral(`Extra clearee ${i} needs at least a name and a role, e.g. "Alex, H1, WHM".`));
    }
    const extraRole = roleRaw.toUpperCase();
    if (!ROLES.includes(extraRole)) {
      return interaction.reply(ephemeral(`"${roleRaw}" isn't a role for extra clearee ${i}. Pick from ${ROLES.join('/')}.`));
    }
    if (usedRoles.has(extraRole)) {
      return interaction.reply(ephemeral(`Two clearees can't both have the **${extraRole}** slot.`));
    }
    usedRoles.add(extraRole);
    const check = checkJobInput(extraRole, jobRaw, `extra clearee ${i} job`, missingJobs([extraRole], []).length > 0);
    if (check.error) return interaction.reply(ephemeral(check.error));
    extras.push({ name: noMassPing(nameRaw), role: extraRole, jobs: check.jobs });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return finishCreateRun(interaction, ctx, extras);
}

/**
 * Resolves clearees, creates the private channel and posts the run. `extras` is already-validated
 * `{ name, role, jobs }` entries beyond the main clearee (from the form, or none at all).
 */
async function finishCreateRun(interaction, ctx, extras) {
  const { amount, text, cleareeInput, role, jobs, note, parsed, test, noPing, requiredChannelId } = ctx;
  void requiredChannelId; // already checked in handleCreateRun before this runs

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const postChannel = interaction.channel ?? (await client.channels.fetch(interaction.channelId).catch(() => null));

  // Clearees don't have to be server members. If the text matches one, they get the slot
  // and are added to the private channel; otherwise the text is just shown as their name.
  const runId = newRunId();
  const clearee = await resolveClearee(interaction.guild, cleareeInput, `clearee-${runId}`);
  const resolvedExtras = [];
  for (const [i, extra] of extras.entries()) {
    const resolved = await resolveClearee(interaction.guild, extra.name, `clearee${i + 2}-${runId}`);
    resolvedExtras.push({ ...extra, ...resolved });
  }

  // Nobody can be the clearee for two different slots.
  const memberIds = [clearee, ...resolvedExtras].map((c) => c.member?.id).filter(Boolean);
  if (new Set(memberIds).size !== memberIds.length) {
    return interaction.editReply("The same person can't be the clearee for two different slots. Pick someone else.");
  }

  const cleareeMember = clearee.member;
  const cleareeName = clearee.name;
  const cleareeKey = clearee.key;

  // Each clearee is @mentioned (and pinged) if they're a member who can see this channel.
  const pingMain = Boolean(cleareeMember &&
    postChannel?.permissionsFor(cleareeMember)?.has(PermissionFlagsBits.ViewChannel));
  const cleareeShown = pingMain ? `<@${cleareeMember.id}>` : cleareeName;

  const extraInfo = resolvedExtras.map((extra) => {
    const pinged = Boolean(extra.member && postChannel?.permissionsFor(extra.member)?.has(PermissionFlagsBits.ViewChannel));
    const shown = pinged ? `<@${extra.member.id}>` : extra.name;
    return { ...extra, pinged, shown };
  });

  const who = [cleareeLabel(cleareeShown, jobs, role), ...extraInfo.map((e) => cleareeLabel(e.shown, e.jobs, e.role))]
    .join(' & ');
  const header = `${amount} ${text} for ${who} @ <t:${parsed.ts}:f>`;
  const ping = noPing ? { text: null, allowedMentions: { parse: [] }, roleId: null } : pingFor(interaction.guildId);
  const run = {
    header,
    ping: ping.text,
    title: `${amount} ${text}`,
    amount,
    text,
    note,
    startsAt: parsed.ts,
    signups: [
      { userId: cleareeKey, mode: 'firm', roles: [role], jobs },
      ...extraInfo.map((e) => ({ userId: e.key, mode: 'firm', roles: [e.role], jobs: e.jobs })),
    ],
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
    cleareePinged: pingMain,
    extraClearees: extraInfo.map((e) => ({ id: e.member?.id ?? null, key: e.key, name: e.name, pinged: e.pinged })),
  };

  // /createrun-test: merc-run-<id>. /createrun: amount, text, clearee and day, e.g. 5m-m4s-clear-stephk-sep-28.
  const channelName = test ? `merc-run-${run.runId}` : dayChannelName(run.title, run.cleareeName, parsed.date);
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
    const channel = postChannel ?? (await client.channels.fetch(interaction.channelId));
    const pingedUsers = [
      ...(pingMain ? [cleareeMember.id] : []),
      ...extraInfo.filter((e) => e.pinged).map((e) => e.member.id),
    ];
    post = await channel.send({
      content: rendered.content,
      components: [runButtons()],
      allowedMentions: { ...ping.allowedMentions, users: pingedUsers },
    });
  } catch (err) {
    console.error(`Couldn't post run ${run.runId}:`, err);
    await privateChannel.delete('Run post failed').catch(() => {});
    return interaction.editReply(
      `Couldn't post the run here: ${err.message}\nI need **View Channel** and **Send Messages** in this channel.`,
    );
  }
  setRun(post.id, run);
  await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));

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
  if (!noPing && !canPing) {
    done += `\n⚠️ I don't have **Mention @everyone, @here and All Roles** here, so ${ping.text} didn't notify anyone.`;
  }
  if (!cleareeMember) {
    done += `\nNo server member matched "${cleareeName}", so the clearee is shown by name only and wasn't added to the channel.`;
  } else if (!pingMain) {
    done += `\n${cleareeName} can't see this channel, so they're shown by name instead of pinged. They were still added to the private channel.`;
  }
  for (const e of extraInfo) {
    if (!e.member) {
      done += `\nNo server member matched "${e.name}", so that extra clearee is shown by name only and wasn't added to the channel.`;
    } else if (!e.pinged) {
      done += `\n${e.name} can't see this channel, so they're shown by name instead of pinged. They were still added to the private channel.`;
    }
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

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
async function handleHelp(interaction) {
  const lines = [
    '**Signing up for a run**',
    'Press **Sign up** on a run post, pick one or more roles in the order you\'d take them (add jobs if asked), ' +
      'then press **Confirm**. Picking several roles makes you a flex: you get the first one that\'s free and move ' +
      'up automatically when a better one opens. Press **Leave** to drop out any time.',
    'Use `/setpreference` to save your usual roles/jobs (and pick DM reminder times), and `/settimezone` so run ' +
      "times show correctly for you.",
  ];

  if (interaction.inGuild()) {
    lines.push('', '**Commands you can use here**');
    const available = ['help', 'setpreference', 'settimezone']
      .concat(RESTRICTED_COMMANDS.filter((c) => c !== 'createrun-test'))
      .filter((c) => {
        if (c === 'help' || c === 'settimezone') return true;
        if (c === 'setpreference') return hasCommandAccess(interaction, c, 'preferenceRoles');
        return hasCommandAccess(interaction, c);
      });
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      available.push('permissions', 'startprompt', 'fixrun', 'setlogchannel');
    }
    for (const c of available) lines.push(`• \`/${c}\` \u2014 ${COMMAND_BLURBS[c] ?? ''}`);
  } else {
    lines.push('', 'Run this in a server to see which commands you have access to there.');
  }

  return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// /permissions
// ---------------------------------------------------------------------------
async function handlePermissions(interaction) {
  if (!interaction.inGuild()) return interaction.reply(ephemeral('This command only works in a server.'));
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply(ephemeral('Only server administrators can use `/permissions`.'));
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'list') {
    const grants = getGuildGrants(interaction.guildId);
    const lines = Object.entries(grants)
      .filter(([, g]) => g.roles?.length || g.users?.length)
      .map(([command, g]) => {
        const who = [...(g.roles ?? []).map((id) => `<@&${id}>`), ...(g.users ?? []).map((id) => `<@${id}>`)];
        return `**/${command}**: ${who.join(', ')}`;
      });
    return interaction.reply({
      content: lines.length ? lines.join('\n') : 'No extra grants in this server yet.',
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  }

  const command = interaction.options.getString('command', true);
  const role = interaction.options.getRole('role');
  const member = interaction.options.getUser('member');
  if (!role && !member) return interaction.reply(ephemeral('Pick a **role** or a **member** to grant/revoke.'));
  if (role && member) return interaction.reply(ephemeral('Pick only one: a **role** or a **member**, not both.'));

  if (sub === 'grant') {
    if (role) grantRole(interaction.guildId, command, role.id);
    else grantUser(interaction.guildId, command, member.id);
  } else {
    if (role) revokeRole(interaction.guildId, command, role.id);
    else revokeUser(interaction.guildId, command, member.id);
  }

  const who = role ? `<@&${role.id}>` : `<@${member.id}>`;
  const verb = sub === 'grant' ? 'can now use' : 'no longer has extra access to';
  return interaction.reply({
    content: `✅ ${who} ${verb} \`/${command}\`.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

// ---------------------------------------------------------------------------
// /startprompt
// ---------------------------------------------------------------------------
async function handleStartPrompt(interaction) {
  if (!interaction.inGuild()) return interaction.reply(ephemeral('This command only works in a server.'));
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply(ephemeral('Only server administrators can use `/startprompt`.'));
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'enable') {
    setStartPromptEnabled(interaction.guildId, true);
    return interaction.reply(ephemeral('✅ The run-starting DM is now on for this server.'));
  }
  if (sub === 'disable') {
    setStartPromptEnabled(interaction.guildId, false);
    return interaction.reply(ephemeral('The run-starting DM is now off for this server.'));
  }

  // sub === 'role'
  const role = interaction.options.getRole('role');
  if (!role) {
    setStartPromptRole(interaction.guildId, null);
    return interaction.reply(ephemeral('Cleared. Nobody extra will be DMed for the run-starting prompt anymore.'));
  }

  let note = '';
  if (!hasRoleCommandAccess(interaction.guildId, role.id, 'createrun')) {
    grantRole(interaction.guildId, 'createrun', role.id);
    note = ` I also granted <@&${role.id}> access to \`/createrun\`, since it didn't have it.`;
  }
  setStartPromptRole(interaction.guildId, role.id);
  return interaction.reply({
    content: `✅ Everyone with <@&${role.id}> will also be DMed the run-starting prompt ` +
      `(the creator only gets it once, even if they also have the role).${note}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleSetLogChannel(interaction) {
  if (!interaction.inGuild()) return interaction.reply(ephemeral('This command only works in a server.'));
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply(ephemeral('Only server administrators can use `/setlogchannel`.'));
  }

  const channel = interaction.options.getChannel('channel');
  setLogChannel(interaction.guildId, channel?.id ?? null);
  return interaction.reply(ephemeral(channel
    ? `✅ Roster activity (sign-ups, leaves, picks changing) will now be logged in <#${channel.id}>.`
    : 'Logging turned off for this server.'));
}

/**
 * Asks src/launcher.js (the parent process) to check GitHub for an update right now, instead of
 * waiting for its daily check — same update-and-restart logic, just on demand. Locked to
 * BOT_OWNER_ID regardless of server or admin permissions, since it restarts the whole bot for
 * every server at once. Only works when started via `npm start` (src/launcher.js); running
 * src/index.js directly (`npm run start:bot`) has no parent process to ask.
 */
async function handleBotUpdate(interaction) {
  if (interaction.user.id !== BOT_OWNER_ID) {
    return interaction.reply(ephemeral("Only this bot's owner can use `/botupdate`."));
  }
  if (typeof process.send !== 'function') {
    return interaction.reply(ephemeral(
      "I'm not running under the auto-updater (`src/launcher.js`), so there's no update check to trigger here.",
    ));
  }

  process.send({ type: 'check-update', by: interaction.user.tag });
  return interaction.reply(ephemeral(
    '🔄 Checking GitHub for updates now. If there\'s a new version, I\'ll restart in a few seconds — otherwise nothing changes.',
  ));
}

// Stop looking up a plain-text name against the member list after this many /fixrun runs with no match.
const MAX_MANUAL_ACCESS_ATTEMPTS = 3;

/**
 * For plain-text names picked up from /adoptrun (no @mention), checks whether a real member with a
 * matching name exists. If so, grants them individual access to the private channel and swaps their
 * placeholder sign-up over to their real user ID (so the roster shows an @mention from then on,
 * keeping their place/roles/jobs as-is) — unless they're somehow already signed up under their real
 * ID too, in which case only access is granted. Gives up on an entry (ambiguous name, or nobody
 * matching) after a few attempts instead of searching forever.
 */
async function resolveManualAccess(guild, run) {
  const manualIds = new Set(run.signups.map((s) => s.userId).filter((id) => id.startsWith('manual-')));
  if (!manualIds.size) return { granted: 0, changed: false, rosterChanged: false };

  const attempts = { ...run.manualAccessAttempts };
  let granted = 0;
  let changed = false;
  let rosterChanged = false;

  for (const key of manualIds) {
    if (attempts[key] === 'granted' || (attempts[key] ?? 0) >= MAX_MANUAL_ACCESS_ATTEMPTS) continue;
    const label = run.manualLabels?.[key];
    if (!label) continue;

    const match = await findClearee(guild, label).catch(() => null);
    changed = true;
    if (match && !match.user.bot) {
      await addToPrivateChannel(run, match.id);
      if (!run.signups.some((s) => s.userId === match.id)) {
        for (const s of run.signups) if (s.userId === key) s.userId = match.id;
        if (run.placed[key]) {
          run.placed[match.id] = run.placed[key];
          delete run.placed[key];
        }
        delete run.manualLabels[key];
        rosterChanged = true;
      }
      attempts[key] = 'granted';
      granted++;
    } else {
      attempts[key] = (attempts[key] ?? 0) + 1;
    }
  }

  if (changed) run.manualAccessAttempts = attempts;
  return { granted, changed, rosterChanged };
}

/**
 * Scans every run in this server with a private channel (or just one, if `run_id` is given) and
 * recovers a missing roster copy — never the main run post itself, and never with Sign up/Leave/
 * Manage Signup buttons, since `ensureRosterCopy`/`syncRosterCopy` only ever post into the private
 * channel without components.
 */
async function handleFixRun(interaction) {
  if (!interaction.inGuild()) return interaction.reply(ephemeral('This command only works in a server.'));
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply(ephemeral('Only server administrators can use `/fixrun`.'));
  }

  const runId = interaction.options.getString('run_id')?.trim();
  let targets;
  if (runId) {
    const found = findRunById(interaction.guildId, runId);
    if (!found) return interaction.reply(ephemeral(`No run found with ID **${runId}** in this server.`));
    if (!found.run.privateChannelId) {
      return interaction.reply(ephemeral(`Run **${runId}** doesn't have a private channel to check.`));
    }
    targets = [[found.messageId, found.run]];
  } else {
    targets = allRuns().filter(([, run]) => run.guildId === interaction.guildId && run.privateChannelId);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let fixed = 0;
  let failed = 0;
  let grantedAccess = 0;
  let rosterUpdated = 0;
  for (const [messageId, run] of targets) {
    const hadCopy = Boolean(run.rosterCopyId);
    try {
      await ensureRosterCopy(messageId, run);
      if (!hadCopy && run.rosterCopyId) fixed++;
    } catch (err) {
      failed++;
      console.error(`/fixrun couldn't check run ${run.runId}:`, err.message);
    }

    try {
      const { granted, changed, rosterChanged } = await resolveManualAccess(interaction.guild, run);
      grantedAccess += granted;
      if (rosterChanged) {
        const postId = await updatePost(messageId, run);
        setRun(postId ?? messageId, run);
        await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));
        rosterUpdated++;
      } else if (changed) {
        setRun(messageId, run);
      }
    } catch (err) {
      console.error(`/fixrun couldn't resolve plain-text names for run ${run.runId}:`, err.message);
    }
  }

  const parts = [`Checked ${targets.length} run(s) with a private channel.`];
  parts.push(fixed ? `Posted a missing roster copy for ${fixed} of them.` : 'Every roster copy was already there.');
  if (grantedAccess) parts.push(`Granted channel access to ${grantedAccess} member(s) matched from plain-text names.`);
  if (rosterUpdated) parts.push(`Updated ${rosterUpdated} run roster(s) to @mention a matched member instead.`);
  if (failed) parts.push(`${failed} couldn't be checked — see the console for details.`);
  return interaction.editReply(parts.join(' '));
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
    return interaction.reply(ephemeral(notManagerText(interaction)));
  }

  return interaction.reply({
    content: manageSummary(found.run),
    components: manageButtons(found.messageId, found.run),
    flags: MessageFlags.Ephemeral,
  });
}

// Plain list of runs: full name and private channel link, no post content.
async function handleListRuns(interaction) {
  if (!interaction.inGuild()) return interaction.reply(ephemeral('This command only works in a server.'));

  const runs = allRuns()
    .map(([, run]) => run)
    .filter((run) => run.guildId === interaction.guildId && run.status !== 'completed')
    .sort((a, b) => (a.startsAt ?? 0) - (b.startsAt ?? 0));

  if (!runs.length) return interaction.reply(ephemeral('There are no runs right now.'));

  const lines = runs.map((run) => {
    const channel = run.privateChannelId ? `<#${run.privateChannelId}>` : '_channel deleted_';
    const when = run.startsAt ? ` — <t:${run.startsAt}:F>` : '';
    return `**${runName(run)}**${when} — ${channel}`;
  });
  return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

/**
 * Attaches a Merc Run ID to a run someone posted by hand (not through /createrun), so the bot
 * starts managing it like any other run: DM reminders, the "starting soon"/active-roster role,
 * deleting the private channel on completion, /managerun, all of it. Since the bot can only edit
 * messages it posted itself, it reposts a fresh copy right away and manages that one from then on
 * — the original post is left alone and stops updating. Reuses the same roster parsing already
 * used to recover runs when saved data is lost, so sign-ups, the waitlist and the bench are only
 * picked up if the post used real @mentions, same as the bot's own posts do.
 */
async function handleAdoptRun(interaction) {
  if (!interaction.inGuild()) return interaction.reply(ephemeral('This command only works in a server.'));

  const messageId = interaction.options.getString('message_id', true).trim();
  const privateChannel = interaction.options.getChannel('private_channel', true);
  const timeInput = interaction.options.getString('time')?.trim();

  // Deferred right away: fetching the post, reposting it, granting channel access and syncing the
  // roster copy are all awaited network calls that can easily add up past Discord's 3-second ack window.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.channel ?? (await client.channels.fetch(interaction.channelId).catch(() => null));
  const post = channel && (await channel.messages.fetch(messageId).catch(() => null));
  if (!post) {
    return interaction.editReply(
      `Couldn't find a message with that ID in this channel. Use \`/adoptrun\` in the same channel as the post.`,
    );
  }

  const parsed = parsePost(post.content);
  const tsMatch = parsed.header.match(/<t:(-?\d+)/);
  let startsAt = tsMatch ? Number(tsMatch[1]) : null;
  if (!startsAt) {
    if (!timeInput) {
      return interaction.editReply("That post doesn't have a Discord timestamp, so fill in the `time` option too.");
    }
    const time = parseTime(timeInput, getUserZone(interaction.user.id));
    if (time.error) return interaction.editReply(time.error);
    startsAt = time.ts;
  }

  const runId = newRunId();
  // No separate public channel for this run — posting Sign up/Leave/Manage Signup buttons there would
  // just duplicate the roster the private channel already shows, so this run is managed entirely
  // through /managerun's Edit roster instead.
  const sameChannel = privateChannel.id === post.channelId;
  const run = {
    header: parsed.header,
    ping: null,
    title: parsed.header,
    startsAt,
    signups: parsed.signups,
    placed: parsed.placed,
    manualLabels: parsed.manualLabels,
    buttonless: sameChannel,
    status: 'open',
    runId,
    showId: false,
    guildId: interaction.guildId,
    channelId: post.channelId,
    privateChannelId: privateChannel.id,
    channelDeleteAt: null,
    creatorId: interaction.user.id,
    cleareeId: null,
    cleareeKey: null,
    cleareeName: null,
    extraClearees: [],
  };

  // The bot can only ever edit messages it posted itself, so it reposts a copy to manage from
  // here on — the original stays as-is and stops updating.
  const rendered = render(run);
  run.placed = rendered.placed;
  let newPost;
  try {
    newPost = await channel.send({
      content: rendered.content,
      components: sameChannel ? [] : [runButtons()],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error(`Couldn't repost run ${runId} during adoption:`, err);
    return interaction.editReply(`Couldn't post a copy here: ${err.message}`);
  }

  setRun(newPost.id, run);
  await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));
  // Buttonless runs have no separate private channel to grant access to (addToPrivateChannel already
  // no-ops for them too, but skipping the loop avoids a pointless fetch per sign-up here).
  if (!sameChannel) {
    for (const userId of channelMembers(run)) await addToPrivateChannel(run, userId);
  }

  // Picks up a roster copy the bot already posted in the private channel (e.g. this run was adopted
  // before roster copies existed), or posts a fresh pinned one — same as /createrun. Skipped when the
  // private channel is the same channel the post itself was just reposted in (buttonless, above) —
  // that repost already is the roster there, so a second copy would just be a duplicate.
  if (!sameChannel) await syncRosterCopy(newPost.id, run, rendered.content);

  const manualCount = Object.keys(parsed.manualLabels).length;
  const signupCount = run.signups.length;
  return interaction.editReply({
    content: `✅ Reposted this run as Merc Run ID **${runId}**: ${newPost.url}\n` +
      `Linked to <#${privateChannel.id}>. ` +
      `${signupCount ? `Picked up ${signupCount} sign-up(s) from the original post. ` :
        'Found no sign-ups in the original post. '}` +
      `${manualCount ? `${manualCount} of them had no @mention, so they're shown by name for now — replace them ` +
        "with a real member any time using `/managerun`'s Edit roster. " : ''}` +
      `${sameChannel ? 'Since the private channel is the same as the post\'s channel, this repost has no Sign up/' +
        "Leave buttons — manage sign-ups entirely with `/managerun`'s Edit roster. " : ''}` +
      `The original post won't update anymore since I can only edit messages I posted myself — feel free to delete it. ` +
      `Use \`/managerun run_id:${runId}\` to manage the new one from here on.`,
    allowedMentions: { parse: [] },
  });
}

/**
 * The reverse of /adoptrun: forgets a run's Merc Run ID and saved roster so the bot stops managing
 * it, without touching the run post, the private channel, its messages, or anyone's access to it.
 */
async function handleRemoveAdoptedRun(interaction) {
  if (!interaction.inGuild()) return interaction.reply(ephemeral('This command only works in a server.'));

  const runId = interaction.options.getString('run_id', true).trim();
  const found = findRunById(interaction.guildId, runId);
  if (!found) return interaction.reply(ephemeral(`No run found with ID **${runId}** in this server.`));
  if (!canManage(interaction, found.run)) return interaction.reply(ephemeral(notManagerText(interaction)));

  return interaction.reply({
    content: `Stop tracking run **${runId}**? This removes its Merc Run ID and saved roster from the bot only — ` +
      "no more /managerun, reminders, or pings for it. The run post, private channel, its messages and everyone's " +
      "access are all left exactly as they are, and can't be recovered by the bot afterward.",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rmadopt:yes:${found.messageId}`).setLabel('Yes, stop tracking it')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`rmadopt:cancel:${found.messageId}`).setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleRemoveAdoptedRunButton(interaction, action, messageId) {
  if (action === 'cancel') return interaction.update({ content: 'Cancelled.', components: [] });

  const run = getRun(messageId);
  if (!run) return interaction.update({ content: "That run isn't tracked anymore.", components: [] });
  if (!canManage(interaction, run)) return interaction.update({ content: notManagerText(interaction), components: [] });

  deleteRun(messageId);
  // Only strips the active-roster role if no other run grants it; nothing else about the channel changes.
  await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));
  return interaction.update({
    content: `✅ Run **${run.runId}** is no longer tracked. Its post, private channel, messages and everyone's ` +
      'access were left untouched.',
    components: [],
  });
}

// ---------------------------------------------------------------------------
// /managerun actions
// ---------------------------------------------------------------------------

/**
 * Re-renders the run post. If it's gone (deleted by hand, or from an old /adoptrun before the bot
 * could only edit its own messages), reposts a fresh copy in the same channel and moves the run
 * under that new message ID so it keeps working. Returns the ID to keep using from here on, or
 * null if even reposting failed (e.g. the channel itself is gone).
 */
async function updatePost(messageId, run) {
  const channel = await client.channels.fetch(run.channelId).catch(() => null);

  const rendered = render(run);
  run.placed = rendered.placed;
  const content = rendered.content;
  // A run adopted into its own "private channel" (no separate public post) never gets Sign up/Leave/
  // Manage Signup buttons there — it's managed entirely through /managerun's Edit roster instead.
  const components = run.buttonless ? [] : [runButtons(isClosed(run))];

  const post = channel && (await channel.messages.fetch(messageId).catch(() => null));
  if (post) {
    await post.edit({ content, components, allowedMentions: { parse: [] } });
    await syncRosterCopy(messageId, run, content);
    return messageId;
  }

  const fresh = channel && (await channel.send({ content, components, allowedMentions: { parse: [] } }).catch((err) => {
    console.error(`Couldn't repost the missing post for run ${run.runId}:`, err.message);
    return null;
  }));
  if (!fresh) {
    // The private channel's roster copy is tracked independently of the main post, so it can still
    // be kept current even when the main post is gone and couldn't be reposted (or its channel is gone too).
    await syncRosterCopy(messageId, run, content);
    return null;
  }

  deleteRun(messageId);
  setRun(fresh.id, run);
  await syncRosterCopy(fresh.id, run, content);
  return fresh.id;
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
    const postId = await updatePost(messageId, run);
    // A completed run with no channel left to clean up is forgotten right away.
    if (status === 'completed' && !run.privateChannelId) deleteRun(postId ?? messageId);
    else setRun(postId ?? messageId, run);
    // run.status is no longer 'open', so this only strips the role if no other run grants it.
    await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));

    // The private channel only has the roster copy, which updatePost() already refreshed.
    const deleteAt = run.channelDeleteAt ? Math.floor(run.channelDeleteAt / 1000) : null;
    if (deleteAt) await sendCompletionAnnouncement(run, deleteAt);
    let reply;
    if (status === 'completed') {
      reply = `Run **${run.runId}** marked as completed and removed from /managerun.` +
        (deleteAt ? ` Its private channel will be deleted <t:${deleteAt}:R>.` : '');
    } else {
      reply = `Run **${run.runId}** marked as failed. Sign-ups are closed until it's rescheduled.`;
    }
    if (!postId) reply += "\n(The run post was deleted and a fresh copy couldn't be posted — only the saved record was updated.)";
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
    // Deleted first, so this only strips the role if no other run grants it.
    await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));

    // If /managerun was used inside the private channel, that channel is gone now, so this can fail.
    return interaction.editReply({ content: `Run **${run.runId}** deleted.`, components: [] }).catch(() => {});
  });
}

async function handleManageButton(interaction, action, messageId) {
  const run = getRun(messageId);
  if (!run) return interaction.update({ content: 'That run no longer exists.', components: [] });
  if (!canManage(interaction, run)) {
    return interaction.reply(ephemeral(notManagerText(interaction)));
  }

  switch (action) {
    case 'complete':
      return closeRun(interaction, messageId, 'completed');
    case 'fail':
      return closeRun(interaction, messageId, 'failed');
    case 'reschedule':
      return interaction.showModal(rescheduleModal(messageId, run));
    case 'details':
      return interaction.showModal(detailsModal(messageId, run));
    case 'edit':
      return interaction.update(await editPanel(interaction, messageId, run));
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
    return interaction.reply(ephemeral(notManagerText(interaction)));
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
    run.rolePingSent = false;
    run.dmRemindersSent = {};
    run.startPromptSent = false;
    const postId = await updatePost(messageId, run);
    setRun(postId ?? messageId, run);
    await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));

    if (!showsRunId(run) && run.privateChannelId) renameDayChannel(run, parsed.date);

    let reply = `Run **${run.runId}** rescheduled to <t:${parsed.ts}:F>. Sign-ups are open again.`;
    if (!run.privateChannelId) reply += '\n(Its private channel was already deleted.)';
    if (!postId) reply += "\n(The run post was deleted and a fresh copy couldn't be posted — only the saved record was updated.)";
    return interaction.editReply({ content: reply, components: [] });
  });
}

/** Edit amount/merc run type/time without touching the roster, status or private channel members. */
async function handleDetailsSubmit(interaction, messageId) {
  const existing = getRun(messageId);
  if (!existing) return interaction.reply(ephemeral('That run no longer exists.'));
  if (!canManage(interaction, existing)) {
    return interaction.reply(ephemeral(notManagerText(interaction)));
  }

  const amount = noMassPing(interaction.fields.getTextInputValue('amount').trim());
  const text = noMassPing(interaction.fields.getTextInputValue('merc_run_type').trim());
  if (!amount || !text) return interaction.reply(ephemeral('Amount and merc run type can\'t be empty.'));

  const timeInput = interaction.fields.getTextInputValue('time').trim();
  let parsed = null;
  if (timeInput) {
    parsed = parseTime(timeInput, getUserZone(interaction.user.id));
    if (parsed.error) return interaction.reply(ephemeral(parsed.error));
  }

  if (interaction.isFromMessage()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  return withLock(messageId, async () => {
    const run = getRun(messageId);
    if (!run) return interaction.editReply({ content: 'That run no longer exists.', components: [] });

    // The header is "<title> for <who> @ <t:...>"; keep everything after the old title as-is.
    const oldTitle = run.title ?? '';
    const newTitle = `${amount} ${text}`;
    const titleChanged = newTitle !== oldTitle;
    let newHeader = `${newTitle}${run.header.slice(oldTitle.length)}`;

    if (parsed) {
      const stamp = `<t:${parsed.ts}:f>`;
      newHeader = /<t:-?\d+(?::[tTdDfFR])?>/.test(newHeader)
        ? newHeader.replace(/<t:-?\d+(?::[tTdDfFR])?>/, stamp)
        : `${newHeader} ${stamp}`;
      run.startsAt = parsed.ts;
      run.rolePingSent = false;
      run.dmRemindersSent = {};
      run.startPromptSent = false;
    }

    run.amount = amount;
    run.text = text;
    run.title = newTitle;
    run.header = newHeader;

    const postId = await updatePost(messageId, run);
    setRun(postId ?? messageId, run);
    if (parsed) await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));

    if ((titleChanged || parsed) && !showsRunId(run) && run.privateChannelId) {
      const date = parsed?.date ?? DateTime.fromSeconds(run.startsAt, { zone: getUserZone(interaction.user.id) ?? 'UTC' });
      renameDayChannel(run, date);
    }

    let reply = `Run **${run.runId}** updated.`;
    if (parsed) reply += ` New time: <t:${parsed.ts}:F>.`;
    if (!postId) reply += "\n(The run post was deleted and a fresh copy couldn't be posted — only the saved record was updated.)";
    return interaction.editReply({ content: reply, components: [] });
  });
}

function autocompleteRuns(interaction, query) {
  const q = query.trim().toLowerCase();
  const zone = getUserZone(interaction.user.id) ?? 'UTC';
  // /fixrun is admin-only (checked by Discord via setDefaultMemberPermissions) and can target a
  // completed run whose private channel hasn't been deleted yet, so it skips the /managerun-only filters.
  // /removeadoptedrun shares that same "completed run, channel still around" case, but still requires
  // being able to manage the run.
  const isFixRun = interaction.commandName === 'fixrun';
  const skipStatusFilter = isFixRun || interaction.commandName === 'removeadoptedrun';
  return allRuns()
    .map(([, run]) => run)
    .filter((run) => run.runId && run.guildId === interaction.guildId &&
      (isFixRun || canManage(interaction, run)) &&
      (skipStatusFilter || run.status !== 'completed'))
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
      if (/^(run|edit|pref):confirm:/.test(c.customId ?? '')) {
        const [values, jobs] = c.customId.split(':').slice(-2);
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

/** What happened (or, with preview, what would happen) to a sign-up. `who` names someone else. */
function outcomeText(signup, rendered, preview = false, who = null) {
  const p = placementOf(signup, rendered);
  const you = who
    ? (preview ? `${who} will be` : `✅ ${who} is`)
    : (preview ? "You'll be" : "✅ You're");
  const [they, their] = who ? ['they', 'their'] : ['you', 'your'];
  if (p.bench) {
    return signup.roles.length
      ? `${you} on the bench as a backup for **${signup.roles.join('/')}**.`
      : `${you} on the bench.`;
  }
  if (p.waitlist) {
    const held = signup.roles.length === 1
      ? `**${signup.roles[0]}** is held by someone who signed up earlier`
      : `**${signup.roles.join('/')}** are all held by people who signed up earlier`;
    return `${you} on the **Waitlist**: ${held}. ${they === 'you' ? 'You' : 'They'}'ll be moved in ` +
      'automatically if a slot opens up.';
  }
  if (p.movable) {
    return `${you} in **${p.role}** for now. If someone picks ${p.role} as their only role, ` +
      `${they}'ll move to another of ${their} roles.`;
  }
  return `${you} in **${p.role}**.`;
}

/**
 * The "Manage Signup" button: a dedicated entry point for people already on the roster to adjust
 * their own pick, bypassing signupRoles (membership itself is the authorization) — meant for cases
 * like a clearee who isn't in signupRoles but is still part of the run. Does nothing at all for
 * anyone not already signed up, rather than showing an error.
 */
async function handleManageSignup(interaction) {
  const run = runFromPost(interaction.message);
  const mine = run.signups.find((s) => s.userId === interaction.user.id);
  if (!mine) return interaction.deferUpdate();

  if (isClosed(run)) return interaction.reply(ephemeral(closedMessage(run)));

  const { status } = viewFor(run, interaction.user.id);
  const current = `You're signed up as **${describeSignup(mine)}**` +
    (mine.jobs?.length ? ` (${describeJobs(mine)})` : '') +
    '. Picking again replaces that (and puts you at the back of the line).\n\n';

  return interaction.reply({
    content: current + PICK_HELP,
    components: rolePicker('run', interaction.message.id, status, selectionValues(mine), mine.jobs ?? [],
      checkSelection(mine).ok),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleJoin(interaction) {
  const post = interaction.message;
  const run = runFromPost(post);
  const mine = run.signups.find((s) => s.userId === interaction.user.id);
  // signupRoles only restricts new sign-ups; anyone already on the roster can always manage their own pick.
  if (!mine && !hasRuleRole(interaction, 'signupRoles')) {
    return interaction.reply(ephemeral(needRoleText(interaction, 'signupRoles', 'sign up for runs')));
  }
  if (isClosed(run)) return interaction.reply(ephemeral(closedMessage(run)));

  const { others, status } = viewFor(run, interaction.user.id);

  // Not signed up yet: fill the picker in from their saved preference so one click on Confirm signs them up.
  const pref = !mine && getPreference(interaction.user.id);
  if (pref) {
    const signup = selectionToSignup(interaction.user.id, pref.values, pref.jobs);
    const check = checkSelection(signup);
    const lines = [
      `Filled in from your saved preference: **${describeSignup(signup)}**` +
        (signup.jobs.length ? ` (${describeJobs(signup)})` : '') + '.',
      outcomeText(signup, render(run, [...others, signup]), true),
      check.ok ? 'Press **Confirm** to sign up, or change your pick below first.' : check.problems.join('\n'),
    ];
    return interaction.reply({
      content: lines.join('\n'),
      components: rolePicker('run', post.id, status, pref.values, signup.jobs, check.ok),
      flags: MessageFlags.Ephemeral,
    });
  }

  const current = mine
    ? `You're signed up as **${describeSignup(mine)}**` +
      (mine.jobs?.length ? ` (${describeJobs(mine)})` : '') +
      '. Picking again replaces that (and puts you at the back of the line).\n\n'
    : '';

  return interaction.reply({
    content: current + PICK_HELP,
    components: rolePicker('run', post.id, status, mine ? selectionValues(mine) : [], mine?.jobs ?? []),
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * The picker's full selection after one menu changed. Discord only sends the values of the menu
 * that changed, so the rest comes from the Confirm button. It also doesn't say which order roles
 * were ticked in, so the order from the last update is kept and newly ticked roles go on the end.
 */
function nextPicks(interaction, kind) {
  const prev = previousPicks(interaction.message);
  if (kind === 'select') return { values: orderedSelection(prev.values, interaction.values), jobs: prev.jobs };
  const menuJobs = kind === 'jobs-tank' ? TANK_JOBS
    : kind === 'jobs-melee' ? MELEE_JOBS
      : jobsForRoles(prev.values.filter((r) => OPTIONAL_JOB_ROLES.includes(r)));
  return { values: prev.values, jobs: [...prev.jobs.filter((j) => !menuJobs.includes(j)), ...interaction.values] };
}

/** `targetId` is set when a run manager is editing someone else's pick from /managerun. */
async function handleSelect(interaction, messageId, kind, targetId = null) {
  if (targetId) {
    const saved = getRun(messageId);
    if (!saved) return interaction.update({ content: 'That run no longer exists.', components: [] });
    if (!canManage(interaction, saved)) return interaction.update({ content: notManagerText(interaction), components: [] });
  }
  const { values, jobs } = nextPicks(interaction, kind);

  let run = targetId ? getRun(messageId) : null;
  if (!run) {
    const post = await fetchPost(interaction, messageId);
    if (!post) {
      deleteRun(messageId);
      return interaction.update({ content: 'That run post no longer exists.', components: [] });
    }
    run = runFromPost(post);
    if (isClosed(run)) return interaction.update({ content: closedMessage(run), components: [] });
  }

  const userId = targetId ?? interaction.user.id;
  // signupRoles only restricts new sign-ups; anyone already on the roster can always manage their own pick.
  if (!targetId && !run.signups.some((s) => s.userId === userId) && !hasRuleRole(interaction, 'signupRoles')) {
    return interaction.update({ content: needRoleText(interaction, 'signupRoles', 'sign up for runs'), components: [] });
  }
  const who = targetId ? (labelsFor(run)[targetId] ?? `<@${targetId}>`) : null;
  const { others, status } = viewFor(run, userId);
  const signup = selectionToSignup(userId, values, jobs);
  const preview = render(run, [...others, signup]);
  const check = checkSelection(signup);

  const lines = [outcomeText(signup, preview, true, who)];
  if (signup.jobs.length) lines.push(`Jobs: **${describeJobs(signup)}**`);
  if (check.ok) {
    lines.push(who
      ? `Press **Confirm** to save ${who} as **${describeSignup(signup)}**.`
      : `Press **Confirm** to sign up as **${describeSignup(signup)}**.`);
  } else {
    lines.push(...check.problems);
  }

  return interaction.update({
    content: lines.join('\n'),
    components: targetId
      ? rolePicker('edit', `${messageId}:${targetId}`, status, values, signup.jobs, check.ok)
      : rolePicker('run', messageId, status, values, signup.jobs, check.ok),
    allowedMentions: { parse: [] },
  });
}

async function handleConfirm(interaction, messageId, encodedValues, encodedJobs) {
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
    // signupRoles only restricts new sign-ups; anyone already on the roster can always manage their own pick.
    if (isNew && !hasRuleRole(interaction, 'signupRoles')) {
      return interaction.update({ content: needRoleText(interaction, 'signupRoles', 'sign up for runs'), components: [] });
    }
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
    await syncActiveRosterRole(updated.guildId, interaction.guild, signups.map((s) => s.userId));
    await interaction.update({
      content: outcomeText(signup, rendered) + (signup.jobs.length ? `\nJobs: **${describeJobs(signup)}**` : ''),
      components: [],
    });
    await syncRosterCopy(messageId, updated, rendered.content);
    if (isNew) await addToPrivateChannel(updated, userId);
    await logActivity(updated.guildId, isNew
      ? `✅ <@${userId}> signed up for **${updated.runId} · ${updated.title}** as **${describeSignup(signup)}**.`
      : `✏️ <@${userId}> changed their pick for **${updated.runId} · ${updated.title}** to **${describeSignup(signup)}**.`);
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
    await syncActiveRosterRole(updated.guildId, interaction.guild, [...signups.map((s) => s.userId), interaction.user.id]);
    await interaction.followUp(ephemeral(`Removed you from the run (you were **${describeSignup(mine)}**).`));
    await syncRosterCopy(post.id, updated, rendered.content);
    await removeFromPrivateChannel(updated, interaction.user.id);
    await logActivity(updated.guildId,
      `❌ <@${interaction.user.id}> left **${updated.runId} · ${updated.title}** (was **${describeSignup(mine)}**).`);
  });
}

// ---------------------------------------------------------------------------
// /managerun: Edit roster
// ---------------------------------------------------------------------------
async function editPanel(interaction, messageId, run, note = '') {
  const labels = labelsFor(run);
  const ids = run.signups.map((s) => s.userId).filter((id) => !labels[id] && isUserId(id));
  const members = ids.length ? await interaction.guild.members.fetch({ user: ids }).catch(() => null) : null;
  const nameOf = (id) => labels[id] ?? members?.get(id)?.displayName ?? id;

  const rows = [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId(`edit:add:${messageId}`)
        .setPlaceholder("Add someone, or change someone's pick"),
    ),
  ];
  if (run.signups.length) {
    const options = run.signups.slice(0, 25).map((s) => ({
      label: nameOf(s.userId).slice(0, 100),
      value: s.userId,
      description: (describeSignup(s) + (s.jobs?.length ? ` (${describeJobs(s)})` : '')).slice(0, 100),
    }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`edit:remove:${messageId}`)
        .setPlaceholder('Remove people from the roster')
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`edit:addname:${messageId}`).setLabel('Add by name').setEmoji('⌨️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`manage:cancel:${messageId}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
  ));

  const intro = `**Editing the roster for run ${run.runId}.** Add someone (or change their pick) with the ` +
    'first menu, or remove people with the second. Slots, flex moves and the waitlist update like normal sign-ups.';
  const content = [note, intro, '', rosterCopyContent(run, render(run).content)].filter((l, i) => i || l).join('\n');
  return { content: content.slice(0, 2000), components: rows, allowedMentions: { parse: [] } };
}

function addByNameModal(messageId) {
  return new ModalBuilder()
    .setCustomId(`edit:addname-submit:${messageId}`)
    .setTitle('Add to roster by name')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('name')
          .setLabel('Name (matches a server member if one exists)')
          .setPlaceholder('A Discord mention/username, or just type any name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
    );
}

async function handleEditAdd(interaction, messageId) {
  const run = getRun(messageId);
  if (!run) return interaction.update({ content: 'That run no longer exists.', components: [] });
  if (!canManage(interaction, run)) return interaction.update({ content: notManagerText(interaction), components: [] });

  const userId = interaction.values[0];
  if (interaction.users.get(userId)?.bot) {
    return interaction.update(await editPanel(interaction, messageId, run, "⚠️ Bots can't be added to the roster."));
  }
  const mine = run.signups.find((s) => s.userId === userId);
  const { status } = viewFor(run, userId);
  const intro = mine
    ? `<@${userId}> is signed up as **${describeSignup(mine)}**` +
      (mine.jobs?.length ? ` (${describeJobs(mine)})` : '') +
      '. Saving a new pick replaces that and puts them at the back of the line.'
    : `Pick the role(s) and jobs for <@${userId}>.`;
  return interaction.update({
    content: intro,
    components: rolePicker('edit', `${messageId}:${userId}`, status,
      mine ? selectionValues(mine) : [], mine?.jobs ?? [], mine ? checkSelection(mine).ok : false),
    allowedMentions: { parse: [] },
  });
}

/** Same as handleEditAdd, but for a typed name instead of a picked Discord user. */
async function handleAddByNameSubmit(interaction, messageId) {
  const run = getRun(messageId);
  if (!run) return interaction.reply(ephemeral('That run no longer exists.'));
  if (!canManage(interaction, run)) return interaction.reply(ephemeral(notManagerText(interaction)));

  const input = interaction.fields.getTextInputValue('name').trim();
  if (!input) return interaction.reply(ephemeral('Type a name first.'));

  const member = await findClearee(interaction.guild, input);
  if (member?.user.bot) return interaction.reply(ephemeral("Bots can't be added to the roster."));

  // A real member uses their user ID like normal; otherwise a placeholder key with a saved label.
  const userId = member?.id ?? `manual-${Math.random().toString(36).slice(2, 8)}`;
  if (!member && !run.signups.some((s) => s.userId === userId)) {
    run.manualLabels = { ...run.manualLabels, [userId]: escapeMarkdown(noMassPing(input)) };
    setRun(messageId, run);
  }

  const mine = run.signups.find((s) => s.userId === userId);
  const { status } = viewFor(run, userId);
  const label = member ? `<@${userId}>` : run.manualLabels[userId];

  if (interaction.isFromMessage()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const intro = mine
    ? `${label} is signed up as **${describeSignup(mine)}**` +
      (mine.jobs?.length ? ` (${describeJobs(mine)})` : '') +
      '. Saving a new pick replaces that and puts them at the back of the line.'
    : `Pick the role(s) and jobs for ${label}.`;

  return interaction.editReply({
    content: intro,
    components: rolePicker('edit', `${messageId}:${userId}`, status,
      mine ? selectionValues(mine) : [], mine?.jobs ?? [], mine ? checkSelection(mine).ok : false),
    allowedMentions: { parse: [] },
  });
}

async function handleEditConfirm(interaction, messageId, userId, encodedValues, encodedJobs) {
  await interaction.deferUpdate();
  return withLock(messageId, async () => {
    const run = getRun(messageId);
    if (!run) return interaction.editReply({ content: 'That run no longer exists.', components: [] });
    if (!canManage(interaction, run)) return interaction.editReply({ content: notManagerText(interaction), components: [] });

    const signup = selectionToSignup(userId, decodeValues(encodedValues), decodeJobs(encodedJobs));
    const check = checkSelection(signup);
    if (!check.ok) return interaction.editReply({ content: check.problems.join('\n'), components: [] });

    // Same as a normal sign-up: a new or changed pick goes to the back of the line.
    const isNew = !run.signups.some((s) => s.userId === userId);
    const signups = [...run.signups.filter((s) => s.userId !== userId), signup];
    const rendered = render(run, signups);
    if (rendered.content.length > 2000) {
      return interaction.editReply(await editPanel(interaction, messageId, run,
        "⚠️ This run post is full and can't fit more sign-ups."));
    }

    run.signups = signups;
    const postId = await updatePost(messageId, run);
    const finalId = postId ?? messageId;
    setRun(finalId, run);
    await syncActiveRosterRole(run.guildId, interaction.guild, signups.map((s) => s.userId));
    if (isNew && isUserId(userId)) await addToPrivateChannel(run, userId);
    const who = labelsFor(run)[userId] ?? `<@${userId}>`;
    await logActivity(run.guildId, `${isNew ? '✅' : '✏️'} ${interaction.user} ${isNew ? 'added' : 'updated'} ` +
      `${who} on **${run.runId} · ${run.title}** as **${describeSignup(signup)}** via Edit roster.`);
    return interaction.editReply(await editPanel(interaction, finalId, run,
      outcomeText(signup, rendered, false, who)));
  });
}

async function handleEditRemove(interaction, messageId) {
  await interaction.deferUpdate();
  return withLock(messageId, async () => {
    const run = getRun(messageId);
    if (!run) return interaction.editReply({ content: 'That run no longer exists.', components: [] });
    if (!canManage(interaction, run)) return interaction.editReply({ content: notManagerText(interaction), components: [] });

    const removed = run.signups.filter((s) => interaction.values.includes(s.userId));
    if (!removed.length) {
      return interaction.editReply(await editPanel(interaction, messageId, run, 'Nobody was removed.'));
    }
    run.signups = run.signups.filter((s) => !removed.includes(s));
    const postId = await updatePost(messageId, run);
    const finalId = postId ?? messageId;
    setRun(finalId, run);
    await syncActiveRosterRole(run.guildId, interaction.guild,
      [...run.signups.map((s) => s.userId), ...removed.map((s) => s.userId)]);
    for (const s of removed) {
      if (isUserId(s.userId)) await removeFromPrivateChannel(run, s.userId);
    }

    const labels = labelsFor(run);
    const names = removed.map((s) => labels[s.userId] ?? `<@${s.userId}>`).join(', ');
    await logActivity(run.guildId,
      `❌ ${interaction.user} removed ${names} from **${run.runId} · ${run.title}** via Edit roster.`);
    return interaction.editReply(await editPanel(interaction, finalId, run, `✅ Removed ${names}.`));
  });
}

// ---------------------------------------------------------------------------
// /setpreference
// ---------------------------------------------------------------------------
const PREF_HELP =
  'Pick the roles you usually sign up for, **in order of preference**, and your jobs. ' +
  'Next time you press **Sign up** on a run, the menu is filled in with this so you only have to press Confirm ' +
  '(you can still change it before confirming).';

function prefView(userId, values, jobs) {
  const signup = selectionToSignup(userId, values, jobs);
  const check = checkSelection(signup);
  const lines = [PREF_HELP, ''];
  if (values.length) {
    lines.push(`Preference: **${describeSignup(signup)}**` + (signup.jobs.length ? ` (${describeJobs(signup)})` : ''));
  }
  if (check.ok) lines.push('Press **Confirm** to save it.');
  else if (values.length) lines.push(...check.problems);
  return { content: lines.join('\n'), components: rolePicker('pref', 'me', {}, values, signup.jobs, check.ok) };
}

async function handleSetPreference(interaction) {
  if (!hasCommandAccess(interaction, 'setpreference', 'preferenceRoles')) {
    return interaction.reply(ephemeral(needRoleText(interaction, 'preferenceRoles', 'use `/setpreference`')));
  }
  const saved = getPreference(interaction.user.id);
  await interaction.reply({
    ...prefView(interaction.user.id, saved?.values ?? [], saved?.jobs ?? []),
    flags: MessageFlags.Ephemeral,
  });
  await interaction.followUp({
    content: "Want a DM before runs you're signed up for start? Pick one or more times (or clear to turn it off).",
    components: [reminderMenu(getReminderMinutes(interaction.user.id))],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleReminderSelect(interaction) {
  const minutes = interaction.values.map(Number).sort((a, b) => b - a);
  setReminderMinutes(interaction.user.id, minutes);
  return interaction.update({
    content: minutes.length
      ? `✅ You'll get a DM ${minutes.map(reminderLabel).join(' and ')} before runs you're signed up for.`
      : 'DM reminders are off.',
    components: [reminderMenu(minutes)],
  });
}

async function handlePrefSelect(interaction, kind) {
  const { values, jobs } = nextPicks(interaction, kind);
  return interaction.update(prefView(interaction.user.id, values, jobs));
}

async function handlePrefButton(interaction, action, encodedValues, encodedJobs) {
  if (action === 'clear') {
    clearPreference(interaction.user.id);
    return interaction.update({ content: 'Your preference was cleared.', components: [] });
  }
  const signup = selectionToSignup(interaction.user.id, decodeValues(encodedValues), decodeJobs(encodedJobs));
  if (!checkSelection(signup).ok) return interaction.update(prefView(interaction.user.id, [], []));
  setPreference(interaction.user.id, selectionValues(signup), signup.jobs);
  return interaction.update({
    content: `✅ Preference saved: **${describeSignup(signup)}**` +
      (signup.jobs.length ? ` (${describeJobs(signup)})` : '') +
      '. Press **Sign up** on any run and it will be filled in for you.',
    components: [],
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
// Requires the privileged "Server Members Intent" to also be turned on for this bot in the
// Discord Developer Portal (Bot tab), or /startprompt's role option won't be able to find members.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

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
  await pruneRuns();
  await sweepReminders();
  setInterval(sweepChannels, 60 * 1000);
  setInterval(() => sweepReminders().catch((err) => console.error('sweepReminders failed:', err.message)), 60 * 1000);
});

client.on(Events.ChannelDelete, (channel) => forgetRunForChannel(channel.id));

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
      if (focused.name === 'clearee') {
        return await interaction.respond(await autocompleteClearee(interaction, focused.value));
      }
      if (focused.name === 'job') return await interaction.respond(autocompleteJobs(interaction, focused.value, 'role'));
      return await interaction.respond(autocompleteZones(focused.value));
    }

    if (interaction.isChatInputCommand()) {
      if (RESTRICTED_COMMANDS.includes(interaction.commandName) &&
          !hasCommandAccess(interaction, interaction.commandName)) {
        return await interaction.reply(
          ephemeral(commandAccessDeniedText(interaction, `use \`/${interaction.commandName}\``)),
        );
      }
      switch (interaction.commandName) {
        case 'createrun': return await handleCreateRun(interaction);
        case 'createrun-test': return await handleCreateRun(interaction, { test: true });
        case 'privaterun':
          return await handleCreateRun(interaction, { noPing: true, requiredChannelId: PRIVATE_RUN_CHANNEL_ID });
        case 'adoptrun': return await handleAdoptRun(interaction);
        case 'managerun': return await handleManageRun(interaction);
        case 'removeadoptedrun': return await handleRemoveAdoptedRun(interaction);
        case 'runs': return await handleListRuns(interaction);
        case 'settimezone': return await handleSetTimezone(interaction);
        case 'setpreference': return await handleSetPreference(interaction);
        case 'help': return await handleHelp(interaction);
        case 'permissions': return await handlePermissions(interaction);
        case 'startprompt': return await handleStartPrompt(interaction);
        case 'fixrun': return await handleFixRun(interaction);
        case 'setlogchannel': return await handleSetLogChannel(interaction);
        case 'botupdate': return await handleBotUpdate(interaction);
        default: return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('edit:')) {
        const [, action, messageId, userId, picks, jobs] = interaction.customId.split(':');
        if (action === 'confirm') return await handleEditConfirm(interaction, messageId, userId, picks, jobs);
        if (action === 'panel') {
          const run = getRun(messageId);
          if (!run) return await interaction.update({ content: 'That run no longer exists.', components: [] });
          if (!canManage(interaction, run)) return await interaction.update({ content: notManagerText(interaction), components: [] });
          return await interaction.update(await editPanel(interaction, messageId, run));
        }
        if (action === 'addname') {
          const run = getRun(messageId);
          if (!run) return await interaction.update({ content: 'That run no longer exists.', components: [] });
          if (!canManage(interaction, run)) return await interaction.update({ content: notManagerText(interaction), components: [] });
          return await interaction.showModal(addByNameModal(messageId));
        }
        return;
      }
      const [ns, action, messageId, picks, jobs] = interaction.customId.split(':');
      if (ns === 'pref') return await handlePrefButton(interaction, action, picks, jobs);
      if (ns === 'manage') return await handleManageButton(interaction, action, messageId);
      if (ns === 'rmadopt') return await handleRemoveAdoptedRunButton(interaction, action, messageId);
      if (ns !== 'run') return;
      if (action === 'join') return await handleJoin(interaction);
      if (action === 'leave') return await handleLeave(interaction);
      if (action === 'manage') return await handleManageSignup(interaction);
      if (action === 'confirm') return await handleConfirm(interaction, messageId, picks, jobs);
      return;
    }

    if (interaction.isUserSelectMenu()) {
      const [ns, action, messageId] = interaction.customId.split(':');
      if (ns === 'edit' && action === 'add') return await handleEditAdd(interaction, messageId);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const [ns, action, messageId, userId] = interaction.customId.split(':');
      if (ns === 'edit' && action === 'remove') return await handleEditRemove(interaction, messageId);
      if (ns === 'edit' && ['select', 'jobs-tank', 'jobs-melee', 'jobs-opt'].includes(action)) {
        return await handleSelect(interaction, messageId, action, userId);
      }
      if (ns === 'pref' && ['select', 'jobs-tank', 'jobs-melee', 'jobs-opt'].includes(action)) {
        return await handlePrefSelect(interaction, action);
      }
      if (ns === 'run' && ['select', 'jobs-tank', 'jobs-melee', 'jobs-opt'].includes(action)) {
        return await handleSelect(interaction, messageId, action);
      }
      if (ns === 'remind' && action === 'select') return await handleReminderSelect(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      const [ns, action, messageId] = interaction.customId.split(':');
      if (ns === 'manage' && action === 'reschedule-submit') return await handleRescheduleSubmit(interaction, messageId);
      if (ns === 'manage' && action === 'details-submit') return await handleDetailsSubmit(interaction, messageId);
      if (ns === 'edit' && action === 'addname-submit') return await handleAddByNameSubmit(interaction, messageId);
      if (ns === 'createrun' && action === 'extra-submit') return await handleCreateRunExtraSubmit(interaction, messageId);
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
