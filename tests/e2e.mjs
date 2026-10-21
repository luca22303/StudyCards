// End-to-end test: drives the real app in Chromium with two separate browser
// contexts ("MacBook" and "iPhone") against an in-memory fake of the GitHub
// Git Data API, so sync, merge and conflict handling run for real.
//
// Run:  NODE_PATH=$(npm root -g) node tests/e2e.mjs
// (needs Playwright; serves the repo root itself on a free port)

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---- static server -----------------------------------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = path.endsWith('/') ? `${path}index.html` : path;
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}/`;

// ---- fake GitHub -------------------------------------------------------

const sha1 = s => createHash('sha1').update(s).digest('hex');
const git = { blobs: {}, trees: {}, commits: {}, ref: null, calls: [] };
function putBlob(buf) {
  const sha = sha1(Buffer.concat([Buffer.from('blob'), buf]));
  git.blobs[sha] = buf;
  return sha;
}
function putTree(entries) {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const sha = sha1(`tree${JSON.stringify(sorted)}`);
  git.trees[sha] = sorted;
  return sha;
}
function putCommit(tree, parents, message) {
  const sha = sha1(`commit${tree}${parents.join()}${message}${Math.random()}`);
  git.commits[sha] = { tree, parents, message };
  return sha;
}
git.ref = putCommit(putTree([{ path: 'README.md', mode: '100644', type: 'blob', sha: putBlob(Buffer.from('# hi')) }]), [], 'init');

function fileAt(path, ref = git.ref) {
  const commit = git.commits[ref] ?? git.commits[git.ref];
  const e = git.trees[commit.tree].find(x => x.path === path);
  return e ? git.blobs[e.sha] : null;
}
const jsonAt = path => JSON.parse(fileAt(path)?.toString() ?? 'null');

let rejectNextRefUpdate = false;

async function githubRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  const p = url.pathname.replace('/repos/me/cards', '');
  git.calls.push(`${req.method()} ${p}`);
  const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'Access-Control-Allow-Origin': '*' } });
  if (req.method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  }
  const writes = ['POST', 'PATCH'].includes(req.method());
  if (writes && req.headers().authorization !== 'Bearer test-token') return json(401, { message: 'Bad credentials' });

  if (p === '' ) return json(200, { default_branch: 'main' });
  let m;
  if ((m = p.match(/^\/commits\/(.+)$/))) {
    if (m[1] !== 'main') return json(404, { message: 'No commit found' });
    return json(200, { sha: git.ref, commit: { tree: { sha: git.commits[git.ref].tree } } });
  }
  if ((m = p.match(/^\/git\/trees\/(\w+)$/)) && req.method() === 'GET') {
    return json(200, { sha: m[1], tree: git.trees[m[1]], truncated: false });
  }
  if ((m = p.match(/^\/git\/blobs\/(\w+)$/))) {
    return json(200, { sha: m[1], content: git.blobs[m[1]].toString('base64'), encoding: 'base64' });
  }
  if (p === '/git/blobs') return json(201, { sha: putBlob(Buffer.from(body.content, 'base64')) });
  if (p === '/git/trees') {
    const map = new Map((body.base_tree ? git.trees[body.base_tree] : []).map(e => [e.path, e]));
    for (const e of body.tree) {
      const sha = e.content != null ? putBlob(Buffer.from(e.content)) : e.sha;
      map.set(e.path, { path: e.path, mode: e.mode, type: 'blob', sha });
    }
    return json(201, { sha: putTree([...map.values()]) });
  }
  if (p === '/git/commits') return json(201, { sha: putCommit(body.tree, body.parents, body.message) });
  if (p === '/git/refs/heads/main') {
    const c = git.commits[body.sha];
    if (rejectNextRefUpdate || c.parents[0] !== git.ref) {
      rejectNextRefUpdate = false;
      return json(422, { message: 'Update is not a fast forward' });
    }
    git.ref = body.sha;
    return json(200, { object: { sha: body.sha } });
  }
  return json(404, { message: `fake github: unhandled ${req.method()} ${p}` });
}

async function rawRoute(route) {
  const url = new URL(route.request().url());
  const [, , , ref, ...rest] = url.pathname.split('/');
  const buf = fileAt(rest.join('/'), ref);
  if (!buf) return route.fulfill({ status: 404 });
  return route.fulfill({ status: 200, body: buf, headers: { 'Access-Control-Allow-Origin': '*' } });
}

// ---- helpers -----------------------------------------------------------

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = [];
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? `  — ${detail}` : ''}`);
}

