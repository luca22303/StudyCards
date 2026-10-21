// Two-way sync between the local store and the GitHub repository.
//
// A sync is: pull (download changed data files, merge record by record),
// then push (one commit with every dirty file and pending image). The push
// ends with a fast-forward-only ref update; if the other device got there
// first, the whole pull-merge-push repeats, so neither device's edits are lost.

import { db, PATHS, saveStructure, saveReviews, saveCards, saveMeta, markDirty, pendingImages, putImage, getImage, referencedImages } from './store.js';
import { client, ConflictError, GitHubError } from './github.js';
import { mergeMaps, stableStringify } from './lib/merge.js';
import { bytesToBase64, base64ToText } from './lib/util.js';

const MAX_ATTEMPTS = 3;

let status = { state: 'idle', message: '' };
const listeners = new Set();

export function onStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

function setStatus(state, message = '') {
  status = { state, message };
  for (const fn of listeners) fn(status);
}

export function getStatus() {
  return status;
}

// Owner and repository default to the GitHub Pages address the app is served
// from (luca22303.github.io/StudyCards -> luca22303/StudyCards), so on the
// hosted app only the token has to be entered.
export function repoConfig() {
  let { owner, repo, branch, token } = db.settings;
  if ((!owner || !repo) && typeof location !== 'undefined' && location.hostname.endsWith('.github.io')) {
    owner ||= location.hostname.split('.')[0];
    repo ||= location.pathname.split('/').filter(Boolean)[0] || `${owner}.github.io`;
  }
  return { owner, repo, branch, token };
}

let running = null;
let again = false;
let timer = null;

// Debounced sync after local edits, so typing ten cards makes one commit.
export function requestSync(delay = 4000) {
  clearTimeout(timer);
  timer = setTimeout(() => { sync(); }, delay);
}

