// Recent errors, kept so an admin can pull them up with /errorlog without digging through the console.
// Each entry has the short reference code shown to the person who hit the error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'errors.json');

const MAX_ENTRIES = 200;
const MAX_STACK_CHARS = 4000;

/**
 * @typedef {{
 *   ref: string, at: number, where: string, guildId: string|null, userId: string|null,
 *   name: string, message: string, code: string|number|null, stack: string,
 * }} ErrorEntry
 */

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    store = [];
  }
  return store;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

/** Removes the bot token if it ever ends up in an error message or stack. */
function redact(text) {
  const token = process.env.DISCORD_TOKEN;
  return token ? String(text ?? '').split(token).join('[token]') : String(text ?? '');
}

export const newErrorRef = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** Saves an error. Never throws, since it runs while something else is already going wrong. */
export function recordError({ ref = newErrorRef(), where, guildId = null, userId = null, error }) {
  try {
    const entries = load();
    entries.push({
      ref,
      at: Date.now(),
      where: redact(where),
      guildId,
      userId,
      name: String(error?.name ?? 'Error'),
      message: redact(error?.message ?? error),
      code: error?.code ?? null,
      stack: redact(error?.stack ?? '').slice(0, MAX_STACK_CHARS),
    });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    save();
  } catch (err) {
    console.error('Couldn\'t save the error log entry:', err.message);
  }
  return ref;
}

/** Newest first. `guildId` limits it to one server's errors (omit it for everything). */
export function recentErrors({ guildId = null, limit = 5 } = {}) {
  return load()
    .filter((e) => !guildId || e.guildId === guildId)
    .slice(-limit)
    .reverse();
}

/**
 * Makes every console.error in the bot also land in the error log, so problems that only used to appear
 * in the console (failed follow-up steps, DMs, background sweeps) can be pulled up with /errorlog too.
 * Those entries don't know which server they belong to, so only the bot owner sees them. Messages that
 * already carry a reference code (the ones recorded directly) are skipped to avoid duplicates.
 */
export function captureConsoleErrors() {
  const original = console.error.bind(console);
  let busy = false;
  console.error = (...args) => {
    original(...args);
    if (busy) return;
    busy = true;
    try {
      const first = args[0];
      if (typeof first === 'string' && /^\[[A-Z0-9]{6}\]/.test(first)) return;
      const err = args.find((a) => a instanceof Error);
      const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      recordError({
        where: `console: ${typeof first === 'string' ? first : 'error'}`.slice(0, 200),
        error: err ?? { name: 'Logged error', message: text, stack: '' },
      });
    } finally {
      busy = false;
    }
  };
}

/** One entry by reference code, or null. */
export function findError(ref) {
  const wanted = String(ref).trim().toUpperCase();
  return load().find((e) => e.ref === wanted) ?? null;
}

/** An entry as plain text, ready to paste somewhere. */
export function formatError(e) {
  return [
    `[${e.ref}] ${new Date(e.at).toISOString()}`,
    `Where: ${e.where}`,
    `Server: ${e.guildId ?? 'none'}   User: ${e.userId ?? 'unknown'}`,
    `Error: ${e.name}${e.code != null ? ` (code ${e.code})` : ''}: ${e.message}`,
    'Stack:',
    e.stack || '(none)',
  ].join('\n');
}
