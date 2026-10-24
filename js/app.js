// UI: hash router and the four screens (home, lecture, card editor, study)
// plus settings.

import * as store from './store.js';
import { db } from './store.js';
import { sync, requestSync, onStatus, repoConfig, getStatus, detectedBranch, resetDetectedBranch } from './sync.js';
import { renderMarkdown } from './render.js';
import { importImage } from './images.js';
import { schedule, previewIntervals, formatInterval, stats, introducedOn, RATINGS } from './lib/srs.js';
import { createSession, current, isDone, rate, pickReviewCards } from './lib/session.js';
import { parseBulk, SEPARATOR } from './lib/bulk.js';
import { localDay, shuffle } from './lib/util.js';
import { h, clear, askText, confirmDialog, actionSheet, toast, modal } from './ui.js';

const main = document.getElementById('main');
const RATING_LABELS = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

// ---- routing -----------------------------------------------------------

const routes = [
  [/^#?\/?$/, renderHome],
  [/^#\/class\/([\w-]+)$/, renderClass],
  [/^#\/lecture\/([\w-]+)$/, renderLecture],
  [/^#\/edit\/([\w-]+)(?:\/([\w-]+))?$/, renderEditor],
  [/^#\/study\/(review|cram)\/(class|lecture)\/([\w-]+)$/, renderStudy],
  [/^#\/settings$/, renderSettings],
];

// Screens register a cleanup (e.g. a keyboard handler) that runs on leave.
let cleanup = null;

function route() {
  cleanup?.();
  cleanup = null;
  const hash = location.hash || '#/';
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      clear(main);
      view(...m.slice(1));
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// Re-render list screens when data changes underneath them (e.g. a sync
// pulled cards from the other device). The study screen is left alone so a
// running session is never reset mid-card.
function refreshIfPassive() {
  const hash = location.hash || '#/';
  if (hash === '#/' || hash === '' || hash.startsWith('#/class/') || hash.startsWith('#/lecture/')) route();
}

// ---- header ------------------------------------------------------------

function initHeader() {
  const btn = document.getElementById('sync-btn');
  btn.addEventListener('click', () => {
    const st = getStatus();
    if (st.state === 'error' || st.state === 'local') toast(st.message, st.state === 'error' ? 'error' : '');
    sync();
  });
  onStatus(updateSyncIndicator);
  store.onChange(kind => {
    if (kind !== 'settings') updateSyncIndicator(getStatus());
  });
}

function updateSyncIndicator(st) {
  const btn = document.getElementById('sync-btn');
  const pending = store.dirtyCount();
  let state = st.state;
  // "synced" from the last run is stale the moment a new local edit lands.
  if (state === 'synced' && pending) state = 'pending';
  btn.dataset.state = state;
  const labels = {
    idle: 'Sync',
    syncing: 'Syncing…',
    synced: 'Synced',
    pending: 'Unsynced',
    local: 'Local only',
    offline: 'Offline',
    error: 'Sync error',
  };
  btn.querySelector('.label').textContent = labels[state] ?? 'Sync';
  btn.title = st.message || labels[state];
}

// ---- home --------------------------------------------------------------

function statLine(cards) {
  const s = stats(cards, db.reviews, localDay());
  return h('div', { class: 'stats' },
    h('span', {}, `${s.total} card${s.total === 1 ? '' : 's'}`),
    h('span', { class: s.due ? 'due' : '' }, `${s.due} due`),
    h('span', {}, `${s.new} new`),
    h('span', {}, `${s.masteredPct}% mastered`));
}

function studyButtons(scope, id, cards) {
  const today = localDay();
  const newLeft = Math.max(0, db.settings.newPerDay - introducedOn(db.reviews, today));
  const pick = pickReviewCards(cards, db.reviews, today, newLeft);
  const n = pick.due.length + pick.fresh.length;
  return h('div', { class: 'row' },
    h('a', { class: `btn small ${n ? 'primary' : ''}`, href: `#/study/review/${scope}/${id}`, 'aria-disabled': n ? null : 'true' }, `Review${n ? ` (${n})` : ''}`),
    h('a', { class: 'btn small', href: `#/study/cram/${scope}/${id}`, 'aria-disabled': cards.length ? null : 'true' }, 'Cram'));
}

function modeToggle() {
  const mode = db.settings.studyMode;
  const set = m => async () => { await store.saveSettings({ studyMode: m }); route(); };
  return h('div', { class: 'segmented', role: 'group', 'aria-label': 'Study mode' },
    h('button', { class: mode === 'flip' ? 'on' : '', 'aria-pressed': String(mode === 'flip'), onclick: set('flip') }, 'Flip cards'),
    h('button', { class: mode === 'type' ? 'on' : '', 'aria-pressed': String(mode === 'type'), onclick: set('type') }, 'Type answer'));
}

function renderHome() {
  document.title = 'StudyCards';
  const list = store.classes();
  main.append(
    h('div', { class: 'toolbar' }, h('h1', {}, 'Classes'), modeToggle()),
  );
  if (!list.length) {
    main.append(h('div', { class: 'empty' },
      h('p', {}, 'No classes yet. A class holds your cards; you can split it into lectures if you like.'),
      h('button', { class: 'btn primary', onclick: addClass }, '+ Add your first class')));
    return;
  }
  for (const c of list) {
    const lectures = store.lecturesOf(c.id);
    const allCards = store.cardsOfClass(c.id);
    main.append(h('section', { class: 'class-block' },
      h('div', { class: 'class-head' },
        h('div', {},
          h('h2', {}, h('a', { class: 'class-link', href: `#/class/${c.id}` }, c.name)),
          statLine(allCards)),
        h('div', { class: 'row' },
          studyButtons('class', c.id, allCards),
          h('button', { class: 'btn icon', 'aria-label': `Options for ${c.name}`, onclick: () => classMenu(c) }, '⋯'))),
      lectures.length ? lectureList(lectures) : null));
  }
  main.append(h('div', { class: 'row center' }, h('button', { class: 'btn', onclick: addClass }, '+ Class')));
}

async function addClass() {
  const name = await askText('New class', { placeholder: 'e.g. Biology', ok: 'Add' });
  if (!name) return;
  const id = await store.addClass(name);
  go(`#/class/${id}`);
}

async function addLecture(classId) {
  const name = await askText('New lecture', { placeholder: 'e.g. Lecture 3 – Cell membranes', ok: 'Add' });
  if (!name) return;
  const id = await store.addLecture(classId, name);
  go(`#/lecture/${id}`);
}

async function classMenu(c) {
  const siblings = store.classes();
  const i = siblings.findIndex(x => x.id === c.id);
  const key = await actionSheet(c.name, [
    { key: 'lecture', label: '+ Add lecture' },
    { key: 'rename', label: 'Rename' },
    { key: 'up', label: 'Move up', disabled: i === 0 },
    { key: 'down', label: 'Move down', disabled: i === siblings.length - 1 },
    { key: 'delete', label: 'Delete class', danger: true },
  ]);
  if (key === 'lecture') return addLecture(c.id);
  if (key === 'rename') {
    const name = await askText('Rename class', { value: c.name });
    if (name) await store.rename('class', c.id, name);
  }
  if (key === 'up' || key === 'down') await store.move('class', c.id, key === 'up' ? -1 : 1);
  if (key === 'delete') {
    const n = store.cardsOfClass(c.id).length;
    if (await confirmDialog(`Delete “${c.name}”?`, `This deletes ${n} card(s)${store.lecturesOf(c.id).length ? ` in ${store.lecturesOf(c.id).length} lecture(s)` : ''}, on all your devices.`)) {
      await store.deleteClass(c.id);
      return go('#/');
    }
  }
  route();
}

function lectureList(lectures) {
  return h('ul', { class: 'lectures' }, lectures.map(l => {
    const cards = store.cardsOf(l.id);
    return h('li', {},
      h('a', { class: 'lecture-link', href: `#/lecture/${l.id}` },
        h('span', { class: 'name' }, l.name),
        statLine(cards)),
      studyButtons('lecture', l.id, cards));
  }));
}

// ---- class -------------------------------------------------------------

// A class is the main place for cards. Lectures are optional sections; cards
// added here go into the class's hidden default lecture (see store.js).
function renderClass(classId) {
  const cls = store.getClass(classId);
  if (!cls) return go('#/');
  document.title = `${cls.name} – StudyCards`;
  const all = store.cardsOfClass(classId);
  const direct = store.directCardsOf(classId);
  const lectures = store.lecturesOf(classId);
  const toDefault = fn => async () => fn(await store.ensureDefaultLecture(classId));

  main.append(
    h('a', { class: 'back', href: '#/' }, '‹ Classes'),
    h('div', { class: 'toolbar' },
      h('div', {}, h('h1', {}, cls.name), statLine(all)),
      h('button', { class: 'btn icon', 'aria-label': 'Class options', onclick: () => classMenu(cls) }, '⋯')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', onclick: toDefault(id => go(`#/edit/${id}`)) }, '+ New card'),
      h('button', { class: 'btn', onclick: toDefault(id => bulkDialog(id)) }, 'Paste cards'),
      studyButtons('class', classId, all)),
  );

  if (lectures.length) {
    main.append(
      h('div', { class: 'section-head' }, h('h2', {}, 'Lectures'),
        h('button', { class: 'btn ghost small', onclick: () => addLecture(classId) }, '+ Lecture')),
      h('section', { class: 'class-block' }, lectureList(lectures)));
  }
  if (lectures.length && direct.length) main.append(h('div', { class: 'section-head' }, h('h2', {}, 'Cards')));
  if (direct.length) main.append(cardList(direct));
  else if (!lectures.length) {
    main.append(h('div', { class: 'empty' },
      h('p', {}, 'No cards yet. Add them one by one, or paste a list.'),
      h('button', { class: 'btn ghost small', onclick: () => addLecture(classId) }, 'or split this class into lectures')));
  }
}

function cardList(cards) {
  const today = localDay();
  return h('ul', { class: 'card-list' }, cards.map(c => {
    const st = db.reviews[c.id];
    const front = h('div', { class: 'md preview' });
    const back = h('div', { class: 'md preview muted' });
    renderMarkdown(front, c.front);
    renderMarkdown(back, c.back);
    const badge = !st ? 'new' : st.due <= today ? 'due' : `in ${formatInterval(daysBetween(today, st.due))}`;
    return h('li', {},
      h('a', { href: `#/edit/${c.lectureId}/${c.id}` }, front, back,
        h('span', { class: `badge ${!st ? 'new' : st.due <= today ? 'due' : ''}` }, badge)));
  }));
}

// ---- lecture -----------------------------------------------------------

function renderLecture(lectureId) {
  const lecture = store.getLecture(lectureId);
  if (!lecture) return go('#/');
  const cls = store.getClass(lecture.classId);
  document.title = `${lecture.name} – StudyCards`;
  const cards = store.cardsOf(lectureId);

  main.append(
    h('a', { class: 'back', href: cls ? `#/class/${cls.id}` : '#/' }, `‹ ${cls?.name ?? 'Home'}`),
    h('div', { class: 'toolbar' },
      h('div', {}, h('h1', {}, lecture.name), statLine(cards)),
      h('button', { class: 'btn icon', 'aria-label': 'Lecture options', onclick: () => lectureMenu(lecture) }, '⋯')),
    h('div', { class: 'row wrap' },
      h('a', { class: 'btn primary', href: `#/edit/${lectureId}` }, '+ New card'),
      h('button', { class: 'btn', onclick: () => bulkDialog(lectureId) }, 'Paste cards'),
      studyButtons('lecture', lectureId, cards)),
  );

  if (!cards.length) {
    main.append(h('div', { class: 'empty' }, h('p', {}, 'No cards in this lecture yet.')));
    return;
  }
  main.append(cardList(cards));
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00`) - new Date(`${a}T12:00`)) / 86400000);
}

async function lectureMenu(l) {
  const siblings = store.lecturesOf(l.classId);
  const i = siblings.findIndex(x => x.id === l.id);
  const key = await actionSheet(l.name, [
    { key: 'rename', label: 'Rename' },
    { key: 'up', label: 'Move up', disabled: i === 0 },
    { key: 'down', label: 'Move down', disabled: i === siblings.length - 1 },
    { key: 'delete', label: 'Delete lecture', danger: true },
  ]);
  if (key === 'rename') {
    const name = await askText('Rename lecture', { value: l.name });
    if (name) await store.rename('lecture', l.id, name);
  }
  if (key === 'up' || key === 'down') await store.move('lecture', l.id, key === 'up' ? -1 : 1);
  if (key === 'delete') {
    const n = store.cardsOf(l.id).length;
    if (await confirmDialog(`Delete “${l.name}”?`, `This deletes ${n} card(s), on all your devices.`)) {
      await store.deleteLecture(l.id);
      return go(`#/class/${l.classId}`);
    }
  }
  route();
}

function bulkDialog(lectureId) {
  return modal(close => {
    const summary = h('p', { class: 'muted', 'aria-live': 'polite' });
    const area = h('textarea', {
      rows: 10,
      autofocus: true,
      placeholder: `What is the powerhouse of the cell? ${SEPARATOR} The mitochondrion\nDNA stands for ${SEPARATOR} Deoxyribonucleic acid`,
      oninput: update,
    });
    const add = h('button', { class: 'btn primary', disabled: true, onclick: submit }, 'Add cards');
    function update() {
      const { cards, skipped } = parseBulk(area.value);
      clear(summary).append(`${cards.length} card${cards.length === 1 ? '' : 's'} ready.`);
      if (skipped.length) {
        summary.append(h('ul', { class: 'skipped' }, skipped.slice(0, 5).map(s => h('li', {}, `Line ${s.line}: ${s.reason}`)),
          skipped.length > 5 && h('li', {}, `…and ${skipped.length - 5} more skipped lines`)));
      }
      add.disabled = !cards.length;
      add.textContent = cards.length ? `Add ${cards.length} card${cards.length === 1 ? '' : 's'}` : 'Add cards';
    }
    async function submit() {
      const { cards, skipped } = parseBulk(area.value);
      await store.addCards(lectureId, cards);
      close(true);
      toast(`Added ${cards.length} cards${skipped.length ? `, skipped ${skipped.length} lines` : ''}.`);
      route();
    }
    return h('div', { class: 'bulk' },
      h('h2', {}, 'Paste cards'),
      h('p', { class: 'muted' }, 'One card per line: front ', h('code', {}, SEPARATOR), ' back, or two columns copied from a spreadsheet (extra columns go on the back). Write ', h('code', {}, '\\n'), ' for a line break.'),
      area, summary,
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'), add));
  });
}

// ---- card editor -------------------------------------------------------

function renderEditor(lectureId, cardId) {
  const lecture = store.getLecture(lectureId);
  if (!lecture) return go('#/');
  // Cards added straight to a class sit in its hidden default lecture; send
  // the user back to the class there, not to a lecture page they never made.
  const home = lecture.isDefault ? `#/class/${lecture.classId}` : `#/lecture/${lectureId}`;
  const homeName = lecture.isDefault ? store.getClass(lecture.classId)?.name ?? 'Back' : lecture.name;
  const card = cardId ? db.cards[lectureId]?.[cardId] : null;
  if (cardId && (!card || card.deleted)) return go(home);
  document.title = `${card ? 'Edit' : 'New'} card – StudyCards`;

  const sides = {};
  function side(key, label, value) {
    const area = h('textarea', { rows: 5, value, placeholder: key === 'front' ? 'Question / term (Markdown)' : 'Answer (Markdown)', 'aria-label': label });
    const preview = h('div', { class: 'md preview-box' });
    const update = () => {
      renderMarkdown(preview, area.value);
      preview.hidden = !area.value.trim();
    };
    area.addEventListener('input', update);
    update();
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      try {
        const id = await importImage(f);
        insertAtCursor(area, `![](img:${id})`);
        update();
      } catch (e) {
        toast(e.message, 'error');
      }
    } });
    sides[key] = area;
    return h('div', { class: 'side-editor' },
      h('div', { class: 'row between' },
        h('label', {}, label),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => file.click() }, '+ Image'), file),
      area, preview);
  }

  async function save(andNew) {
    const front = sides.front.value.trim();
    const back = sides.back.value.trim();
    if (!front || !back) {
      toast('Both sides need some content.', 'error');
      (front ? sides.back : sides.front).focus();
      return;
    }
    await store.saveCard(lectureId, { id: card?.id, front, back });
    if (andNew) {
      toast('Saved.');
      go(`#/edit/${lectureId}`);
    } else go(home);
  }

  async function remove() {
    if (await confirmDialog('Delete this card?', 'It is removed on all your devices.')) {
      await store.deleteCard(lectureId, card.id);
      go(home);
    }
  }

  main.append(
    h('a', { class: 'back', href: home }, `‹ ${homeName}`),
    h('h1', {}, card ? 'Edit card' : 'New card'),
    side('front', 'Front', card?.front ?? ''),
    side('back', 'Back', card?.back ?? ''),
    h('p', { class: 'muted small' }, 'Markdown: **bold**, *italic*, - lists, `code`. ⌘/Ctrl + Enter saves.'),
    h('div', { class: 'row wrap between' },
      card ? h('button', { class: 'btn danger-text ghost', onclick: remove }, 'Delete') : h('span'),
      h('div', { class: 'row' },
        !card && h('button', { class: 'btn', onclick: () => save(true) }, 'Save & new'),
        h('button', { class: 'btn primary', onclick: () => save(false) }, 'Save'))),
  );
  sides.front.focus();

  const onKey = e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save(!card);
    }
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => document.removeEventListener('keydown', onKey);
}

