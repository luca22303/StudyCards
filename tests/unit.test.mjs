// Unit tests for the pure logic in js/lib. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule, previewIntervals, stats, introducedOn, MASTERED_DAYS } from '../js/lib/srs.js';
import { mergeMaps, pickNewer, stableStringify } from '../js/lib/merge.js';
import { createSession, rate, current, isDone, pickReviewCards } from '../js/lib/session.js';
import { parseBulk } from '../js/lib/bulk.js';
import { addDays, textToBase64, base64ToText, shuffle } from '../js/lib/util.js';

const T = '2026-10-21';

test('srs: new card intervals per rating', () => {
  assert.deepEqual(previewIntervals(undefined, T), { again: 1, hard: 1, good: 1, easy: 4 });
  const s = schedule(undefined, 'good', T, 5);
  assert.equal(s.due, '2026-10-22');
  assert.equal(s.introduced, T);
  assert.equal(s.updatedAt, 5);
});

test('srs: good, good, good grows interval 1 -> 3 -> 8 (ease 2.5)', () => {
  let s = schedule(undefined, 'good', T);
  s = schedule(s, 'good', s.due);
  assert.equal(s.interval, 3);
  s = schedule(s, 'good', s.due);
  assert.equal(s.interval, 8);
  assert.equal(s.introduced, T, 'introduced day is kept across reviews');
});

test('srs: again resets a learned card and counts a lapse; ease floors at 1.3', () => {
  let s = { reps: 5, interval: 40, ease: 1.35, lapses: 0, due: T };
  s = schedule(s, 'again', T);
  assert.equal(s.interval, 1);
  assert.equal(s.reps, 0);
  assert.equal(s.lapses, 1);
  assert.equal(s.ease, 1.3);
  // Again on a never-learned card is not a lapse.
  assert.equal(schedule(undefined, 'again', T).lapses, 0);
});

test('srs: ordering hard < good < easy for a learned card', () => {
  const p = previewIntervals({ reps: 3, interval: 10, ease: 2.5, lapses: 0, due: T }, T);
  assert.ok(p.hard < p.good && p.good < p.easy, JSON.stringify(p));
});

test('srs: schedule never mutates the previous state', () => {
  const prev = Object.freeze({ reps: 2, interval: 3, ease: 2.5, lapses: 0, due: T });
  schedule(prev, 'easy', T);
});

test('srs: stats count due, new, mastered', () => {
  const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const reviews = {
    a: { due: '2026-10-20', interval: 2 },
    b: { due: '2026-12-01', interval: MASTERED_DAYS },
    c: { due: T, interval: 1, introduced: T },
  };
  assert.deepEqual(stats(cards, reviews, T), { total: 4, due: 2, new: 1, mastered: 1, masteredPct: 25 });
  assert.equal(introducedOn(reviews, T), 1);
});

test('merge: newer updatedAt wins in both directions; tie goes to remote', () => {
  const local = { x: { id: 'x', v: 'L', updatedAt: 20 }, y: { id: 'y', v: 'L', updatedAt: 1 }, onlyL: { id: 'onlyL', updatedAt: 1 } };
  const remote = { x: { id: 'x', v: 'R', updatedAt: 10 }, y: { id: 'y', v: 'R', updatedAt: 5 }, onlyR: { id: 'onlyR', updatedAt: 1 } };
  const { merged, localChanged, remoteChanged } = mergeMaps(local, remote);
  assert.equal(merged.x.v, 'L');
  assert.equal(merged.y.v, 'R');
  assert.ok(merged.onlyL && merged.onlyR);
  assert.ok(localChanged && remoteChanged);
  assert.equal(pickNewer({ v: 'L', updatedAt: 3 }, { v: 'R', updatedAt: 3 }).v, 'R');
});

