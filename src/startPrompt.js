// Per-guild runtime settings for the "run starting" DM (src/config.js has the code-level default
// for whether it's on). Lets admins flip it on/off and assign a role to also ping, via /startprompt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'startPrompt.json');

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

/** @returns {{ enabled?: boolean, roleId?: string|null }} */
export function getStartPromptSettings(guildId) {
  return load()[guildId] ?? {};
}

export function setStartPromptEnabled(guildId, enabled) {
  const data = load();
  data[guildId] = { ...data[guildId], enabled };
  save();
}

export function setStartPromptRole(guildId, roleId) {
  const data = load();
  data[guildId] = { ...data[guildId], roleId };
  save();
}
