// Saved sign-up state for each run post, keyed by message ID.
// The post itself is rebuilt from this state on every change. If a run is missing here,
// the bot rebuilds it from the post text instead (see parsePost in roster.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'runs.json');

// Runs are forgotten this long after their start time.
const KEEP_AFTER_START_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   header: string,
 *   startsAt: number|null,
 *   signups: import('./roster.js').Signup[],
 *   placed: Record<string,string>,
 * }} Run
 */

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
  const cutoff = Date.now() - KEEP_AFTER_START_MS;
  for (const [id, run] of Object.entries(store)) {
    if (run.startsAt && run.startsAt * 1000 < cutoff) delete store[id];
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

/** @returns {Run|null} */
export function getRun(messageId) {
  return load()[messageId] ?? null;
}

/** @param {Run} run */
export function setRun(messageId, run) {
  load()[messageId] = run;
  save();
}

export function deleteRun(messageId) {
  if (load()[messageId]) {
    delete store[messageId];
    save();
  }
}
