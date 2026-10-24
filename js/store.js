// Local data: an in-memory model mirrored to IndexedDB.
//
// The whole collection is small (text plus image ids), so it is loaded into
// memory once and written through on every change. Images are the exception:
// their blobs live only in the `images` object store and are read on demand.
//
// Every change to synced data marks the repo file it lives in as dirty. The
// dirty map is the offline outbox: sync.js pushes exactly those files and
// clears an entry only if it was not marked again while the push ran.

import { newId } from './lib/util.js';
import { live } from './lib/merge.js';

const DB_NAME = 'studycards';
const DB_VERSION = 1;

export const PATHS = {
  structure: 'data/structure.json',
  reviews: 'data/reviews.json',
  cards: lectureId => `data/cards/${lectureId}.json`,
  image: imageId => `data/img/${imageId}`,
};

const DEFAULT_SETTINGS = {
  owner: '',
  repo: '',
  branch: '',
  token: '',
  newPerDay: 20,
  studyMode: 'flip',
};

export const db = {
  structure: { classes: {}, lectures: {} },
  cards: {},     // lectureId -> { cardId -> card }
  reviews: {},   // cardId -> review state
  settings: { ...DEFAULT_SETTINGS },
  // headSha / remoteShas: what the last sync saw on GitHub, so the next pull
  // only downloads files that changed. dirty: path -> change counter.
  meta: { headSha: null, remoteShas: {}, dirty: {}, lastSync: null },
};

