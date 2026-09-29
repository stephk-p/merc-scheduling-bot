import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { DateTime } from 'luxon';
import {
  BENCH,
  ROLES,
  describeSignup,
  parsePost,
  placementOf,
  renderRun,
  roleStatus,
  selectionToSignup,
} from './roster.js';
import { deleteRun, getRun, setRun } from './runs.js';
import { parseTime } from './time.js';
import { autocompleteZones, getUserZone, resolveZone, setUserZone } from './timezones.js';

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('createrun')
    .setDescription('Create a run post that people can sign up for')
    .addStringOption((o) =>
      o.setName('amount').setDescription('Amount (e.g. 5m, $20)').setRequired(true).setMaxLength(50))
    .addStringOption((o) =>
      o.setName('text').setDescription('Custom text (e.g. "M4S clear")').setRequired(true).setMaxLength(300))
    .addStringOption((o) =>
      o.setName('time').setDescription('When, in your timezone (e.g. "sept 28 @ 4 PM")').setRequired(true).setMaxLength(100))
    .addUserOption((o) =>
      o.setName('clearee').setDescription('Who the run is for').setRequired(true))
    .addStringOption((o) =>
      o.setName('role')
        .setDescription("Clearee's role slot (they're filled in there automatically)")
        .setRequired(true)
        .addChoices(...ROLES.map((r) => ({ name: r, value: r }))))
    .addStringOption((o) =>
      o.setName('timezone')
        .setDescription('Your timezone (only needed once; it gets remembered)')
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
function runButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('run:join').setLabel('Sign up').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('run:leave').setLabel('Leave').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  );
}

const PICK_HELP =
  '**Pick one role** to lock it in, or **several roles to flex**: you get whichever of them is free, ' +
  'and you move to another if someone picks your slot as their only role.\n' +
  'Whoever signs up first has priority. If your pick is held by someone earlier, you go on the ' +
  '**Waitlist** and are moved in automatically when it opens up.\n' +
  'Add **BENCH** to be a backup instead of taking a slot. You can add the roles you can cover.';

const STATUS_TEXT = {
  open: 'Open',
  flex: 'Held by a flex player who can move. Picking only this takes it.',
  taken: 'Taken. Picking only this puts you on the waitlist.',
};

/**
 * @param {string} messageId run post ID
 * @param {Record<string,string>} status from roleStatus()
 * @param {string[]} selected currently selected values
 * @param {boolean} canConfirm whether the selection is valid
 */
function rolePicker(messageId, status, selected = [], canConfirm = false) {
  const options = [
    ...ROLES.map((r) => ({
      label: r,
      value: r,
      description: STATUS_TEXT[status[r]],
      default: selected.includes(r),
    })),
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

  const confirm = new ButtonBuilder()
    .setCustomId(`run:confirm:${messageId}:${selected.join('.')}`)
    .setLabel(canConfirm ? `Confirm: ${describeSignup(selectionToSignup('', selected))}` : 'Confirm')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!canConfirm);

  return [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(confirm),
  ];
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
// Handlers
// ---------------------------------------------------------------------------
async function handleCreateRun(interaction) {
  const amount = interaction.options.getString('amount', true);
  const text = interaction.options.getString('text', true);
  const timeInput = interaction.options.getString('time', true);
  const clearee = interaction.options.getUser('clearee', true);
  const role = interaction.options.getString('role', true);
  const tzInput = interaction.options.getString('timezone');

  let zone = getUserZone(interaction.user.id);
  if (tzInput) {
    zone = resolveZone(tzInput);
    if (!zone) return interaction.reply(ephemeral(`Unknown timezone \`${tzInput}\`. Pick one from the list.`));
    setUserZone(interaction.user.id, zone);
  }

  const parsed = parseTime(timeInput, zone);
  if (parsed.error) return interaction.reply(ephemeral(parsed.error));

  const header = `${amount} ${text} <t:${parsed.ts}:f> for ${clearee} ${role}`;
  const signups = [{ userId: clearee.id, mode: 'firm', roles: [role] }];
  const rendered = renderRun(header, signups);
  await interaction.reply({
    content: rendered.content,
    components: [runButtons()],
    allowedMentions: { users: [clearee.id] },
  });
  const post = await interaction.fetchReply();
  setRun(post.id, { header, startsAt: parsed.ts, signups, placed: rendered.placed });
}

async function handleSetTimezone(interaction) {
  const input = interaction.options.getString('timezone', true);
  const zone = resolveZone(input);
  if (!zone) return interaction.reply(ephemeral(`Unknown timezone \`${input}\`. Pick one from the list.`));
  setUserZone(interaction.user.id, zone);
  const now = DateTime.now().setZone(zone).toFormat("ccc, LLL d 'at' h:mm a");
  return interaction.reply(ephemeral(`Timezone saved as **${zone}** (your time now: ${now}).`));
}

// ---- Run state helpers ----

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
  return { ...parsed, startsAt: ts ? Number(ts[1]) : null };
}