export function sync() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce() {
  const cfg = repoConfig();
  if (!cfg.owner || !cfg.repo) {
    setStatus('local', 'Not connected to GitHub. Set the repository in Settings.');
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setStatus('offline', 'Offline. Changes are saved on this device and will sync later.');
    return;
  }
  setStatus('syncing', 'Syncing…');
  try {
    const gh = client(cfg);
    const branch = cfg.branch || db.meta.branch || (db.meta.branch = (await gh.repoInfo()).default_branch);
    for (let attempt = 1; ; attempt++) {
      try {
        const remote = await pull(gh, branch);
        if (cfg.token) await push(gh, branch, remote);
        break;
      } catch (e) {
        if (e instanceof ConflictError && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }
    db.meta.lastSync = Date.now();
    await saveMeta();
    prefetchImages(gh).catch(() => { /* best effort; images load on demand too */ });
    if (!cfg.token && Object.keys(db.meta.dirty).length) {
      setStatus('local', 'Read-only: add a GitHub token in Settings to upload your changes.');
    } else {
      setStatus('synced', 'All changes synced.');
    }
  } catch (e) {
    const msg = e instanceof GitHubError || e instanceof ConflictError ? e.message : `Sync failed: ${e.message}`;
    setStatus(e.status === 0 ? 'offline' : 'error', msg);
  }
}

// ---- pull --------------------------------------------------------------

async function pull(gh, branch) {
  const head = await gh.head(branch);
  if (!head) {
    throw new GitHubError(404, `Branch "${branch}" not found in the repository.`);
  }
  if (head.sha === db.meta.headSha && db.meta.treeSha) {
    return { headSha: head.sha, treeSha: db.meta.treeSha };
  }

  const tree = await gh.tree(head.treeSha);
  const shas = {};
  for (const e of tree.tree) {
    if (e.type === 'blob' && e.path.startsWith('data/')) shas[e.path] = e.sha;
  }

  for (const [path, sha] of Object.entries(shas)) {
    if (!path.endsWith('.json') || db.meta.remoteShas[path] === sha) continue;
    const blob = await gh.blob(sha);
    let data;
    try {
      data = JSON.parse(base64ToText(blob.content));
    } catch {
      throw new Error(`${path} in the repository is not valid JSON. Fix or delete it on GitHub.`);
    }
    await mergeFile(path, data);
  }

  // An image already in the repo does not need uploading again — this covers
  // a push that uploaded blobs but crashed before the ref update landed.
  for (const path of Object.keys(shas)) {
    if (!path.startsWith('data/img/')) continue;
    const id = path.slice('data/img/'.length);
    const rec = await getImage(id);
    if (rec && !rec.uploaded) await putImage(id, rec.blob, true);
  }

  db.meta.headSha = head.sha;
  db.meta.treeSha = head.treeSha;
  db.meta.remoteShas = shas;
  await saveMeta();
  return { headSha: head.sha, treeSha: head.treeSha };
}

async function mergeFile(path, data) {
  if (path === PATHS.structure) {
    const c = mergeMaps(db.structure.classes, data.classes);
    const l = mergeMaps(db.structure.lectures, data.lectures);
    if (c.localChanged || l.localChanged) {
      db.structure = { classes: c.merged, lectures: l.merged };
      await saveStructure();
    }
    if (c.remoteChanged || l.remoteChanged) await ensureDirty(path);
  } else if (path === PATHS.reviews) {
    const r = mergeMaps(db.reviews, data);
    if (r.localChanged) {
      db.reviews = r.merged;
      await saveReviews();
    }
    if (r.remoteChanged) await ensureDirty(path);
  } else {
    const m = path.match(/^data\/cards\/([\w-]+)\.json$/);
    if (!m) return;
    const lectureId = m[1];
    const r = mergeMaps(db.cards[lectureId], data);
    if (r.localChanged) {
      db.cards[lectureId] = r.merged;
      await saveCards(lectureId);
    }
    if (r.remoteChanged) await ensureDirty(path);
  }
}

async function ensureDirty(path) {
  if (!db.meta.dirty[path]) await markDirty(path);
}

// ---- push --------------------------------------------------------------

function fileContent(path) {
  if (path === PATHS.structure) return stableStringify(db.structure);
  if (path === PATHS.reviews) return stableStringify(db.reviews);
  const lectureId = path.match(/^data\/cards\/([\w-]+)\.json$/)[1];
  return stableStringify(db.cards[lectureId] ?? {});
}

async function push(gh, branch, remote) {
  const snapshot = { ...db.meta.dirty };
  const paths = Object.keys(snapshot);
  // Images whose card was deleted before they were ever uploaded are skipped:
  // nothing references them, and uploading them would only bloat the repo.
  const used = referencedImages();
  const images = (await pendingImages()).filter(i => used.has(i.id));
  if (!paths.length && !images.length) return;

  const entries = paths.map(path => ({ path, mode: '100644', type: 'blob', content: fileContent(path) }));
  for (const img of images) {
    const bytes = new Uint8Array(await img.blob.arrayBuffer());
    const blob = await gh.createBlob(bytesToBase64(bytes));
    entries.push({ path: PATHS.image(img.id), mode: '100644', type: 'blob', sha: blob.sha });
  }

  const tree = await gh.createTree(remote.treeSha, entries);
  const summary = [
    paths.length && `${paths.length} file${paths.length > 1 ? 's' : ''}`,
    images.length && `${images.length} image${images.length > 1 ? 's' : ''}`,
  ].filter(Boolean).join(', ');
  const commit = await gh.createCommit(`StudyCards sync: ${summary}`, tree.sha, [remote.headSha]);
  await gh.updateRef(branch, commit.sha);

  // Record what the repo now holds, so the next pull doesn't re-download our own files.
  const full = await gh.tree(tree.sha);
  const shas = {};
  for (const e of full.tree) {
    if (e.type === 'blob' && e.path.startsWith('data/')) shas[e.path] = e.sha;
  }
  db.meta.headSha = commit.sha;
  db.meta.treeSha = tree.sha;
  db.meta.remoteShas = shas;
  // Clear only entries that were not marked again while the push ran; an
  // edit made mid-sync stays dirty and goes out with the next sync.
  for (const path of paths) {
    if (db.meta.dirty[path] === snapshot[path]) delete db.meta.dirty[path];
  }
  await saveMeta();
  for (const img of images) await putImage(img.id, img.blob, true);
}

// ---- images ------------------------------------------------------------

// Downloads images referenced by cards but missing on this device, so cards
// made on the other device still show their images offline.
async function prefetchImages(gh) {
  for (const id of referencedImages()) {
    if (await getImage(id)) continue;
    if (!db.meta.remoteShas[PATHS.image(id)]) continue;
    await fetchRemoteImage(id, gh);
  }
}

export async function fetchRemoteImage(id, gh = client(repoConfig())) {
  if (!db.meta.headSha) return null;
  // Raw URLs pinned to a commit sha are immutable, so a CDN-cached copy is
  // never stale, and raw downloads don't count against the API rate limit.
  const res = await fetch(gh.rawUrl(db.meta.headSha, PATHS.image(id)));
  if (!res.ok) return null;
  const blob = await res.blob();
  await putImage(id, blob, true);
  return blob;
}
