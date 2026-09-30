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
  load()[userId] = { values, jobs };
  save();
}

export function clearPreference(userId) {
  if (load()[userId]) {
    delete store[userId];
    save();
  }
}
