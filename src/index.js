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
import { ROLES, buildRunContent, findUserSlot, openRoles, parseRoster, setSlot } from './roster.js';
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

function rolePicker(messageId, roles, selected = null) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`run:select:${messageId}`)
    .setPlaceholder('Choose your role')
    .addOptions(roles.map((r) => ({ label: r, value: r, default: r === selected })));

  const confirm = new ButtonBuilder()
    .setCustomId(`run:confirm:${messageId}:${selected ?? ''}`)
    .setLabel(selected ? `Confirm ${selected}` : 'Confirm')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!selected);

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
  await interaction.reply({
    content: setSlot(buildRunContent(header), role, `<@${clearee.id}>`),
    components: [runButtons()],
    allowedMentions: { users: [clearee.id] },
  });
}

async function handleSetTimezone(interaction) {
  const input = interaction.options.getString('timezone', true);
  const zone = resolveZone(input);
  if (!zone) return interaction.reply(ephemeral(`Unknown timezone \`${input}\`. Pick one from the list.`));
  setUserZone(interaction.user.id, zone);
  const now = DateTime.now().setZone(zone).toFormat("ccc, LLL d 'at' h:mm a");
  return interaction.reply(ephemeral(`Timezone saved as **${zone}** (your time now: ${now}).`));
}

async function handleJoin(interaction) {
  const slots = parseRoster(interaction.message.content);
  const current = findUserSlot(slots, interaction.user.id);
  if (current) {
    return interaction.reply(ephemeral(`You're already signed up as **${current}**. Press ❌ Leave first to switch.`));
  }
  const open = openRoles(slots);
  if (!open.length) return interaction.reply(ephemeral('This run is full.'));

  return interaction.reply({
    content: 'Select your role, then press **Confirm**.',
    components: rolePicker(interaction.message.id, open),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSelect(interaction, messageId) {
  const selected = interaction.values[0];
  const roles = interaction.component.options.map((o) => o.value);
  return interaction.update({
    content: `Selected **${selected}**. Press **Confirm** to lock it in.`,
    components: rolePicker(messageId, roles, selected),
  });
}

async function handleConfirm(interaction, messageId, role) {
  return withLock(messageId, async () => {
    const channel = interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId));
    const post = await channel.messages.fetch(messageId);
    const slots = parseRoster(post.content);

    const current = findUserSlot(slots, interaction.user.id);
    if (current) {
      return interaction.update({ content: `You're already signed up as **${current}**.`, components: [] });
    }

    if (slots[role]) {
      const open = openRoles(slots);
      if (!open.length) return interaction.update({ content: 'Sorry, the run just filled up.', components: [] });
      return interaction.update({
        content: `**${role}** was just taken. Pick another role.`,
        components: rolePicker(messageId, open),
      });
    }

    await post.edit({
      content: setSlot(post.content, role, `<@${interaction.user.id}>`),
      allowedMentions: { parse: [] },
    });
    return interaction.update({ content: `✅ You're signed up as **${role}**.`, components: [] });
  });
}

async function handleLeave(interaction) {
  return withLock(interaction.message.id, async () => {
    const post = await interaction.message.fetch();
    const slots = parseRoster(post.content);
    const current = findUserSlot(slots, interaction.user.id);
    if (!current) return interaction.reply(ephemeral("You aren't signed up for this run."));

    await interaction.update({
      content: setSlot(post.content, current, ''),
      allowedMentions: { parse: [] },
    });
    return interaction.followUp(ephemeral(`Removed you from **${current}**.`));
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
      const [ns, action, messageId, role] = interaction.customId.split(':');
      if (ns !== 'run') return;
      if (action === 'join') return await handleJoin(interaction);
      if (action === 'leave') return await handleLeave(interaction);
      if (action === 'confirm') return await handleConfirm(interaction, messageId, role);
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