function insertAtCursor(area, text) {
  const { selectionStart: s, selectionEnd: e, value } = area;
  const before = value.slice(0, s);
  const pad = before && !before.endsWith('\n') ? '\n' : '';
  area.value = before + pad + text + '\n' + value.slice(e);
  area.selectionStart = area.selectionEnd = (before + pad + text + '\n').length;
  area.focus();
}

// ---- study -------------------------------------------------------------

function renderStudy(kind, scope, id) {
  const owner = scope === 'class' ? store.getClass(id) : store.getLecture(id);
  if (!owner) return go('#/');
  const cards = scope === 'class' ? store.cardsOfClass(id) : store.cardsOf(id);
  const backHref = scope === 'class' ? `#/class/${id}` : `#/lecture/${id}`;
  const today = localDay();
  document.title = `${kind === 'review' ? 'Review' : 'Cram'}: ${owner.name} – StudyCards`;

  let ids;
  if (kind === 'review') {
    const newLeft = Math.max(0, db.settings.newPerDay - introducedOn(db.reviews, today));
    const pick = pickReviewCards(cards, db.reviews, today, newLeft);
    // Due cards first, then new ones, each shuffled — so a short session
    // still clears the backlog before introducing new material.
    ids = [...shuffle(pick.due.map(c => c.id)), ...shuffle(pick.fresh.map(c => c.id))];
  } else {
    ids = cards.map(c => c.id);
  }

  const header = h('div', { class: 'study-head' },
    h('a', { class: 'back', href: backHref }, '‹ Done'),
    h('div', { class: 'study-title' }, h('strong', {}, owner.name), h('span', { class: 'muted' }, kind === 'review' ? 'Review' : 'Cram')),
    modeToggle());
  main.append(header);

  if (!ids.length) {
    main.append(h('div', { class: 'empty' },
      h('p', {}, kind === 'review' ? 'Nothing due right now. 🎉' : 'No cards here yet.'),
      kind === 'review' && cards.length ? h('a', { class: 'btn primary', href: `#/study/cram/${scope}/${id}` }, 'Cram all cards anyway') : null,
      h('a', { class: 'btn', href: backHref }, 'Back')));
    return;
  }

  // Review keeps the due-then-new order built above; cram is fully shuffled.
  let session = createSession(ids);
  if (kind === 'review') session = { ...session, queue: ids };
  const mode = db.settings.studyMode;
  const progress = h('div', { class: 'progress' }, h('div', { class: 'bar' }));
  const counter = h('div', { class: 'counter muted' });
  const stage = h('div', { class: 'stage' });
  main.append(progress, counter, stage);

  let revealed = false;

  function show() {
    clear(stage);
    revealed = false;
    const pct = session.total ? (session.finished / session.total) * 100 : 0;
    progress.firstChild.style.width = `${pct}%`;
    const again = session.ratings.again;
    counter.textContent = `${session.finished} / ${session.total} done${again ? ` · ${again} repeat${again === 1 ? '' : 's'}` : ''}`;
    if (isDone(session)) return finish();

    const cardId = current(session);
    const found = store.findCard(cardId);
    if (!found) {
      // Deleted on another device mid-session.
      session = { ...session, queue: session.queue.slice(1), total: session.total - 1 };
      return show();
    }
    const card = found.card;
    const front = h('div', { class: 'face front md' });
    const back = h('div', { class: 'face back md' });
    renderMarkdown(front, card.front);
    renderMarkdown(back, card.back);
    const flipCard = h('div', { class: 'flip-card', tabindex: 0, role: 'button', 'aria-label': 'Card. Tap to flip.' },
      h('div', { class: 'flip-inner' }, front, back));
    const ratingBar = h('div', { class: 'ratings', hidden: true }, ratingButtons(cardId));

    if (mode === 'flip') {
      const hint = h('p', { class: 'hint muted' }, 'Tap the card or press Space to flip');
      const flip = () => {
        if (revealed) {
          flipCard.classList.toggle('flipped');
          return;
        }
        reveal();
      };
      flipCard.addEventListener('click', e => { if (!e.target.closest('a')) flip(); });
      stage.append(flipCard, hint, ratingBar);
      stage.reveal = () => {
        revealed = true;
        flipCard.classList.add('flipped');
        hint.remove();
        ratingBar.hidden = false;
      };
    } else {
      const input = h('textarea', { class: 'answer-input', rows: 3, placeholder: 'Type your answer…', 'aria-label': 'Your answer', autocapitalize: 'off' });
      const check = h('button', { class: 'btn primary block', onclick: () => reveal() }, 'Check answer');
      const compare = h('div', { class: 'compare', hidden: true });
      input.addEventListener('keydown', e => {
        // Enter checks; Shift+Enter inserts a line break for multi-line answers.
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          reveal();
        }
      });
      stage.append(h('div', { class: 'flip-card static' }, front), input, check, compare, ratingBar);
      stage.reveal = () => {
        revealed = true;
        const yours = input.value.trim();
        input.hidden = true;
        check.hidden = true;
        clear(compare).append(
          h('div', { class: 'answer yours' }, h('div', { class: 'label' }, 'Your answer'),
            yours ? h('div', { class: 'text' }, yours) : h('div', { class: 'text muted' }, '(no answer)')),
          h('div', { class: 'answer correct' }, h('div', { class: 'label' }, 'Card'), back));
        compare.hidden = false;
        ratingBar.hidden = false;
        ratingBar.querySelector('[data-rating="good"]')?.focus({ preventScroll: true });
      };
      input.focus();
    }
  }

  function reveal() {
    if (!revealed) stage.reveal?.();
  }

  function ratingButtons(cardId) {
    const preview = kind === 'review' ? previewIntervals(db.reviews[cardId], today) : null;
    return RATINGS.map((r, i) => h('button', {
      class: `btn rating ${r}`,
      dataset: { rating: r },
      onclick: () => onRate(r),
    }, h('span', {}, RATING_LABELS[r]),
      h('small', {}, preview ? (r === 'again' ? 'repeat' : formatInterval(preview[r])) : (r === 'again' ? 'repeat' : `${i + 1}`))));
  }

  function onRate(r) {
    if (!revealed) return;
    // Advance synchronously, before the write: with the await first, a quick
    // second key press or double tap rated the same card again (measured: one
    // card reached reps=3 from three fast presses).
    revealed = false;
    const cardId = current(session);
    const next = kind === 'review' ? schedule(db.reviews[cardId], r, today) : null;
    session = rate(session, r);
    show();
    // Cram never touches the schedule — only a Due review does.
    if (next) store.recordReview(cardId, next).catch(e => toast(`Could not save review: ${e.message}`, 'error'));
  }

  function finish() {
    const r = session.ratings;
    stage.append(h('div', { class: 'done' },
      h('h2', {}, 'Session complete'),
      h('p', {}, `${session.total} card${session.total === 1 ? '' : 's'} · ${r.again} repeat${r.again === 1 ? '' : 's'}`),
      h('div', { class: 'tally' }, RATINGS.map(k => h('div', { class: `tally-item ${k}` }, h('strong', {}, r[k]), h('span', {}, RATING_LABELS[k])))),
      h('div', { class: 'row center wrap' },
        h('a', { class: 'btn', href: backHref }, 'Back'),
        h('button', { class: 'btn primary', onclick: () => go(`#/study/cram/${scope}/${id}`) }, 'Cram again'))));
    sync();
  }

  const onKey = e => {
    if (e.target.matches?.('textarea, input')) return;
    if (e.key === ' ' || e.key === 'Enter') {
      if (!revealed || mode === 'flip') {
        e.preventDefault();
        if (!revealed) reveal();
        else stage.querySelector('.flip-card')?.classList.toggle('flipped');
      }
    }
    const n = Number(e.key);
    if (revealed && n >= 1 && n <= 4) onRate(RATINGS[n - 1]);
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => document.removeEventListener('keydown', onKey);
  show();
}