let idb = null;
const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(kind) {
  for (const fn of listeners) fn(kind);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = idb.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function kvGet(key) {
  return new Promise((resolve, reject) => {
    const req = idb.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function kvPut(key, value) {
  return tx('kv', 'readwrite', s => s.put(value, key));
}

export async function load() {
  idb = await openDb();
  const keys = await new Promise((resolve, reject) => {
    const req = idb.transaction('kv').objectStore('kv').getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.structure = (await kvGet('structure')) ?? { classes: {}, lectures: {} };
  db.reviews = (await kvGet('reviews')) ?? {};
  db.settings = { ...DEFAULT_SETTINGS, ...((await kvGet('settings')) ?? {}) };
  db.meta = { ...db.meta, ...((await kvGet('meta')) ?? {}) };
  db.cards = {};
  for (const k of keys) {
    if (typeof k === 'string' && k.startsWith('cards:')) db.cards[k.slice(6)] = await kvGet(k);
  }
}

// ---- persistence -------------------------------------------------------

export function saveStructure() { return kvPut('structure', db.structure); }
export function saveReviews() { return kvPut('reviews', db.reviews); }
export function saveCards(lectureId) { return kvPut(`cards:${lectureId}`, db.cards[lectureId] ?? {}); }
export function saveMeta() { return kvPut('meta', db.meta); }
export async function saveSettings(patch) {
  db.settings = { ...db.settings, ...patch };
  await kvPut('settings', db.settings);
  emit('settings');
}

export async function markDirty(path) {
  db.meta.dirty[path] = (db.meta.dirty[path] ?? 0) + 1;
  await saveMeta();
  emit('dirty');
}

export function dirtyCount() {
  return Object.keys(db.meta.dirty).length;
}

// ---- queries -----------------------------------------------------------

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);

export function classes() {
  return live(db.structure.classes).sort(byOrder);
}

// Lectures are optional sections. Cards added straight to a class live in a
// hidden lecture flagged `isDefault`, so the file layout and sync stay
// one-file-per-lecture. Two devices can each create one before syncing; that
// is harmless, since every default lecture of a class counts as "the class".
function allLecturesOf(classId) {
  return live(db.structure.lectures).filter(l => l.classId === classId);
}

// The visible lectures (sections) of a class.
export function lecturesOf(classId) {
  return allLecturesOf(classId).filter(l => !l.isDefault).sort(byOrder);
}

function defaultLecturesOf(classId) {
  return allLecturesOf(classId).filter(l => l.isDefault).sort((a, b) => a.createdAt - b.createdAt);
}

// Where a card added directly to the class goes; created on first use.
export async function ensureDefaultLecture(classId) {
  const existing = defaultLecturesOf(classId)[0];
  if (existing) return existing.id;
  const now = Date.now();
  const id = newId();
  db.structure.lectures[id] = { id, classId, name: '', isDefault: true, order: 0, createdAt: now, updatedAt: now };
  await commitStructure();
  return id;
}

// Cards that belong to the class itself rather than to one of its lectures.
export function directCardsOf(classId) {
  return defaultLecturesOf(classId).flatMap(l => cardsOf(l.id));
}

export function getClass(id) {
  const c = db.structure.classes[id];
  return c && !c.deleted ? c : null;
}

export function getLecture(id) {
  const l = db.structure.lectures[id];
  return l && !l.deleted ? l : null;
}

export function cardsOf(lectureId) {
  return live(db.cards[lectureId]).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function cardsOfClass(classId) {
  return allLecturesOf(classId).flatMap(l => cardsOf(l.id));
}

export function findCard(cardId) {
  for (const [lectureId, map] of Object.entries(db.cards)) {
    const c = map?.[cardId];
    if (c && !c.deleted) return { card: c, lectureId };
  }
  return null;
}

// ---- mutations ---------------------------------------------------------

function nextOrder(records) {
  return records.reduce((m, r) => Math.max(m, r.order ?? 0), 0) + 1;
}

async function commitStructure() {
  await saveStructure();
  await markDirty(PATHS.structure);
  emit('structure');
}

export async function addClass(name) {
  const now = Date.now();
  const id = newId();
  db.structure.classes[id] = { id, name, order: nextOrder(classes()), createdAt: now, updatedAt: now };
  await commitStructure();
  return id;
}

export async function addLecture(classId, name) {
  const now = Date.now();
  const id = newId();
  db.structure.lectures[id] = { id, classId, name, order: nextOrder(lecturesOf(classId)), createdAt: now, updatedAt: now };
  await commitStructure();
  return id;
}

export async function rename(kind, id, name) {
  const map = kind === 'class' ? db.structure.classes : db.structure.lectures;
  map[id] = { ...map[id], name, updatedAt: Date.now() };
  await commitStructure();
}

// Moves a class or lecture one step up or down among its siblings.
export async function move(kind, id, dir) {
  const list = kind === 'class' ? classes() : lecturesOf(db.structure.lectures[id].classId);
  const map = kind === 'class' ? db.structure.classes : db.structure.lectures;
  const i = list.findIndex(r => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const now = Date.now();
  // Renumber the whole sibling list so equal or missing orders can't stick.
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((r, k) => { map[r.id] = { ...map[r.id], order: k + 1, updatedAt: now }; });
  await commitStructure();
}

export async function deleteLecture(lectureId) {
  const now = Date.now();
  db.structure.lectures[lectureId] = { ...db.structure.lectures[lectureId], deleted: true, updatedAt: now };
  await tombstoneCards(lectureId, now);
  await commitStructure();
}

export async function deleteClass(classId) {
  const now = Date.now();
  for (const l of allLecturesOf(classId)) {
    db.structure.lectures[l.id] = { ...l, deleted: true, updatedAt: now };
    await tombstoneCards(l.id, now);
  }
  db.structure.classes[classId] = { ...db.structure.classes[classId], deleted: true, updatedAt: now };
  await commitStructure();
}

async function tombstoneCards(lectureId, now) {
  const map = db.cards[lectureId];
  if (!map) return;
  let any = false;
  for (const c of Object.values(map)) {
    if (!c.deleted) {
      map[c.id] = { id: c.id, lectureId, deleted: true, updatedAt: now };
      any = true;
    }
  }
  if (any) {
    await saveCards(lectureId);
    await markDirty(PATHS.cards(lectureId));
  }
}

export async function saveCard(lectureId, { id, front, back }) {
  const now = Date.now();
  const map = (db.cards[lectureId] ??= {});
  const prev = id ? map[id] : null;
  const cardId = id ?? newId();
  map[cardId] = {
    id: cardId,
    lectureId,
    front,
    back,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  await saveCards(lectureId);
  await markDirty(PATHS.cards(lectureId));
  emit('cards');
  return cardId;
}

export async function addCards(lectureId, list) {
  const map = (db.cards[lectureId] ??= {});
  const now = Date.now();
  // Distinct createdAt values keep the pasted order when sorting.
  list.forEach(({ front, back }, i) => {
    const id = newId();
    map[id] = { id, lectureId, front, back, createdAt: now + i, updatedAt: now };
  });
  await saveCards(lectureId);
  await markDirty(PATHS.cards(lectureId));
  emit('cards');
}

export async function deleteCard(lectureId, cardId) {
  db.cards[lectureId][cardId] = { id: cardId, lectureId, deleted: true, updatedAt: Date.now() };
  await saveCards(lectureId);
  await markDirty(PATHS.cards(lectureId));
  emit('cards');
}

export async function recordReview(cardId, state) {
  db.reviews[cardId] = state;
  await saveReviews();
  await markDirty(PATHS.reviews);
  emit('reviews');
}

// ---- images ------------------------------------------------------------

// uploaded=false means the blob still has to go to GitHub on the next push.
export function putImage(id, blob, uploaded) {
  return tx('images', 'readwrite', s => s.put({ blob, uploaded }, id));
}

export function getImage(id) {
  return new Promise((resolve, reject) => {
    const req = idb.transaction('images').objectStore('images').get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export function allImageKeys() {
  return new Promise((resolve, reject) => {
    const req = idb.transaction('images').objectStore('images').getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function pendingImages() {
  const out = [];
  for (const id of await allImageKeys()) {
    const rec = await getImage(id);
    if (rec && !rec.uploaded) out.push({ id, blob: rec.blob });
  }
  return out;
}

// Image ids referenced by any live card, from the `img:<id>` markdown token.
export function referencedImages() {
  const ids = new Set();
  for (const map of Object.values(db.cards)) {
    for (const c of live(map)) {
      for (const text of [c.front, c.back]) {
        for (const m of (text ?? '').matchAll(/img:([\w.-]+)/g)) ids.add(m[1]);
      }
    }
  }
  return ids;
}

// ---- backup ------------------------------------------------------------

export function exportJson() {
  return JSON.stringify({
    format: 'studycards-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    structure: db.structure,
    cards: db.cards,
    reviews: db.reviews,
  }, null, 1);
}