test('merge: tombstone beats an older edit, and a newer edit beats an older tombstone', () => {
  const edit = { id: 'c', front: 'q', back: 'a', updatedAt: 100 };
  const tomb = { id: 'c', deleted: true, updatedAt: 200 };
  assert.equal(mergeMaps({ c: edit }, { c: tomb }).merged.c.deleted, true);
  assert.equal(mergeMaps({ c: tomb }, { c: edit }).merged.c.deleted, true);
  const laterEdit = { ...edit, updatedAt: 300 };
  assert.equal(mergeMaps({ c: laterEdit }, { c: tomb }).merged.c.deleted, undefined);
});

test('merge: identical maps report no change either way', () => {
  const a = { c: { id: 'c', updatedAt: 1 } };
  const r = mergeMaps(a, JSON.parse(JSON.stringify(a)));
  assert.equal(r.localChanged, false);
  assert.equal(r.remoteChanged, false);
});

test('merge: stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 1, c: 2 } }), stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
});

test('session: again re-queues to the end until answered', () => {
  let s = createSession(['a', 'b', 'c'], { rand: () => 0.999 });
  assert.deepEqual(s.queue, ['a', 'b', 'c']);
  s = rate(s, 'again');
  assert.deepEqual(s.queue, ['b', 'c', 'a']);
  s = rate(s, 'good');
  s = rate(s, 'hard');
  assert.equal(current(s), 'a');
  assert.equal(isDone(s), false);
  s = rate(s, 'easy');
  assert.equal(isDone(s), true);
  assert.equal(s.finished, 3);
  assert.equal(s.lapses, 1);
  assert.deepEqual(s.ratings, { again: 1, hard: 1, good: 1, easy: 1 });
});

test('session: review picks due cards and limits new ones', () => {
  const cards = [
    { id: 'n1', createdAt: 3 }, { id: 'n2', createdAt: 1 }, { id: 'n3', createdAt: 2 },
    { id: 'due' }, { id: 'later' },
  ];
  const reviews = { due: { due: T }, later: { due: '2027-01-01' } };
  const { due, fresh } = pickReviewCards(cards, reviews, T, 2);
  assert.deepEqual(due.map(c => c.id), ['due']);
  assert.deepEqual(fresh.map(c => c.id), ['n2', 'n3']);
  assert.equal(pickReviewCards(cards, reviews, T, -3).fresh.length, 0);
});

test('bulk: parses lines, keeps skipped lines with reasons', () => {
  const { cards, skipped } = parseBulk('Q1 ;; A1\n\nno separator\n ;; empty front\nQ3;;line\\nbreak\nQ4 ;; a ;; b');
  assert.deepEqual(cards, [
    { front: 'Q1', back: 'A1' },
    { front: 'Q3', back: 'line\nbreak' },
    { front: 'Q4', back: 'a ;; b' },
  ]);
  assert.deepEqual(skipped.map(s => s.line), [3, 4]);
  assert.match(skipped[0].reason, /tab separator/);
});

test('bulk: tab-separated spreadsheet rows, extra columns appended to the back', () => {
  const { cards, skipped } = parseBulk('el perro\tder Hund\r\nla casa\tdas Haus\tEs una casa grande.\n\tleer\nsolo\t\t\nmit ;; semikolon\tund tab');
  assert.deepEqual(cards, [
    { front: 'el perro', back: 'der Hund' },
    { front: 'la casa', back: 'das Haus\nEs una casa grande.' },
    // ";;" wins over a tab on the same line.
    { front: 'mit', back: 'semikolon\tund tab' },
  ]);
  assert.deepEqual(skipped.map(s => [s.line, s.reason]), [[3, 'front is empty'], [4, 'back is empty']]);
});

test('util: addDays crosses month and DST boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(addDays('2026-12-31', 365), '2027-12-31');
});

test('util: base64 round-trips UTF-8', () => {
  const s = 'Größe – Ä ö ü ß 🧠';
  assert.equal(base64ToText(textToBase64(s)), s);
});

test('util: shuffle keeps all elements', () => {
  assert.deepEqual(shuffle([1, 2, 3, 4, 5]).sort(), [1, 2, 3, 4, 5]);
});
