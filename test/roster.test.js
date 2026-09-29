import assert from 'node:assert/strict';
import {
  JOBS,
  describeJobs,
  missingJobs,
  orderedSelection,
  parseJobInput,
  parsePost,
  placementOf,
  renderRun,
  roleStatus,
  selectionToSignup,
} from '../src/roster.js';

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
  leave('5'); // user 6 moves up to their first choice, the earliest waitlisted user gets the other slot
  assert.match(r.content, /MT - <@6>\n/);
  assert.match(r.content, /OT - <@7>\n/);
  assert.match(r.content, /Waitlist - <@8> \(MT\)/);
});

test('flex roles keep the order they were picked in', () => {
  assert.deepEqual(selectionToSignup('1', ['R2', 'H1', 'MT']).roles, ['R2', 'H1', 'MT']);
  assert.deepEqual(selectionToSignup('1', ['R2', 'BENCH', 'H1']).roles, ['R2', 'H1']);
  pick('1', ['R2', 'H2', 'R1']);
  assert.match(r.content, /R2 - <@1> \(flex: R2\/H2\/R1\)/, 'gets their first choice');
});

test('flex user gets their highest free choice and moves back up when it opens', () => {
  pick('1', ['R2', 'H2', 'R1']);
  pick('2', ['R2']); // takes R2, user 1 drops to their 2nd choice
  assert.match(r.content, /H2 - <@1>/);
  pick('3', ['H2']); // user 1 drops to their 3rd choice
  assert.match(r.content, /^R1 - <@1>$/m);
  leave('2'); // R2 opens: user 1 goes back to their 1st choice
  assert.match(r.content, /R2 - <@1>/);
  assert.match(r.content, /R1 - \n/);
});

test('re-picking keeps the old order and adds new roles to the end', () => {
  assert.deepEqual(orderedSelection(['R2', 'H2'], ['H2', 'R2', 'MT']), ['R2', 'H2', 'MT']);
  assert.deepEqual(orderedSelection(['R2', 'H2', 'MT'], ['MT', 'H2']), ['H2', 'MT']);
  assert.deepEqual(orderedSelection([], ['OT', 'MT']), ['OT', 'MT']);
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

test('posts with a Merc Run ID line keep the full header when parsed', () => {
  const header = '**Merc Run ID: 123456**\n5m M4S clear <t:1790000000:f> for <@9> M1';
  pick('1', ['H2']);
  const content = renderRun(header, signups, placed).content;
  assert.ok(content.startsWith('**Merc Run ID: 123456**\n5m M4S'));
  const parsed = parsePost(content);
  assert.equal(parsed.header, header);
  assert.equal(renderRun(parsed.header, parsed.signups, parsed.placed).content, content);
});

test('the clearee can be shown by name instead of an @mention', () => {
  pick('1', ['H2']);
  const content = renderRun(H, signups, placed, { 9: 'Steph' }).content;
  assert.match(content, /^M1 - Steph$/m);
  assert.doesNotMatch(content, /<@9>/);
  assert.match(content, /^H2 - <@1>$/m);
});

test('posts with a ping line on top parse back', () => {
  const header = '<@&1529562550348288040>\n**Merc Run ID: 123456**\n5m M4S clear <t:1790000000:f> for Steph M1';
  pick('1', ['H2']);
  const content = renderRun(header, signups, placed).content;
  assert.ok(content.startsWith('<@&1529562550348288040>\n'));
  const parsed = parsePost(content);
  assert.equal(parsed.header, header);
  assert.equal(renderRun(parsed.header, parsed.signups, parsed.placed).content, content);
});

test('tank and melee roles need a job; healer and ranged jobs are optional', () => {
  assert.equal(JOBS.length, 21);
  assert.deepEqual(missingJobs(['MT', 'H1'], []).map((g) => g.key), ['tank']);
  assert.deepEqual(missingJobs(['OT', 'M2'], ['DRK']).map((g) => g.key), ['melee']);
  assert.deepEqual(missingJobs(['MT', 'M1'], ['GNB', 'SAM']), []);
  assert.deepEqual(missingJobs(['H1', 'R2'], []), []);
});

test('jobs are kept only for picked roles and shown on the slot they fit', () => {
  const s = selectionToSignup('1', ['MT', 'H1'], ['WAR', 'GNB', 'AST', 'SAM', 'SGE']);
  assert.deepEqual(s.jobs, ['GNB', 'WAR', 'AST'], 'SAM/SGE dropped: M1/M2/H2 not picked');
  assert.equal(describeJobs(s), 'GNB/WAR/AST');
  signups = [...signups, s];
  rerender();
  assert.match(r.content, /^MT - <@1> \(GNB\/WAR\) \(flex: MT\/H1\)$/m);
  pick('2', ['MT']); // user 1 moves to H1 and shows their H1 jobs there
  assert.match(r.content, /^H1 - <@1> \(AST\)$/m);
});

test('posts with jobs parse back', () => {
  signups = [...signups, selectionToSignup('1', ['OT'], ['DRK', 'PLD'])];
  signups = [...signups, selectionToSignup('2', ['R1', 'R2'], ['BRD', 'PCT'])];
  rerender();
  assert.match(r.content, /^OT - <@1> \(DRK\/PLD\)$/m);
  assert.match(r.content, /^R1 - <@2> \(BRD\) \(flex: R1\/R2\)$/m);
  const parsed = parsePost(r.content);
  assert.deepEqual(parsed.signups.find((x) => x.userId === '1').jobs, ['DRK', 'PLD']);
  assert.equal(renderRun(parsed.header, parsed.signups, parsed.placed).content, r.content);
});

test('clearee job input', () => {
  assert.deepEqual(parseJobInput('MT', 'drk/gnb'), { jobs: ['GNB', 'DRK'], invalid: [] });
  assert.deepEqual(parseJobInput('M1', 'NIN, SAM WHM'), { jobs: ['NIN', 'SAM'], invalid: ['WHM'] });
  assert.deepEqual(parseJobInput('H1', ''), { jobs: [], invalid: [] });
  assert.equal(missingJobs(['M1'], parseJobInput('M1', '').jobs).length, 1);
  assert.equal(missingJobs(['H1'], parseJobInput('H1', '').jobs).length, 0);
});

console.log('\nAll checks passed.');
