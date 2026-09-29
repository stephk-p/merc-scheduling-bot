// The run post itself is the source of truth for who is signed up, so sign-ups
// survive bot restarts without needing a database.

export const ROLES = ['MT', 'OT', 'H1', 'H2', 'M1', 'M2', 'R1', 'R2'];

const LINE_RE = /^(MT|OT|H1|H2|M1|M2|R1|R2) -\s*(.*)$/;

export function buildRunContent(header) {
  return `${header}\n\n${ROLES.map((r) => `${r} - `).join('\n')}`;
}

/** Returns { MT: '<@123>' | '', OT: '', ... } */
export function parseRoster(content) {
  const slots = Object.fromEntries(ROLES.map((r) => [r, '']));
  // Skip line 0 (the header) so custom text can never be mistaken for a slot.
  for (const line of content.split('\n').slice(1)) {
    const m = line.match(LINE_RE);
    if (m) slots[m[1]] = m[2].trim();
  }
  return slots;
}

export function findUserSlot(slots, userId) {
  return ROLES.find((r) => slots[r].includes(`<@${userId}>`)) ?? null;
}

export function openRoles(slots) {
  return ROLES.filter((r) => !slots[r]);
}

export function setSlot(content, role, value) {
  const lines = content.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (m && m[1] === role) lines[i] = `${role} - ${value}`;
  }
  return lines.join('\n');
}
