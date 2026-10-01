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
  DEFAULT_RUN_START_PING,
  RESTRICTED_COMMANDS,
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
const GRANTABLE_COMMANDS = ['createrun', 'managerun', 'runs', 'setpreference'];

const COMMAND_BLURBS = {
  createrun: 'Post a new run and create its private channel',
  managerun: 'Mark a run completed or failed, reschedule it, edit its roster, or delete it',
  runs: 'List current runs and their private channels',
  setpreference: 'Save your usual roles/jobs and choose DM reminder times',
  settimezone: 'Save or change your timezone',
  permissions: 'Grant or revoke who can use restricted commands (admins only)',
  help: 'Show this help message',
};

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
    .addStringOption((o) =>
      o.setName('extra_clearee')
        .setDescription('A second clearee (optional): pick someone from the list, or type any name')
        .setMaxLength(100)
        .setAutocomplete(true))
    .addStringOption((o) =>
      o.setName('extra_role')
        .setDescription("Extra clearee's role slot")
        .addChoices(...ROLES.map((r) => ({ name: r, value: r }))))
    .addStringOption((o) =>
      o.setName('extra_job')
        .setDescription("Extra clearee's job(s). Required if their role is MT/OT/M1/M2")
        .setMaxLength(100)
        .setAutocomplete(true))
    .addStringOption((o) =>
      o.setName('timezone')
        .setDescription('Your timezone (only needed once; it gets remembered)')
        .setAutocomplete(true));
}

const commands = [
  runCommand('createrun', 'Create a run post that people can sign up for'),
  // Disabled for now. Uncomment to bring back /createrun-test (its handler is still below).
  // runCommand('createrun-test', '[Test] Create a run with a Merc Run ID and its own private channel'),
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
    .setName('setpreference')
    .setDescription('Save your usual roles and jobs so Sign up is filled in for you'),
  new SlashCommandBuilder()
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
  const labels = {};
  const key = run.cleareeKey ?? run.cleareeId;
  if (key && run.cleareeName) labels[key] = run.cleareeName;
  if (run.extraCleareeKey && run.extraCleareeName && !run.extraCleareePinged) {
    labels[run.extraCleareeKey] = run.extraCleareeName;
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

  for (const userId of new Set([...userIds].filter(isUserId))) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    const shouldHave = isActiveInGuild(guildId, userId);
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
  return [...new Set([run.creatorId, run.cleareeId, run.extraCleareeId, ...run.signups.map((s) => s.userId)]
    .filter(isUserId))];
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

const NOT_MANAGER = 'Only the person who created this run, or someone with Manage Channels, can manage it.';

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
  if ([run.creatorId, run.cleareeId, run.extraCleareeId].includes(userId)) return;
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
    content: `${mention} Run is starting <t:${run.startsAt}:R>! PF will be up shortly.`,
    allowedMentions,
  });
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
 * DMs the run's creator (privately, nobody else in the channel sees this) when the scheduled time
 * arrives, prompting them to mark it completed/failed or reschedule it. Same manage:complete/fail/
 * reschedule buttons /managerun uses, so clicking them is gated the same way (commandRoles, an
 * admin, or a /permissions grant) — Reschedule just opens that same modal and doesn't change
 * anything until it's submitted. The bot has no way to look up everyone with commandRoles without
 * the privileged Members intent, so this only reaches the creator for now.
 */
async function sendStartPrompt(run, messageId) {
  if (!isUserId(run.creatorId)) return;
  const user = await client.users.fetch(run.creatorId);
  await user.send({
    content: `**${runName(run)}** was scheduled to start <t:${run.startsAt}:R>. ` +
      'Mark it completed or failed, or reschedule it:',
    components: startPromptButtons(messageId),
  });
}

