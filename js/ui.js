// DOM helpers. Everything user-typed goes in through text nodes, never
// innerHTML — markdown is the only HTML path, and it is sanitized.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// Modal built on <dialog>. Resolves with the value passed to close(), or
// null when dismissed with Escape or the backdrop.
export function modal(build) {
  return new Promise(resolve => {
    const dlg = h('dialog', { class: 'modal' });
    const close = value => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.append(...[build(close)].flat());
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(null); });
    dlg.addEventListener('click', e => { if (e.target === dlg) close(null); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[autofocus]')?.focus();
  });
}

export function askText(title, { value = '', placeholder = '', ok = 'Save' } = {}) {
  return modal(close => {
    const input = h('input', { type: 'text', value, placeholder, autofocus: true, required: true, maxlength: 120 });
    return h('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); const v = input.value.trim(); if (v) close(v); } },
      h('h2', {}, title),
      input,
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => close(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, ok)));
  });
}

export function confirmDialog(title, body, { ok = 'Delete', danger = true } = {}) {
  return modal(close => h('div', {},
    h('h2', {}, title),
    body && h('p', { class: 'muted' }, body),
    h('div', { class: 'row end' },
      h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, autofocus: true, onclick: () => close(true) }, ok))));
}

// Action sheet: a list of labelled actions; resolves with the chosen key.
export function actionSheet(title, actions) {
  return modal(close => h('div', { class: 'sheet' },
    h('h2', {}, title),
    actions.map(a => h('button', { class: `btn block ${a.danger ? 'danger-text' : 'ghost'}`, disabled: a.disabled, onclick: () => close(a.key) }, a.label)),
    h('button', { class: 'btn block', onclick: () => close(null) }, 'Cancel')));
}

let toastTimer;
export function toast(message, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 6000 : 2500);
}