// ---- settings ----------------------------------------------------------

function renderSettings() {
  document.title = 'Settings – StudyCards';
  const auto = repoConfig();
  const s = db.settings;
  const field = (label, key, props = {}, help) => h('label', { class: 'field' },
    h('span', {}, label),
    h('input', { value: s[key] ?? '', ...props, 'data-key': key }),
    help && h('small', { class: 'muted' }, help));
  const statusEl = h('p', { class: 'muted', 'aria-live': 'polite' });
  const off = onStatus(st => {
    statusEl.textContent = `${st.message || st.state}${db.meta.lastSync ? ` Last sync: ${new Date(db.meta.lastSync).toLocaleString()}.` : ''}`;
  });
  cleanup = off;

  const form = h('form', { class: 'settings', onsubmit: async e => {
    e.preventDefault();
    const patch = {};
    for (const input of form.querySelectorAll('input[data-key]')) {
      patch[input.dataset.key] = input.type === 'number' ? Math.max(0, Number(input.value) || 0) : input.value.trim();
    }
    const repoChanged = patch.owner !== s.owner || patch.repo !== s.repo || patch.branch !== s.branch;
    if (repoChanged) {
      // A different repo means our record of "what the remote has" is wrong.
      db.meta.headSha = null;
      db.meta.treeSha = null;
      db.meta.remoteShas = {};
      resetDetectedBranch();
      await store.saveMeta();
    }
    await store.saveSettings(patch);
    toast('Settings saved.');
    sync();
  } },
    h('a', { class: 'back', href: '#/' }, '‹ Home'),
    h('h1', {}, 'Settings'),
    h('h2', {}, 'GitHub sync'),
    h('p', { class: 'muted' }, 'Your cards are stored as files in a GitHub repository, so they appear on every device. Reading works without a token, because the repository is public. To upload changes, create a ',
      h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'fine-grained token'),
      ' that has access to this one repository only, with Contents set to Read and write. Paste it once on each device. It is kept on this device only.'),
    field('Owner', 'owner', { placeholder: auto.owner || 'your GitHub username', autocapitalize: 'off', autocomplete: 'off' }),
    field('Repository', 'repo', { placeholder: auto.repo || 'StudyCards', autocapitalize: 'off', autocomplete: 'off' }),
    field('Branch', 'branch', { placeholder: detectedBranch() || 'default branch', autocapitalize: 'off', autocomplete: 'off' }, 'Leave empty to use the repository’s default branch.'),
    field('Token', 'token', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' }),
    statusEl,
    h('h2', {}, 'Study'),
    field('New cards per day', 'newPerDay', { type: 'number', min: 0, max: 999, inputmode: 'numeric' }, 'The most never-studied cards that a Due review introduces per day, across all classes.'),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: () => sync() }, 'Sync now')),
    h('h2', {}, 'Backup'),
    h('p', { class: 'muted' }, 'Download all cards and your study progress as a JSON file. Images are not included; they stay in the repository.'),
    h('button', { class: 'btn', type: 'button', onclick: downloadExport }, 'Export JSON'));
  main.append(form);
}

function downloadExport() {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `studycards-${localDay()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- boot --------------------------------------------------------------

async function boot() {
  try {
    await store.load();
  } catch (e) {
    main.append(h('div', { class: 'empty' }, h('p', {}, `Could not open local storage: ${e.message}. Private browsing can block it.`)));
    return;
  }
  initHeader();
  store.onChange(kind => {
    if (kind === 'dirty') requestSync();
    if (kind === 'structure' || kind === 'cards') refreshIfPassive();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => {
    // Coming back to the app (e.g. after studying on the other device):
    // pull, but not more than once a minute.
    if (document.visibilityState === 'visible' && Date.now() - (db.meta.lastSync ?? 0) > 60_000) sync();
  });
  // A sync that pulled new data from the other device re-renders list
  // screens (never a running study session). Any finished state counts, not
  // just "synced": a device without a token ends every sync as "local", and
  // checking for "synced" left it showing a stale list after a real pull.
  let seenHead = db.meta.headSha;
  onStatus(st => {
    if (st.state !== 'syncing' && db.meta.headSha !== seenHead) {
      seenHead = db.meta.headSha;
      refreshIfPassive();
    }
  });
  route();
  sync();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

boot();