/** Everyone except this user, plus what the roles look like to them. */
function viewFor(run, userId) {
  const others = run.signups.filter((s) => s.userId !== userId);
  return { others, status: roleStatus(others, run.placed) };
}

const selectionValues = (s) => (s.mode === 'bench' ? [...s.roles, BENCH] : [...s.roles]);

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

// ---- Button / menu handlers ----

async function handleJoin(interaction) {
  const post = interaction.message;
  const run = runFromPost(post);
  const mine = run.signups.find((s) => s.userId === interaction.user.id);
  const { status } = viewFor(run, interaction.user.id);

  const current = mine
    ? `You're signed up as **${describeSignup(mine)}**. Picking again replaces that ` +
      '(and puts you at the back of the line).\n\n'
    : '';

  return interaction.reply({
    content: current + PICK_HELP,
    components: rolePicker(post.id, status, mine ? selectionValues(mine) : []),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSelect(interaction, messageId) {
  const values = interaction.values;
  const post = await fetchPost(interaction, messageId);
  if (!post) {
    deleteRun(messageId);
    return interaction.update({ content: 'That run post no longer exists.', components: [] });
  }

  const run = runFromPost(post);
  const { others, status } = viewFor(run, interaction.user.id);
  const signup = selectionToSignup(interaction.user.id, values);
  const preview = renderRun(run.header, [...others, signup], run.placed);

  return interaction.update({
    content: `${outcomeText(signup, preview, true)}\nPress **Confirm** to sign up as **${describeSignup(signup)}**.`,
    components: rolePicker(messageId, status, values, true),
  });
}

async function handleConfirm(interaction, messageId, encoded) {
  const values = encoded ? encoded.split('.') : [];

  return withLock(messageId, async () => {
    const post = await fetchPost(interaction, messageId);
    if (!post) {
      deleteRun(messageId);
      return interaction.update({ content: 'That run post no longer exists.', components: [] });
    }

    const run = runFromPost(post);
    const others = run.signups.filter((s) => s.userId !== interaction.user.id);
    const signup = selectionToSignup(interaction.user.id, values);
    if (signup.mode !== 'bench' && !signup.roles.length) {
      return interaction.update({ content: 'Pick at least one role, or BENCH.', components: [] });
    }

    // A new or changed pick goes to the back of the line. Anyone who signed up earlier keeps
    // priority, so if the pick is held by an earlier sign-up this user is waitlisted.
    const signups = [...others, signup];
    const rendered = renderRun(run.header, signups, run.placed);
    if (rendered.content.length > 2000) {
      return interaction.update({ content: 'This run post is full and can\'t fit more sign-ups.', components: [] });
    }

    await post.edit({ content: rendered.content, allowedMentions: { parse: [] } });
    setRun(messageId, { ...run, signups, placed: rendered.placed });
    return interaction.update({ content: outcomeText(signup, rendered), components: [] });
  });
}

async function handleLeave(interaction) {
  return withLock(interaction.message.id, async () => {
    const post = await interaction.message.fetch();
    const run = runFromPost(post);
    const mine = run.signups.find((s) => s.userId === interaction.user.id);
    if (!mine) return interaction.reply(ephemeral("You aren't signed up for this run."));

    const signups = run.signups.filter((s) => s !== mine);
    const rendered = renderRun(run.header, signups, run.placed);
    await interaction.update({ content: rendered.content, allowedMentions: { parse: [] } });
    setRun(post.id, { ...run, signups, placed: rendered.placed });
    return interaction.followUp(ephemeral(`Removed you from the run (you were **${describeSignup(mine)}**).`));
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

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}. In ${c.guilds.cache.size} server(s).`);

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
});

// Register right away when the bot is added to a new server (per-server modes only).
client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined "${guild.name}" (${guild.id}).`);
  if (wantsGuild(guild.id)) await registerInGuild(guild);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      return interaction.respond(autocompleteZones(interaction.options.getFocused()));
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'createrun') return await handleCreateRun(interaction);
      if (interaction.commandName === 'settimezone') return await handleSetTimezone(interaction);
      return;
    }

    if (interaction.isButton()) {
      const [ns, action, messageId, picks] = interaction.customId.split(':');
      if (ns !== 'run') return;
      if (action === 'join') return await handleJoin(interaction);
      if (action === 'leave') return await handleLeave(interaction);
      if (action === 'confirm') return await handleConfirm(interaction, messageId, picks);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const [ns, action, messageId] = interaction.customId.split(':');
      if (ns === 'run' && action === 'select') return await handleSelect(interaction, messageId);
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
