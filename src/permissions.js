// Per-guild command access grants: admin-managed overrides on top of the static rules in
// src/config.js. Lets an admin allow a specific role or member to use a restricted command
// without having to give them one of the server's commandRoles/preferenceRoles.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'permissions.json');

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

function entry(guildId, command) {
  const data = load();
  data[guildId] ??= {};
  data[guildId][command] ??= { roles: [], users: [] };
  return data[guildId][command];
}

/** @returns {{ roles: string[], users: string[] }} */
export function getGrants(guildId, command) {
  const g = load()[guildId]?.[command];
  return { roles: g?.roles ?? [], users: g?.users ?? [] };
}

/** @returns {Record<string, { roles: string[], users: string[] }>} every command with a grant in this server */
export function getGuildGrants(guildId) {
  return load()[guildId] ?? {};
}

export function grantRole(guildId, command, roleId) {
  const e = entry(guildId, command);
  if (!e.roles.includes(roleId)) e.roles.push(roleId);
  save();
}

export function grantUser(guildId, command, userId) {
  const e = entry(guildId, command);
  if (!e.users.includes(userId)) e.users.push(userId);
  save();
}

export function revokeRole(guildId, command, roleId) {
  const e = entry(guildId, command);
  e.roles = e.roles.filter((id) => id !== roleId);
  save();
}

export function revokeUser(guildId, command, userId) {
  const e = entry(guildId, command);
  e.users = e.users.filter((id) => id !== userId);
  save();
}
