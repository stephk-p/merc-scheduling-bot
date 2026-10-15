// Per-run activity history behind the single log message each run gets in the log channel.
// Keyed by Merc Run ID. Entries are kept here in full; the message itself only shows what fits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'runLogs.json');

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;

/** @typedef {{ ts: number, text: string }} Entry */
/** @typedef {{ guildId: string, channelId: string|null, messageId: string|null, entries: Entry[], updatedAt: number }} RunLog */

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
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, log] of Object.entries(store)) {
    if (log.updatedAt < cutoff) delete store[id];
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

/** @returns {RunLog|null} */
export function getRunLog(runId) {
  return load()[runId] ?? null;
}

/** Adds an entry, creating the run's log if it doesn't exist yet. Returns the log. */
export function addLogEntry(runId, guildId, text) {
  const data = load();
  const log = data[runId] ?? { guildId, channelId: null, messageId: null, entries: [], updatedAt: 0 };
  log.entries.push({ ts: Math.floor(Date.now() / 1000), text });
  // The first entry is the creation line, so it's the one never dropped.
  if (log.entries.length > MAX_ENTRIES) log.entries.splice(1, log.entries.length - MAX_ENTRIES);
  log.updatedAt = Date.now();
  data[runId] = log;
  save();
  return log;
}

export function setLogMessage(runId, channelId, messageId) {
  const log = load()[runId];
  if (!log) return;
  log.channelId = channelId;
  log.messageId = messageId;
  save();
}

export function deleteRunLog(runId) {
  if (load()[runId]) {
    delete store[runId];
    save();
  }
}
