// Roster logic for run posts.
//
// Each sign-up has a mode:
//   firm  - picked exactly one role.
//   flex  - picked two or more roles. Placed in whichever of them works out.
//   bench - picked BENCH (optionally with roles they can cover). Never placed automatically.
//
// Priority is by sign-up order: everyone is placed one at a time, earliest first, and a later
// sign-up can never take a slot away from an earlier one. A later sign-up may *move* an earlier
// flex player to another of that player's roles to make room. So:
//   - A one-role pick takes a flex player's slot only if the flex player can move elsewhere.
//   - If the flex player signed up first and their other roles are all taken, they keep the slot
//     and the one-role user goes on the waitlist for it.
// Anyone who can't be placed is waitlisted, and is placed automatically (in sign-up order) as soon
// as a slot they picked opens up.
//
// Flex players' roles are kept in the order they picked them, and that order is their preference:
// they get the first role on their list that's free, and move back up their list whenever a
// higher choice opens up.

export const ROLES = ['MT', 'OT', 'H1', 'H2', 'M1', 'M2', 'R1', 'R2'];
export const BENCH = 'BENCH';

// Jobs each role can be played as. Tanks (MT/OT) and melee (M1/M2) must pick at least one job;
// for the other roles it's optional.
export const TANK_JOBS = ['GNB', 'DRK', 'PLD', 'WAR'];
export const MELEE_JOBS = ['NIN', 'MNK', 'DRG', 'SAM', 'RPR', 'VPR'];
export const ROLE_JOBS = {
  MT: TANK_JOBS,
  OT: TANK_JOBS,
  H1: ['WHM', 'AST'],
  H2: ['SCH', 'SGE'],
  M1: MELEE_JOBS,
  M2: MELEE_JOBS,
  R1: ['BRD', 'MCH', 'DNC'],
  R2: ['SMN', 'BLM', 'RDM', 'PCT'],
};
export const JOBS = [...new Set(Object.values(ROLE_JOBS).flat())];
export const REQUIRED_JOB_GROUPS = [
  { key: 'tank', label: 'tank', roles: ['MT', 'OT'], jobs: TANK_JOBS },
  { key: 'melee', label: 'melee', roles: ['M1', 'M2'], jobs: MELEE_JOBS },
];
export const OPTIONAL_JOB_ROLES = ['H1', 'H2', 'R1', 'R2'];

/** Every job that can be played in any of these roles. */
export const jobsForRoles = (roles) => JOBS.filter((j) => roles.some((r) => ROLE_JOBS[r]?.includes(j)));

/** Required job groups (tank/melee) that have a role picked but no job picked yet. */
export function missingJobs(roles, jobs = []) {
  return REQUIRED_JOB_GROUPS
    .map((g) => ({ ...g, picked: roles.filter((r) => g.roles.includes(r)) }))
    .filter((g) => g.picked.length && !jobs.some((j) => g.jobs.includes(j)));
}

/** @typedef {{ userId: string, mode: 'firm'|'flex'|'bench', roles: string[], jobs?: string[] }} Signup */

/** Valid roles, without duplicates, in the order given (that order is the user's preference). */
const pickRoles = (roles) => [...new Set(roles)].filter((r) => ROLES.includes(r));
const PROBE = '\0probe';

/**
 * Work out who sits where.
 * @param {Signup[]} signups in sign-up order (earliest first)
 * @param {Record<string,string>} _placed no longer used (preference order decides); kept so
 *   saved runs and callers don't need changing
 */
