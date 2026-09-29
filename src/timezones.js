import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'timezones.json');

// Common abbreviations -> IANA zones (DST is handled automatically by the IANA zone).
const ALIASES = {
  EST: 'America/New_York', EDT: 'America/New_York', ET: 'America/New_York',
  CST: 'America/Chicago', CDT: 'America/Chicago', CT: 'America/Chicago',
  MST: 'America/Denver', MDT: 'America/Denver',
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  UTC: 'UTC', GMT: 'UTC',
  BST: 'Europe/London',
  CET: 'Europe/Paris', CEST: 'Europe/Paris',
  EET: 'Europe/Athens', EEST: 'Europe/Athens',
  IST: 'Asia/Kolkata',
  SGT: 'Asia/Singapore', PHT: 'Asia/Manila',
  JST: 'Asia/Tokyo', KST: 'Asia/Seoul',
  AWST: 'Australia/Perth',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
  NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland',
};

const POPULAR = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Athens',
  'Asia/Manila', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland',
];

const ALL_ZONES = [...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])];

/** Resolve user input (IANA name, abbreviation, or "UTC+5") to a valid luxon zone name, or null. */
export function resolveZone(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const alias = ALIASES[trimmed.toUpperCase()];
  if (alias) return alias;

  const exact = ALL_ZONES.find((z) => z.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;

  // Offsets like "UTC+5", "UTC-4:30", "GMT+8"
  const offset = trimmed.match(/^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (offset) {
    const [, sign, h, m] = offset;
    const zone = `UTC${sign}${Number(h)}${m && m !== '00' ? `:${m}` : ''}`;
    if (DateTime.now().setZone(zone).isValid) return zone;
  }
  return null;
}

function label(zone) {
  const now = DateTime.now().setZone(zone);
  return `${zone} (UTC${now.toFormat('ZZ')}, now ${now.toFormat('h:mm a')})`;
}

/** Up to 25 autocomplete choices for a partial timezone query. */
export function autocompleteZones(query) {
  const q = (query || '').trim().toLowerCase();
  let matches;
  if (!q) {
    matches = POPULAR;
  } else {
    const alias = ALIASES[q.toUpperCase()];
    const found = ALL_ZONES.filter((z) => z.toLowerCase().includes(q.replace(/\s+/g, '_')));
    matches = [...new Set([...(alias ? [alias] : []), ...found])];
    const offsetZone = resolveZone(query);
    if (offsetZone && !matches.includes(offsetZone)) matches.unshift(offsetZone);
  }
  return matches.slice(0, 25).map((z) => ({ name: label(z).slice(0, 100), value: z }));
}

// ---- Per-user timezone storage ----
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

export function getUserZone(userId) {
  return load()[userId] ?? null;
}

export function setUserZone(userId, zone) {
  load()[userId] = zone;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}
