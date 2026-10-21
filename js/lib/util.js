// Small helpers shared by the browser app and the Node unit tests.
// Nothing in js/lib/ may touch the DOM or IndexedDB, so it stays testable
// with plain `node --test`.

// Local calendar day as YYYY-MM-DD. Scheduling is day-granular on purpose:
// "due today" should mean the user's today, not a UTC boundary that falls
// mid-afternoon for someone in Europe.
export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  // Noon avoids DST transitions shifting the result by a day.
  return localDay(new Date(y, m - 1, d + n, 12));
}

export function newId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

// Fisher–Yates; `rand` is injectable so tests can be deterministic.
export function shuffle(list, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// UTF-8 safe base64. btoa/atob only handle Latin-1, so German umlauts in a
// card would throw without going through bytes.
export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToText(b64) {
  return new TextDecoder().decode(base64ToBytes(b64));
}
