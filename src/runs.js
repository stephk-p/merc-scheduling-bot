// Saved sign-up state for each run post, keyed by message ID.
// The post itself is rebuilt from this state on every change. If a run is missing here,
// the bot rebuilds it from the post text instead (see parsePost in roster.js).
import { randomInt } from 'node:crypto';
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
 *   ping?: string,             "@here" or "<@&roleId>", shown on the first line of the post
 *   startsAt: number|null,
 *   signups: import('./roster.js').Signup[],
 *   placed: Record<string,string>,
 *   runId?: string,            6-digit Merc Run ID
 *   showId?: boolean,          show the Merc Run ID on the post (/createrun-test runs)
 *   title?: string,            amount + text, used in lists and channel names
 *   status?: 'open'|'completed'|'failed',
 *   rescheduled?: boolean,
 *   guildId?: string|null,
 *   channelId?: string,        channel the run post is in
 *   privateChannelId?: string|null,
 *   rosterCopyId?: string|null,     copy of the run post in the private channel, kept in sync
 *   channelDeleteAt?: number|null,  ms timestamp when the private channel gets deleted
 *   creatorId?: string,
 *   cleareeId?: string,
 *   cleareeName?: string,      shown instead of an @mention in the public post
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
    if (run.channelDeleteAt) continue; // keep until its private channel has been deleted
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

/** @returns {[string, Run][]} [messageId, run] pairs */
export function allRuns() {
  return Object.entries(load());
}

/** Find a run by its Merc Run ID within a server. */
export function findRunById(guildId, runId) {
  const id = String(runId).trim();
  for (const [messageId, run] of Object.entries(load())) {
    if (run.runId === id && run.guildId === guildId) return { messageId, run };
  }
  return null;
}

/** A random 6-digit Merc Run ID that isn't already in use. */
export function newRunId() {
  const used = new Set(Object.values(load()).map((r) => r.runId).filter(Boolean));
  for (;;) {
    const id = String(randomInt(100000, 1000000));
    if (!used.has(id)) return id;
  }
}
