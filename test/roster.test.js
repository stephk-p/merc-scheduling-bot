import assert from 'node:assert/strict';
import { parsePost, placementOf, renderRun, roleStatus, selectionToSignup } from '../src/roster.js';

const H = 'header';
let signups;
let placed;
let r;
const reset = () => {
  signups = [{ userId: '9', mode: 'firm', roles: ['M1'] }]; // clearee
  placed = {};
};
const rerender = () => {
  r = renderRun(H, signups, placed);
  placed = r.placed;
  return r;
};
const pick = (userId, values) => {
  const s = selectionToSignup(userId, values);
  signups = [...signups.filter((x) => x.userId !== userId), s];
  rerender();
  return placementOf(s, r);
};
const leave = (userId) => {
  signups = signups.filter((x) => x.userId !== userId);
  return rerender();
};
const test = (name, fn) => {
  reset();
  fn();
  console.log(`ok - ${name}`);
};

test('example: flex user moves as one-role picks come in', () => {
  pick('1', ['H2', 'R1', 'R2']);
  assert.match(r.content, /H2 - <@1> \(flex: H2\/R1\/R2\)/);
  pick('2', ['H2']);
  assert.match(r.content, /H2 - <@2>\n/);
  assert.match(r.content, /R1 - <@1> \(flex: R1\/R2\)/);
  pick('3', ['R1']);
  assert.match(r.content, /R1 - <@3>\n/);
  assert.match(r.content, /^R2 - <@1>$/m, 'user 1 is filled as R2, no longer movable');
});

test('earlier flex user keeps priority when their other roles are taken', () => {
  pick('1', ['H2', 'R1', 'R2']);
  pick('2', ['H2']);
  pick('3', ['R1']);
  assert.equal(roleStatus(signups, placed).R2, 'taken');
  const p = pick('4', ['R2']); // later one-role pick on user 1's last option
  assert.deepEqual(p, { waitlist: true });
  assert.match(r.content, /^R2 - <@1>$/m, 'user 1 keeps R2');
  assert.match(r.content, /Waitlist - <@4> \(R2\)/);
});

test('waitlisted one-role user gets the slot when the flex user can move again', () => {
  pick('1', ['H2', 'R1', 'R2']);
  pick('2', ['H2']);
  pick('3', ['R1']);
  pick('4', ['R2']);
  leave('3'); // R1 frees up, so user 1 can move there and user 4 gets R2
  assert.match(r.content, /R1 - <@1>\n/);
  assert.match(r.content, /R2 - <@4>$/m);
  assert.doesNotMatch(r.content, /Waitlist/);
});

test('waitlisted one-role user gets the slot when the flex user leaves', () => {
  pick('1', ['H2', 'R2']);
  pick('2', ['H2']); // user 1 -> R2, locked
  pick('4', ['R2']); // waitlisted
  leave('1');
  assert.match(r.content, /R2 - <@4>$/m);
});

test('earlier flex user is never unseated by a later flex user either', () => {
  pick('5', ['MT', 'OT']);
  assert.match(r.content, /MT - <@5> \(flex: MT\/OT\)/);
  pick('6', ['MT', 'OT']); // both now locked
  assert.match(r.content, /MT - <@5>\n/);
  assert.match(r.content, /OT - <@6>\n/);
  assert.deepEqual(pick('7', ['MT', 'OT']), { waitlist: true });
  assert.deepEqual(pick('8', ['MT']), { waitlist: true });
  assert.match(r.content, /Waitlist - <@7> \(MT\/OT\), <@8> \(MT\)/);
  leave('5'); // the earliest waitlisted user gets the slot
  assert.match(r.content, /MT - <@7>\n/);
  assert.match(r.content, /Waitlist - <@8> \(MT\)/);
});

test('a later one-role pick still takes the slot when the flex user can move', () => {
  pick('1', ['H2', 'R1']);
  assert.equal(roleStatus(signups, placed).H2, 'flex');
  assert.deepEqual(pick('2', ['H2']), { role: 'H2', movable: false });
  assert.match(r.content, /R1 - <@1>\n/);
});

test('one-role user who signed up first beats a later flex user', () => {
  pick('2', ['H2']);
  assert.deepEqual(pick('1', ['H2', 'R1']), { role: 'R1', movable: false });
});

test('bench', () => {
  assert.deepEqual(pick('4', ['R2', 'BENCH']), { bench: true });
  assert.match(r.content, /Bench - <@4> \(R2\)/);
  assert.match(r.content, /R2 - \n/);
});

test('changing your pick puts you at the back of the line', () => {
  pick('1', ['H2', 'R2']);
  pick('2', ['H2']); // user 1 -> R2, locked
  pick('4', ['R2']); // waitlisted behind user 1
  pick('1', ['H2', 'R2']); // user 1 re-picks: now later than user 4
  assert.match(r.content, /R2 - <@4>$/m);
  assert.match(r.content, /Waitlist - <@1> \(H2\/R2\)/);
});

test('post text can be parsed back (including legacy "Flex -" line)', () => {
  pick('1', ['H2', 'R1', 'R2']);
  pick('2', ['H2']);
  pick('4', ['R1', 'BENCH']);
  pick('5', ['M1']);
  const parsed = parsePost(r.content);
  assert.equal(renderRun(parsed.header, parsed.signups, parsed.placed).content, r.content);

  const legacy = parsePost('h\n\nMT - <@1>\n\nFlex - <@2> (MT/OT)');
  assert.deepEqual(legacy.signups[1], { userId: '2', mode: 'flex', roles: ['MT', 'OT'] });
});

console.log('\nAll checks passed.');