export function assign(signups, _placed = {}) {
  const players = signups.filter((s) => s.mode !== 'bench' && s.roles.length);
  const bench = signups.filter((s) => s.mode === 'bench');
  const owner = new Map(); // role -> index into players

  // Augmenting-path matching (Kuhn). Each player tries their roles in the order they picked them.
  // Players already holding a slot may be moved to another of their roles (their highest free
  // choice), but never lose their slot. A failed attempt changes nothing.
  const tryAssign = (i, seen) => {
    const order = players[i].roles;
    const free = order.find((r) => !seen.has(r) && !owner.has(r));
    if (free) {
      seen.add(free);
      owner.set(free, i);
      return true;
    }
    for (const r of order) {
      if (seen.has(r)) continue;
      seen.add(r);
      if (tryAssign(owner.get(r), seen)) {
        owner.set(r, i);
        return true;
      }
    }
    return false;
  };

  const waiting = [];
  players.forEach((s, i) => {
    if (!tryAssign(i, new Set())) waiting.push(s);
  });

  const slots = Object.fromEntries(ROLES.map((r) => [r, null]));
  for (const [r, i] of owner) {
    const s = players[i];
    slots[r] = { userId: s.userId, flex: s.mode === 'flex', roles: s.roles, jobs: s.jobs ?? [] };
  }
  return { slots, waiting, bench };
}

/**
 * Status of every role from the point of view of someone signing up now (last in line):
 *   open  - nobody has it
 *   flex  - a flex player has it but can move, so picking only this role takes it
 *   taken - someone who signed up earlier has it and can't move; picking it means waitlist
 */
export function roleStatus(signups, placed = {}) {
  const base = assign(signups, placed);
  const status = {};
  for (const r of ROLES) {
    const slot = base.slots[r];
    if (!slot) status[r] = 'open';
    else if (!slot.flex) status[r] = 'taken';
    else {
      const probe = assign([...signups, { userId: PROBE, mode: 'firm', roles: [r] }], placed);
      status[r] = probe.slots[r]?.userId === PROBE ? 'flex' : 'taken';
    }
  }
  return status;
}

const mention = (id) => `<@${id}>`;

/**
 * Build the post text. Returns the content plus the new `placed` map to save.
 * @param {string} header first line of the post
 * @param {Signup[]} signups
 * @param {Record<string,string>} placed
 * @param {Record<string,string>} labels user ID -> plain text to show instead of an @mention
 */
export function renderRun(header, signups, placed = {}, labels = {}) {
  const who = (id) => labels[id] ?? mention(id);
  const result = assign(signups, placed);
  const status = roleStatus(signups, placed);
  const nextPlaced = {};
  const lines = [header, ''];

  for (const r of ROLES) {
    const slot = result.slots[r];
    if (!slot) {
      lines.push(`${r} - `);
      continue;
    }
    if (slot.flex) nextPlaced[slot.userId] = r;
    // A flex player who can still be moved is tagged so everyone knows the slot may change.
    // Only roles they could still end up in are listed (not ones held by one-role players).
    let tag = '';
    if (slot.flex && status[r] === 'flex') {
      const options = slot.roles.filter((x) => x === r || result.slots[x]?.flex !== false);
      tag = ` (flex: ${options.join('/')})`;
    }
    // Jobs they can play in this slot, e.g. "MT - @user (GNB/DRK)".
    const jobs = slot.jobs.filter((j) => ROLE_JOBS[r].includes(j));
    const jobTag = jobs.length ? ` (${jobs.join('/')})` : '';
    lines.push(`${r} - ${who(slot.userId)}${jobTag}${tag}`);
  }

  const extra = [];
  if (result.waiting.length) {
    extra.push(`Waitlist - ${result.waiting.map((w) => `${who(w.userId)} (${w.roles.join('/')})`).join(', ')}`);
  }
  if (result.bench.length) {
    extra.push(`Bench - ${result.bench
      .map((b) => who(b.userId) + (b.roles.length ? ` (${b.roles.join('/')})` : ''))
      .join(', ')}`);
  }
  if (extra.length) lines.push('', ...extra);

  return { content: lines.join('\n'), placed: nextPlaced, result, status };
}

const SLOT_RE =
  /^(MT|OT|H1|H2|M1|M2|R1|R2) -\s*(?:<@!?(\d+)>)?(?:\s*\(([A-Z]{3}(?:\/[A-Z]{3})*)\))?(?:\s*\(flex: ([A-Z0-9/]+)\))?/;
