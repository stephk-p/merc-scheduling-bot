// Saved sign-up preferences (roles in order, jobs), keyed by user ID. Kept in memory; written on change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'preferences.json');

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

/** @returns {{ values: string[], jobs: string[] }|null} values = roles in pick order (plus BENCH) */
export function getPreference(userId) {
  return load()[userId] ?? null;
}

export function setPreference(userId, values, jobs) {
  const data = load();
  data[userId] = { ...data[userId], values, jobs };
  save();
}

// Clearing the role preference keeps any saved reminder preference, since they're independent settings.
export function clearPreference(userId) {
  const data = load();
  const existing = data[userId];
  if (!existing) return;
  if (existing.remindMinutes?.length) data[userId] = { remindMinutes: existing.remindMinutes };
  else delete data[userId];
  save();
}

/** @returns {number[]} minutes-before-start the user wants a DM reminder, e.g. [30, 10] */
export function getReminderMinutes(userId) {
  return load()[userId]?.remindMinutes ?? [];
}

export function setReminderMinutes(userId, minutes) {
  const data = load();
  data[userId] = { ...data[userId], remindMinutes: minutes };
  save();
}
