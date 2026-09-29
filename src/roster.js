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
// as a slot they picked opens up. Flex players stay in their current slot when possible, so the
// roster doesn't jump around.

export const ROLES = ['MT', 'OT', 'H1', 'H2', 'M1', 'M2', 'R1', 'R2'];
export const BENCH = 'BENCH';

/** @typedef {{ userId: string, mode: 'firm'|'flex'|'bench', roles: string[] }} Signup */

const sortRoles = (roles) => ROLES.filter((r) => roles.includes(r));
const PROBE = '\0probe';

/**
 * Work out who sits where.
 * @param {Signup[]} signups in sign-up order (earliest first)
 * @param {Record<string,string>} placed flex player -> role they held last time (for stability)
 */
export function assign(signups, placed = {}) {
  const players = signups.filter((s) => s.mode !== 'bench' && s.roles.length);
  const bench = signups.filter((s) => s.mode === 'bench');
  const owner = new Map(); // role -> index into players

  const preferred = (i) => {
    const { roles, userId } = players[i];
    const prev = placed[userId];
    return roles.includes(prev) ? [prev, ...roles.filter((r) => r !== prev)] : roles;
  };

  // Augmenting-path matching (Kuhn). Players already holding a slot may be moved to another of
  // their roles, but never lose their slot. A failed attempt changes nothing.
  const tryAssign = (i, seen) => {
    const order = preferred(i);
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
    slots[r] = { userId: s.userId, flex: s.mode === 'flex', roles: s.roles };
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
 */
export function renderRun(header, signups, placed = {}) {
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
    lines.push(`${r} - ${mention(slot.userId)}${tag}`);
  }

  const extra = [];
  if (result.waiting.length) {
    extra.push(`Waitlist - ${result.waiting.map((w) => `${mention(w.userId)} (${w.roles.join('/')})`).join(', ')}`);
  }
  if (result.bench.length) {
    extra.push(`Bench - ${result.bench
      .map((b) => mention(b.userId) + (b.roles.length ? ` (${b.roles.join('/')})` : ''))
      .join(', ')}`);
  }
  if (extra.length) lines.push('', ...extra);

  return { content: lines.join('\n'), placed: nextPlaced, result, status };
}

const SLOT_RE = /^(MT|OT|H1|H2|M1|M2|R1|R2) -\s*(?:<@!?(\d+)>)?(?:\s*\(flex: ([A-Z0-9/]+)\))?/;
const ENTRY_RE = /<@!?(\d+)>(?:\s*\(([A-Z0-9/]+)\))?/g;
const parseRoles = (text) => sortRoles((text ?? '').split('/'));

/**
 * Rebuild sign-ups from a post's text. Used when a run has no saved state
 * (posts made before sign-up state was saved, or if data/runs.json was lost).
 * The exact sign-up order can't be recovered, so people already in a slot come first.
 */
export function parsePost(content) {
  const [header, ...rest] = content.split('\n');
  const inSlots = [];
  const waiting = [];
  const bench = [];
  const placed = {};

  for (const line of rest) {
    const m = line.match(SLOT_RE);
    if (m) {
      if (!m[2]) continue;
      if (m[3]) {
        inSlots.push({ userId: m[2], mode: 'flex', roles: parseRoles(m[3]) });
        placed[m[2]] = m[1];
      } else {
        inSlots.push({ userId: m[2], mode: 'firm', roles: [m[1]] });
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

/** Turn select-menu values (e.g. ['H2','R1','BENCH']) into a sign-up. */
export function selectionToSignup(userId, values) {
  const roles = sortRoles(values);
  const mode = values.includes(BENCH) ? 'bench' : roles.length === 1 ? 'firm' : 'flex';
  return { userId, mode, roles };
}

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
