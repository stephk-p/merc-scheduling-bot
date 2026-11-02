// Which roles can be given a guaranteed ("prio") slot when a run is created. A server's list is edited
// with /priorole; until it's edited, the default from src/config.js (PRIO_ROLES) applies. A server with
// no list at all allows any member.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIO_ROLES } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'prioRoles.json');

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

/** Role IDs allowed for prio slots in this server. Empty means any member is allowed. */
export function getPrioRoles(guildId) {
  return [...(load()[guildId] ?? PRIO_ROLES[guildId] ?? [])];
}

export function addPrioRole(guildId, roleId) {
  const roles = getPrioRoles(guildId);
  if (!roles.includes(roleId)) roles.push(roleId);
  load()[guildId] = roles;
  save();
}

export function removePrioRole(guildId, roleId) {
  load()[guildId] = getPrioRoles(guildId).filter((id) => id !== roleId);
  save();
}