async function device(name, opts = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route('https://api.github.com/**', githubRoute);
  await ctx.route('https://raw.githubusercontent.com/**', rawRoute);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(`[${name}] pageerror:`, e.message); });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE);
  return { name, ctx, page, errors };
}

async function connect(page) {
  await page.goto(`${BASE}#/settings`);
  await page.fill('input[data-key=owner]', 'me');
  await page.fill('input[data-key=repo]', 'cards');
  await page.fill('input[data-key=token]', 'test-token');
  await page.click('button[type=submit]');
  await waitSynced(page);
}

async function waitSynced(page) {
  await page.waitForFunction(() => {
    const s = document.getElementById('sync-btn').dataset.state;
    return s === 'synced' || s === 'error';
  }, null, { timeout: 10000 });
  return page.$eval('#sync-btn', b => ({ state: b.dataset.state, title: b.title }));
}

async function syncNow(page) {
  // Clear the state first so waitSynced can't return a stale "synced".
  await page.evaluate(() => { document.getElementById('sync-btn').dataset.state = 'idle'; });
  await page.click('#sync-btn');
  return waitSynced(page);
}

async function shot(page, name) {
  if (!process.env.SHOT_DIR) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
}

async function answerDialog(page, text) {
  const dlg = await page.waitForSelector('dialog[open] input').then(i => i.evaluateHandle(el => el.closest('dialog')));
  await page.fill('dialog[open] input', text);
  await page.press('dialog[open] input', 'Enter');
  // Wait on this dialog element: a follow-up dialog may open immediately.
  await page.waitForFunction(d => !d.isConnected, dlg);
}

