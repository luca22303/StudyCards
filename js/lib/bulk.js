// Parses pasted text into cards: one card per line, "front ;; back".
//
// Lines without a separator are not silently dropped — they come back in
// `skipped` with their line number, so the dialog can show what was ignored.
// A literal "\n" inside a side becomes a line break, so a multi-line answer
// still fits on one pasted line.

export const SEPARATOR = ';;';

export function parseBulk(text) {
  const cards = [];
  const skipped = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const at = line.indexOf(SEPARATOR);
    if (at === -1) {
      skipped.push({ line: i + 1, text: line, reason: `no "${SEPARATOR}" separator` });
      return;
    }
    const front = unescape(line.slice(0, at).trim());
    const back = unescape(line.slice(at + SEPARATOR.length).trim());
    if (!front || !back) {
      skipped.push({ line: i + 1, text: line, reason: !front ? 'front is empty' : 'back is empty' });
      return;
    }
    cards.push({ front, back });
  });
  return { cards, skipped };
}

function unescape(s) {
  return s.replace(/\\n/g, '\n');
}
