// Per-guild log channel for roster activity (sign-ups, leaves, picks changing). Set/cleared via
// /setlogchannel. No channel set means no logging happens for that server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'logChannels.json');

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    store = {};
  }
  return store;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

/** @returns {string|null} */
export function getLogChannel(guildId) {
  return load()[guildId] ?? null;
}

export function setLogChannel(guildId, channelId) {
  const data = load();
  if (channelId) data[guildId] = channelId;
  else delete data[guildId];
  save();
}
