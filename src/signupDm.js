// Settings for the "you're on the roster" DM sent when someone is placed in a run that's at least a
// day away. On by default; each person can turn it off for themselves (/signupdm) and an admin can
// turn it off for a whole server (/signupdmserver).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'signupDm.json');

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    store = {};
  }
  store.users ??= {};
  store.guilds ??= {};
  return store;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

/** Whether this person wants the DM (on unless they turned it off). */
export function userWantsSignupDm(userId) {
  return load().users[userId] !== false;
}

export function setUserSignupDm(userId, enabled) {
  const data = load();
  if (enabled) delete data.users[userId];
  else data.users[userId] = false;
  save();
}

/** Whether the feature is on for this server (on unless an admin turned it off). */
export function guildSignupDmEnabled(guildId) {
  return load().guilds[guildId] !== false;
}

export function setGuildSignupDm(guildId, enabled) {
  const data = load();
  if (enabled) delete data.guilds[guildId];
  else data.guilds[guildId] = false;
  save();
}
