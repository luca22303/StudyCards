// Spaced repetition: an SM-2 variant with four self-grades.
//
// A review state is { reps, interval, ease, lapses, due, updatedAt }.
// A card with no state is "new". Intervals are whole days and `due` is a
// local calendar day (YYYY-MM-DD), so a card is due for the whole of its day.

import { addDays } from './util.js';

export const RATINGS = ['again', 'hard', 'good', 'easy'];

export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;
// A card whose interval has reached this many days counts as "mastered" in
// the stats. Three weeks is the usual threshold for a "mature" card.
export const MASTERED_DAYS = 21;

// Returns the next state without mutating `prev` (which may be undefined
// for a new card). `today` is a YYYY-MM-DD string; `now` stamps updatedAt,
// which the sync merge uses to decide which device's state wins.
export function schedule(prev, rating, today, now = Date.now()) {
  if (!RATINGS.includes(rating)) throw new Error(`Unknown rating: ${rating}`);
  const s = prev ?? { reps: 0, interval: 0, ease: DEFAULT_EASE, lapses: 0 };
  let { reps, interval, ease, lapses } = s;

  if (rating === 'again') {
    // A lapse only counts for a card that had been learned before.
    if (reps > 0) lapses += 1;
    reps = 0;
    interval = 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
  } else if (rating === 'hard') {
    interval = reps === 0 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2));
    ease = Math.max(MIN_EASE, ease - 0.15);
    reps += 1;
  } else if (rating === 'good') {
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = Math.max(3, interval + 1);
    else interval = Math.max(interval + 1, Math.round(interval * ease));
    reps += 1;
  } else {
    if (reps === 0) interval = 4;
    else interval = Math.max(interval + 2, Math.round(interval * ease * 1.3));
    ease += 0.15;
    reps += 1;
  }

  ease = Math.round(ease * 100) / 100;
  // `introduced` is the day a card was first studied. It is synced with the
  // rest of the state, so the new-cards-per-day limit holds across devices.
  const introduced = s.introduced ?? today;
  return { reps, interval, ease, lapses, due: addDays(today, interval), introduced, updatedAt: now };
}

// Interval each button would give, for the labels under the rating buttons.
export function previewIntervals(prev, today) {
  const out = {};
  for (const r of RATINGS) out[r] = schedule(prev, r, today, 0).interval;
  return out;
}

export function formatInterval(days) {
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function isDue(state, today) {
  return !!state && state.due <= today;
}

export function isMastered(state) {
  return !!state && state.interval >= MASTERED_DAYS;
}

export function introducedOn(reviews, day) {
  let n = 0;
  for (const st of Object.values(reviews)) if (st && st.introduced === day) n += 1;
  return n;
}

// Stats over a set of live (non-deleted) cards.
export function stats(cards, reviews, today) {
  let due = 0, fresh = 0, mastered = 0;
  for (const c of cards) {
    const st = reviews[c.id];
    if (!st) fresh += 1;
    else {
      if (isDue(st, today)) due += 1;
      if (isMastered(st)) mastered += 1;
    }
  }
  const total = cards.length;
  return { total, due, new: fresh, mastered, masteredPct: total ? Math.round((mastered / total) * 100) : 0 };
}