async function pngFile(page) {
  // A real 2400x1200 PNG, so the resize path (max 1600px) is exercised.
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 2400; c.height = 1200;
    const g = c.getContext('2d');
    g.fillStyle = '#c33'; g.fillRect(0, 0, 2400, 1200);
    g.fillStyle = '#fff'; g.font = '200px sans-serif'; g.fillText('Mitochondrion', 100, 700);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name: 'diagram.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

// ---- scenario ----------------------------------------------------------

try {
  const mac = await device('mac', { viewport: { width: 1280, height: 800 } });
  const { page: A } = mac;

  // 1. Create class + lecture through the dialogs.
  await A.click('text=+ Add your first class');
  await answerDialog(A, 'Biology');
  await answerDialog(A, 'Lecture 1');
  const created = await A.waitForSelector('.lecture-link:has-text("Lecture 1")', { timeout: 5000 }).then(() => true, () => false);
  check('class and lecture created', created && await A.isVisible('h2:has-text("Biology")'));

  // 2. Card with an image via the editor.
  await A.click('a.lecture-link:has-text("Lecture 1")');
  await A.click('text=+ New card');
  await A.fill('textarea[aria-label=Front]', 'What is the **powerhouse** of the cell?');
  await A.setInputFiles('.side-editor:nth-of-type(1) input[type=file]', await pngFile(A));
  await A.waitForFunction(() => document.querySelector('textarea[aria-label=Front]').value.includes('img:'));
  await A.fill('textarea[aria-label=Back]', 'The mitochondrion');
  const previewHasBold = await A.isVisible('.preview-box strong:has-text("powerhouse")');
  check('markdown preview renders bold', previewHasBold);
  await A.click('button:has-text("Save") >> nth=-1');
  await A.waitForSelector('.card-list li');

  // 3. Bulk paste with one malformed line.
  await A.click('text=Paste cards');
  await A.fill('dialog[open] textarea', 'DNA ;; Deoxyribonucleic acid\nRNA ;; Ribonucleic acid\nthis line has no separator\nATP ;; Adenosine triphosphate');
  const summary = await A.textContent('dialog[open] .muted[aria-live]');
  check('bulk dialog reports the skipped line', /3 cards ready/.test(summary) && /Line 3/.test(summary), summary);
  await A.click('dialog[open] button.primary');
  await A.waitForFunction(() => document.querySelectorAll('.card-list li').length === 4);
  check('4 cards in lecture', true);

  // 4. Without a token nothing is pushed; status says so instead of failing silently.
  await A.goto(`${BASE}#/settings`);
  await A.fill('input[data-key=owner]', 'me');
  await A.fill('input[data-key=repo]', 'cards');
  await A.click('button[type=submit]');
  await A.waitForFunction(() => /token/i.test(document.getElementById('sync-btn').title));
  check('no token: status is "local only" with a reason', await A.$eval('#sync-btn', b => b.dataset.state) === 'local');
  check('no token: nothing written to the repo', fileAt('data/structure.json') === null);

  // 5. Add the token and sync.
  await connect(A);
  const structure = jsonAt('data/structure.json');
  const lectureId = Object.keys(structure?.lectures ?? {})[0];
  const pushed = jsonAt(`data/cards/${lectureId}.json`);
  const imagePaths = git.trees[git.commits[git.ref].tree].filter(e => e.path.startsWith('data/img/'));
  check('sync pushed structure with 1 class / 1 lecture', Object.keys(structure.classes).length === 1 && !!lectureId);
  check('sync pushed 4 cards', Object.keys(pushed).length === 4);
  check('sync pushed the image', imagePaths.length === 1);
  const imgBuf = git.blobs[imagePaths[0].sha];
  const dims = await A.evaluate(async b64 => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/webp;base64,${b64}`)).blob());
    return [bmp.width, bmp.height];
  }, imgBuf.toString('base64'));
  check(`image resized to 1600px edge (got ${dims.join('x')}, ${imgBuf.length} bytes)`, dims[0] === 1600 && dims[1] === 800);
  check('one sync = one commit', git.commits[git.ref].parents.length === 1 && git.commits[git.commits[git.ref].parents[0]].message === 'init');

  // 6. Flip-mode Due review: Again re-queues.
  await A.goto(BASE);
  const reviewBtn = await A.textContent('.lectures a.btn:has-text("Review")');
  check('home shows Review (4)', reviewBtn.includes('(4)'), reviewBtn);
  await A.click('.lectures a.btn:has-text("Review")');
  await A.waitForSelector('.flip-card');
  check('rating buttons hidden before flip', await A.isHidden('.ratings'));
  await A.click('.flip-card');
  await shot(A, 'mac-flip');
  check('flip reveals ratings', await A.isVisible('.ratings'));
  const intervals = await A.$$eval('.ratings small', els => els.map(e => e.textContent));
  check('review buttons preview intervals', intervals.join() === 'repeat,1d,1d,4d', intervals.join());
  const firstFront = await A.textContent('.face.front');
  await A.click('button.rating.again');
  check('counter shows a repeat queued', /1 repeat/.test(await A.textContent('.counter')));
  for (let i = 0; i < 3; i++) {
    await A.keyboard.press('Space');
    await A.keyboard.press('3');
  }
  const lastFront = await A.textContent('.face.front');
  check('the Again card comes back at the end', lastFront === firstFront, `${firstFront} vs ${lastFront}`);
  await A.keyboard.press('Space');
  await A.keyboard.press('3');
  await A.waitForSelector('text=Session complete');
  await A.waitForFunction(() => document.getElementById('sync-btn').dataset.state === 'synced' && document.getElementById('sync-btn').title === 'All changes synced.');
  await A.waitForTimeout(200);
  await waitSynced(A);
  const reviews = jsonAt('data/reviews.json');
  check('4 review states pushed', Object.keys(reviews ?? {}).length === 4, JSON.stringify(reviews));
  // BUG: rating was async, so fast key presses rated the same card repeatedly.
  check('fast key presses rate each card exactly once (all reps=1)', Object.values(reviews ?? {}).every(r => r.reps === 1));
  await A.goto(BASE);
  check('nothing due after review', !(await A.textContent('.lectures a.btn:has-text("Review")')).includes('('));

  // 7. Cram never touches the schedule.
  const reviewsBefore = fileAt('data/reviews.json').toString();
  const localBefore = await A.evaluate(async () => (await import('./js/store.js')).db.reviews);
  await A.click('.lectures a.btn:has-text("Cram")');
  await A.waitForSelector('.flip-card');
  check('cram buttons show no intervals', (await A.$$eval('.ratings small', e => e.map(x => x.textContent))).join() === 'repeat,2,3,4');
  await A.click('.flip-card');
  await A.click('button.rating.again');
  for (let i = 0; i < 5; i++) {
    if (await A.isVisible('text=Session complete')) break;
    await A.click('.flip-card');
    await A.click('button.rating.easy');
  }
  await A.waitForSelector('text=Session complete');
  await A.waitForTimeout(300);
  const localAfter = await A.evaluate(async () => (await import('./js/store.js')).db.reviews);
  check('cram left local review states unchanged', JSON.stringify(localAfter) === JSON.stringify(localBefore));
  check('cram left reviews.json unchanged', fileAt('data/reviews.json').toString() === reviewsBefore);

  // 8. Second device (iPhone viewport) pulls everything, including the image.
  const phone = await device('phone', { ...devices['iPhone 13'], browserName: undefined, defaultBrowserType: undefined });
  const { page: B } = phone;
  await connect(B);
  await B.goto(BASE);
  check('phone sees the class from the Mac', await B.isVisible('h2:has-text("Biology")'));
  check('phone has no horizontal scroll', await B.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await B.click('a.lecture-link:has-text("Lecture 1")');
  await B.waitForSelector('.card-list li');
  await B.waitForFunction(() => [...document.querySelectorAll('.card-list img')].some(i => i.src.startsWith('blob:') && i.naturalWidth > 0), null, { timeout: 5000 });
  check('phone shows the image pulled from the repo', true);

  // 9. Type mode on the phone (cram so all cards appear).
  await B.goto(BASE);
  await B.click('button:has-text("Type answer")');
  await B.click('.lectures a.btn:has-text("Cram")');
  await B.waitForSelector('.answer-input');
  check('type mode hides ratings until checked', await B.isHidden('.ratings'));
  await B.fill('.answer-input', 'my guess');
  await B.press('.answer-input', 'Enter');
  check('type mode compares your answer with the card', (await B.textContent('.answer.yours')).includes('my guess') && await B.isVisible('.answer.correct'));
  check('ratings visible after check', await B.isVisible('.ratings'));
  await shot(B, 'phone-type');

  // 10. Concurrent edits on both devices: different cards both survive,
  // and a delete on one device wins over an older edit.
  const cardIds = Object.keys(pushed);
  const { db: _ } = {};
  const editOn = (page, id, back) => page.evaluate(async ([lid, cid, back]) => {
    const s = await import('./js/store.js');
    const c = s.db.cards[lid][cid];
    await s.saveCard(lid, { id: cid, front: c.front, back });
  }, [lectureId, id, back]);
  await editOn(A, cardIds[1], 'edited on mac');
  await editOn(B, cardIds[2], 'edited on phone');
  await B.evaluate(async ([lid, cid]) => (await import('./js/store.js')).deleteCard(lid, cid), [lectureId, cardIds[3]]);
  await syncNow(A);
  // The phone's push is now behind; force a fast-forward rejection once to
  // exercise the re-pull-and-retry path as well.
  rejectNextRefUpdate = true;
  const stB = await syncNow(B);
  check('phone sync succeeds after a rejected ref update', stB.state === 'synced', stB.title);
  await syncNow(A);
  const final = jsonAt(`data/cards/${lectureId}.json`);
  check('mac edit survived', final[cardIds[1]].back === 'edited on mac');
  check('phone edit survived', final[cardIds[2]].back === 'edited on phone');
  check('phone delete is a tombstone in the repo', final[cardIds[3]].deleted === true);
  const macCards = await A.evaluate(async lid => (await import('./js/store.js')).cardsOf(lid).map(c => c.id), lectureId);
  check('mac sees the delete and the phone edit', macCards.length === 3 && !macCards.includes(cardIds[3]));

  // 11. Offline: after the service worker caches the shell, the app opens
  // with no network and shows local data.
  await A.goto(BASE);
  await A.evaluate(() => navigator.serviceWorker.ready);
  await A.reload();
  await A.waitForFunction(() => !!navigator.serviceWorker.controller);
  await mac.ctx.setOffline(true);
  await A.reload();
  await A.waitForSelector('h2:has-text("Biology")', { timeout: 5000 });
  check('app opens offline with local data', true);
  await A.click('a.lecture-link:has-text("Lecture 1")');
  await A.click('text=+ New card');
  await A.fill('textarea[aria-label=Front]', 'offline q');
  await A.fill('textarea[aria-label=Back]', 'offline a');
  await A.click('button.primary:has-text("Save")');
  await A.click('#sync-btn');
  await A.waitForFunction(() => document.getElementById('sync-btn').dataset.state === 'offline');
  check('offline edit queued with offline status', true);
  await mac.ctx.setOffline(false);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitSynced(A);
  check('offline edit pushed once back online', Object.values(jsonAt(`data/cards/${lectureId}.json`)).some(c => c.front === 'offline q'));

  for (const d of [mac, phone]) {
    const errs = d.errors.filter(e => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e));
    check(`${d.name}: no console errors`, errs.length === 0, errs.join(' | '));
  }
  if (process.env.SHOT_DIR) {
    await A.goto(BASE);
    await A.screenshot({ path: `${process.env.SHOT_DIR}/mac-home.png` });
    await B.goto(BASE);
    await B.screenshot({ path: `${process.env.SHOT_DIR}/phone-home.png` });
  }
} catch (e) {
  console.error(e);
  for (const p of browser.contexts().flatMap(c => c.pages())) console.error('page errors:', await p.evaluate(() => document.title).catch(() => '?'));
  results.push({ label: 'scenario threw', ok: false });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