const ENTRY_RE = /<@!?(\d+)>(?:\s*\(([A-Z0-9/]+)\))?/g;
const parseRoles = (text) => pickRoles((text ?? '').split('/'));

/**
 * Rebuild sign-ups from a post's text. Used when a run has no saved state
 * (posts made before sign-up state was saved, or if data/runs.json was lost).
 * The exact sign-up order can't be recovered, so people already in a slot come first.
 */
export function parsePost(content) {
  const all = content.split('\n');
  // The header is everything before the first blank line (test runs have a "Merc Run ID" line on top).
  const blank = all.indexOf('');
  const headerEnd = blank === -1 ? 1 : blank;
  const header = all.slice(0, headerEnd).join('\n');
  const rest = all.slice(headerEnd);
  const inSlots = [];
  const waiting = [];
  const bench = [];
  const placed = {};

  for (const line of rest) {
    const m = line.match(SLOT_RE);
    if (m) {
      if (!m[2]) continue;
      const jobs = (m[3] ?? '').split('/').filter((j) => JOBS.includes(j));
      const withJobs = jobs.length ? { jobs } : {};
      if (m[4]) {
        inSlots.push({ userId: m[2], mode: 'flex', roles: parseRoles(m[4]), ...withJobs });
        placed[m[2]] = m[1];
      } else {
        inSlots.push({ userId: m[2], mode: 'firm', roles: [m[1]], ...withJobs });
      }
    } else if (line.startsWith('Waitlist - ') || line.startsWith('Flex - ')) {
      for (const e of line.matchAll(ENTRY_RE)) {
        const roles = parseRoles(e[2]);
        waiting.push({ userId: e[1], mode: roles.length > 1 ? 'flex' : 'firm', roles });
      }
    } else if (line.startsWith('Bench - ')) {
      for (const e of line.matchAll(ENTRY_RE)) bench.push({ userId: e[1], mode: 'bench', roles: parseRoles(e[2]) });
    }
  }

  return { header, signups: [...inSlots, ...waiting, ...bench], placed };
}

/**
 * Keep the order someone picked their roles in across menu changes: roles they already had stay
 * where they were, and newly ticked ones go on the end. Unticked roles drop out.
 * @param {string[]} previous selection before this change, in pick order
 * @param {string[]} current values from the menu
 */
export function orderedSelection(previous, current) {
  const kept = previous.filter((v) => current.includes(v));
  return [...new Set([...kept, ...current])];
}

/**
 * Turn select-menu values (e.g. ['R2','H2','BENCH']) and picked jobs into a sign-up.
 * Role order is kept. Jobs are only kept if they fit one of the picked roles.
 */
export function selectionToSignup(userId, values, jobs = []) {
  const roles = pickRoles(values);
  const mode = values.includes(BENCH) ? 'bench' : roles.length === 1 ? 'firm' : 'flex';
  const allowed = jobsForRoles(roles);
  return { userId, mode, roles, jobs: JOBS.filter((j) => allowed.includes(j) && jobs.includes(j)) };
}

/** Picked jobs, e.g. "GNB/DRK/WHM" (empty string if none). */
export const describeJobs = (s) => (s.jobs ?? []).join('/');

/** Where a sign-up ended up: { role } if placed, { waitlist: true } or { bench: true }. */
export function placementOf(signup, rendered) {
  if (signup.mode === 'bench') return { bench: true };
  const role = ROLES.find((r) => rendered.result.slots[r]?.userId === signup.userId);
  return role ? { role, movable: signup.mode === 'flex' && rendered.status[role] === 'flex' } : { waitlist: true };
}

/** Short human description of a sign-up, e.g. "H2", "flex H2/R1/R2", "bench (MT/OT)". */
export function describeSignup(s) {
  if (s.mode === 'firm') return s.roles[0];
  if (s.mode === 'flex') return `flex ${s.roles.join('/')}`;
  return s.roles.length ? `bench (${s.roles.join('/')})` : 'bench';
}
