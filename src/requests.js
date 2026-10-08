// Run requests (/request) waiting on an overseer/admin, plus each server's minimum request amount.
// Requests are keyed by the ID of the message posted in the request channel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'requests.json');

// Decided requests are forgotten after this long.
const KEEP_DECIDED_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   guildId: string,
 *   userId: string,
 *   amount: string,
 *   text: string,
 *   role: string,
 *   jobs: string[],
 *   note: string|null,
 *   ts: number,                 requested start time, unix seconds
 *   zone: string,               requester's timezone when they submitted
 *   status: 'pending'|'approved'|'denied',
 *   decidedAt?: number,
 * }} RunRequest
 */

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    store = {};
  }
  store.requests ??= {};
  store.minAmounts ??= {};
  return store;
}

function save() {
  const cutoff = Date.now() - KEEP_DECIDED_MS;
  for (const [id, req] of Object.entries(store.requests)) {
    if (req.status !== 'pending' && req.decidedAt && req.decidedAt < cutoff) delete store.requests[id];
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

/** @returns {RunRequest|null} */
export function getRequest(messageId) {
  return load().requests[messageId] ?? null;
}

/** @param {RunRequest} request */
export function setRequest(messageId, request) {
  load().requests[messageId] = request;
  save();
}

/** The server's minimum amount as the admin typed it (e.g. "5m"), or null. */
export function getMinAmount(guildId) {
  return load().minAmounts[guildId] ?? null;
}

export function setMinAmount(guildId, amount) {
  const data = load();
  if (amount) data.minAmounts[guildId] = amount;
  else delete data.minAmounts[guildId];
  save();
}

const MULTIPLIERS = { k: 1e3, m: 1e6, b: 1e9 };

/** "5m", "$20", "1,500k", "2.5m gil" -> a number, or null if it isn't a plain amount. */
export function parseAmount(text) {
  const match = String(text).trim().match(/^\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([kmb])?(?:\s*gil)?$/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return value * (MULTIPLIERS[match[2]?.toLowerCase()] ?? 1);
}
