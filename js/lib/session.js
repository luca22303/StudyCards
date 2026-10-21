// A study session: a queue of card ids that is worked through front to back.
//
// "Again" puts the card back at the end of the queue, so a session only ends
// once every card has been answered with something better than Again.
// Whether a rating also updates the schedule is decided by the caller
// (Due review: yes; Cram: never), not here.

import { shuffle } from './util.js';

export function createSession(cardIds, { rand = Math.random } = {}) {
  return {
    queue: shuffle(cardIds, rand),
    total: cardIds.length,
    // Cards answered with something other than Again — the progress bar.
    finished: 0,
    // How many Again presses — shown in the end-of-session summary.
    lapses: 0,
    ratings: { again: 0, hard: 0, good: 0, easy: 0 },
  };
}

export function current(session) {
  return session.queue[0] ?? null;
}

export function isDone(session) {
  return session.queue.length === 0;
}

// Returns a new session; never mutates the old one.
export function rate(session, rating) {
  const [head, ...rest] = session.queue;
  if (head === undefined) return session;
  const ratings = { ...session.ratings, [rating]: session.ratings[rating] + 1 };
  if (rating === 'again') {
    return { ...session, queue: [...rest, head], lapses: session.lapses + 1, ratings };
  }
  return { ...session, queue: rest, finished: session.finished + 1, ratings };
}

// Picks the cards for a Due review: every card already due, plus up to
// `newLimit` cards that have never been studied.
export function pickReviewCards(cards, reviews, today, newLimit) {
  const due = [], fresh = [];
  for (const c of cards) {
    const st = reviews[c.id];
    if (!st) fresh.push(c);
    else if (st.due <= today) due.push(c);
  }
  // New cards in creation order, so a lecture is introduced roughly as written.
  fresh.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return { due, fresh: fresh.slice(0, Math.max(0, newLimit)) };
}