// Role ping and DM reminders for runs starting soon. Runs every minute alongside sweepChannels,
// re-using the same timer instead of one per run, and tracks what's already been sent on the run
// itself so a restart never sends a duplicate.
async function sweepReminders() {
  const now = Date.now();
  for (const [messageId, run] of allRuns()) {
    if (run.status !== 'open' || !run.startsAt) continue;
    const msUntilStart = run.startsAt * 1000 - now;

    // Catches runs that existed before this role was set up, or whose roster hasn't changed since.
    if (ACTIVE_ROSTER_ROLE[run.guildId]) {
      const guild = await client.guilds.fetch(run.guildId).catch(() => null);
      if (guild) await syncActiveRosterRole(run.guildId, guild, run.signups.map((s) => s.userId));
    }

    if (msUntilStart <= 0) {
      if (START_PROMPT_ENABLED[run.guildId] && !run.startPromptSent) {
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

async function handleCreateRun(interaction, { test = false } = {}) {
  const amount = noMassPing(interaction.options.getString('amount', true));
  const text = noMassPing(interaction.options.getString('merc_run_type', true));
  const timeInput = interaction.options.getString('time', true);
  const cleareeInput = interaction.options.getString('clearee', true);
  const role = interaction.options.getString('role', true);
  const jobInput = interaction.options.getString('job', true);
  const extraInput = interaction.options.getString('extra_clearee')?.trim() ?? '';
  const extraRole = interaction.options.getString('extra_role');
  const extraJobInput = interaction.options.getString('extra_job') ?? '';
  const tzInput = interaction.options.getString('timezone');

  if (!interaction.inGuild()) {
    return interaction.reply(ephemeral('This command only works in a server.'));
  }

  const main = checkJobInput(role, jobInput, 'job', true);
  if (main.error) return interaction.reply(ephemeral(main.error));
  const { jobs } = main;

  const hasExtra = Boolean(extraInput || extraRole || extraJobInput.trim());
  let extraJobs = [];
  if (hasExtra) {
    if (!extraInput || !extraRole) {
      return interaction.reply(ephemeral('To add an extra clearee, fill in both **extra_clearee** and **extra_role**.'));
    }
    if (extraRole === role) {
      return interaction.reply(ephemeral(`Both clearees can't have the **${role}** slot. Pick a different **extra_role**.`));
    }
    const extra = checkJobInput(extraRole, extraJobInput, 'extra_job', missingJobs([extraRole], []).length > 0);
    if (extra.error) return interaction.reply(ephemeral(extra.error));
    extraJobs = extra.jobs;
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

  // Clearees don't have to be server members. If the text matches one, they get the slot
  // and are added to the private channel; otherwise the text is just shown as their name.
  const runId = newRunId();
  const clearee = await resolveClearee(interaction.guild, cleareeInput, `clearee-${runId}`);
  const extra = hasExtra ? await resolveClearee(interaction.guild, extraInput, `clearee2-${runId}`) : null;
  if (extra?.member && extra.member.id === clearee.member?.id) {
    return interaction.editReply('The extra clearee is the same person as the clearee. Pick someone else.');
  }
  const cleareeMember = clearee.member;
  const cleareeName = clearee.name;
  const cleareeKey = clearee.key;

  // The extra clearee is @mentioned (and pinged) if they're a member who can see this channel.
  const postChannel = interaction.channel ?? (await client.channels.fetch(interaction.channelId).catch(() => null));
  const pingExtra = Boolean(extra?.member &&
    postChannel?.permissionsFor(extra.member)?.has(PermissionFlagsBits.ViewChannel));
  const extraShown = pingExtra ? `<@${extra.member.id}>` : extra?.name;

  // The main clearee is named, not @mentioned, in the channel the run is posted in.
  const who = cleareeLabel(cleareeName, jobs, role) + (extra ? ` & ${cleareeLabel(extraShown, extraJobs, extraRole)}` : '');
  const header = `${amount} ${text} for ${who} @ <t:${parsed.ts}:f>`;
  const ping = pingFor(interaction.guildId);
  const run = {
    header,
    ping: ping.text,
    title: `${amount} ${text}`,
    startsAt: parsed.ts,
    signups: [
      { userId: cleareeKey, mode: 'firm', roles: [role], jobs },
      ...(extra ? [{ userId: extra.key, mode: 'firm', roles: [extraRole], jobs: extraJobs }] : []),
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
    extraCleareeId: extra?.member?.id ?? null,
    extraCleareeKey: extra?.key ?? null,
    extraCleareeName: extra?.name ?? null,
    extraCleareePinged: pingExtra,
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
    post = await channel.send({
      content: rendered.content,
      components: [runButtons()],
      allowedMentions: { ...ping.allowedMentions, users: pingExtra ? [extra.member.id] : [] },
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
  if (!canPing) {
    done += `\n⚠️ I don't have **Mention @everyone, @here and All Roles** here, so ${ping.text} didn't notify anyone.`;
  }
  if (!cleareeMember) {
    done += `\nNo server member matched "${cleareeName}", so the clearee is shown by name only and wasn't added to the channel.`;
  }
  if (extra && !extra.member) {
    done += `\nNo server member matched "${extra.name}", so the extra clearee is shown by name only and wasn't added to the channel.`;
  } else if (extra && !pingExtra) {
    done += `\n${extra.name} can't see this channel, so they're shown by name instead of pinged. They were still added to the private channel.`;
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
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) available.push('permissions');
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
    return interaction.reply(ephemeral(NOT_MANAGER));
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
    // A completed run with no channel left to clean up is forgotten right away.
    if (status === 'completed' && !run.privateChannelId) deleteRun(messageId);
    else setRun(messageId, run);
    // run.status is no longer 'open', so this only strips the role if no other run grants it.
    await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));

    // The private channel only has the roster copy, which updatePost() already refreshed.
    const deleteAt = run.channelDeleteAt ? Math.floor(run.channelDeleteAt / 1000) : null;
    let reply;
    if (status === 'completed') {
      reply = `Run **${run.runId}** marked as completed and removed from /managerun.` +
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
    return interaction.reply(ephemeral(NOT_MANAGER));
  }

  switch (action) {
    case 'complete':
      return closeRun(interaction, messageId, 'completed');
    case 'fail':
      return closeRun(interaction, messageId, 'failed');
    case 'reschedule':
      return interaction.showModal(rescheduleModal(messageId, run));
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
    return interaction.reply(ephemeral(NOT_MANAGER));
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
    const postExists = await updatePost(messageId, run);
    setRun(messageId, run);
    await syncActiveRosterRole(run.guildId, interaction.guild, run.signups.map((s) => s.userId));

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
    .filter((run) => run.runId && run.guildId === interaction.guildId && run.status !== 'completed' &&
      canManage(interaction, run))
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

async function handleJoin(interaction) {
  if (!hasRuleRole(interaction, 'signupRoles')) {
    return interaction.reply(ephemeral(needRoleText(interaction, 'signupRoles', 'sign up for runs')));
  }
  const post = interaction.message;
  const run = runFromPost(post);
  if (isClosed(run)) return interaction.reply(ephemeral(closedMessage(run)));

  const mine = run.signups.find((s) => s.userId === interaction.user.id);
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
    if (!canManage(interaction, saved)) return interaction.update({ content: NOT_MANAGER, components: [] });
  } else if (!hasRuleRole(interaction, 'signupRoles')) {
    return interaction.update({ content: needRoleText(interaction, 'signupRoles', 'sign up for runs'), components: [] });
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
  const who = targetId ? `<@${targetId}>` : null;
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
    await syncActiveRosterRole(updated.guildId, interaction.guild, signups.map((s) => s.userId));
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
    await syncActiveRosterRole(updated.guildId, interaction.guild, [...signups.map((s) => s.userId), interaction.user.id]);
    await interaction.followUp(ephemeral(`Removed you from the run (you were **${describeSignup(mine)}**).`));
    await syncRosterCopy(updated, rendered.content);
    await removeFromPrivateChannel(updated, interaction.user.id);
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
    new ButtonBuilder().setCustomId(`manage:cancel:${messageId}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
  ));

  const intro = `**Editing the roster for run ${run.runId}.** Add someone (or change their pick) with the ` +
    'first menu, or remove people with the second. Slots, flex moves and the waitlist update like normal sign-ups.';
  const content = [note, intro, '', rosterCopyContent(run, render(run).content)].filter((l, i) => i || l).join('\n');
  return { content: content.slice(0, 2000), components: rows, allowedMentions: { parse: [] } };
}

async function handleEditAdd(interaction, messageId) {
  const run = getRun(messageId);
  if (!run) return interaction.update({ content: 'That run no longer exists.', components: [] });
  if (!canManage(interaction, run)) return interaction.update({ content: NOT_MANAGER, components: [] });

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

async function handleEditConfirm(interaction, messageId, userId, encodedValues, encodedJobs) {
  await interaction.deferUpdate();
  return withLock(messageId, async () => {
    const run = getRun(messageId);
    if (!run) return interaction.editReply({ content: 'That run no longer exists.', components: [] });
    if (!canManage(interaction, run)) return interaction.editReply({ content: NOT_MANAGER, components: [] });

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
    await updatePost(messageId, run);
    setRun(messageId, run);
    await syncActiveRosterRole(run.guildId, interaction.guild, signups.map((s) => s.userId));
    if (isNew) await addToPrivateChannel(run, userId);
    return interaction.editReply(await editPanel(interaction, messageId, run,
      outcomeText(signup, rendered, false, `<@${userId}>`)));
  });
}

async function handleEditRemove(interaction, messageId) {
  await interaction.deferUpdate();
  return withLock(messageId, async () => {
    const run = getRun(messageId);
    if (!run) return interaction.editReply({ content: 'That run no longer exists.', components: [] });
    if (!canManage(interaction, run)) return interaction.editReply({ content: NOT_MANAGER, components: [] });

    const removed = run.signups.filter((s) => interaction.values.includes(s.userId));
    if (!removed.length) {
      return interaction.editReply(await editPanel(interaction, messageId, run, 'Nobody was removed.'));
    }
    run.signups = run.signups.filter((s) => !removed.includes(s));
    await updatePost(messageId, run);
    setRun(messageId, run);
    await syncActiveRosterRole(run.guildId, interaction.guild,
      [...run.signups.map((s) => s.userId), ...removed.map((s) => s.userId)]);
    for (const s of removed) await removeFromPrivateChannel(run, s.userId);

    const labels = labelsFor(run);
    const names = removed.map((s) => labels[s.userId] ?? `<@${s.userId}>`).join(', ');
    return interaction.editReply(await editPanel(interaction, messageId, run, `✅ Removed ${names}.`));
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
      if (focused.name === 'clearee' || focused.name === 'extra_clearee') {
        return await interaction.respond(await autocompleteClearee(interaction, focused.value));
      }
      if (focused.name === 'job') return await interaction.respond(autocompleteJobs(interaction, focused.value, 'role'));
      if (focused.name === 'extra_job') {
        return await interaction.respond(autocompleteJobs(interaction, focused.value, 'extra_role'));
      }
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
        case 'managerun': return await handleManageRun(interaction);
        case 'runs': return await handleListRuns(interaction);
        case 'settimezone': return await handleSetTimezone(interaction);
        case 'setpreference': return await handleSetPreference(interaction);
        case 'help': return await handleHelp(interaction);
        case 'permissions': return await handlePermissions(interaction);
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
          if (!canManage(interaction, run)) return await interaction.update({ content: NOT_MANAGER, components: [] });
          return await interaction.update(await editPanel(interaction, messageId, run));
        }
        return;
      }
      const [ns, action, messageId, picks, jobs] = interaction.customId.split(':');
      if (ns === 'pref') return await handlePrefButton(interaction, action, picks, jobs);
      if (ns === 'manage') return await handleManageButton(interaction, action, messageId);
      if (ns !== 'run') return;
      if (action === 'join') return await handleJoin(interaction);
      if (action === 'leave') return await handleLeave(interaction);
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
