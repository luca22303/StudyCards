// Parses pasted text into cards, one card per line, in either form:
//   front ;; back          typed by hand
//   front<TAB>back         two columns copied from Excel, Numbers or Sheets
// A line containing ";;" uses it; otherwise a tab splits it. With tabs, any
// further columns (an example sentence, a note) are appended to the back on
// their own lines, so a three-column vocabulary sheet keeps its third column.
//
// Lines without a separator are not silently dropped — they come back in
// `skipped` with their line number, so the dialog can show what was ignored.
// A literal "\n" inside a side becomes a line break, so a multi-line answer
// still fits on one pasted line. (Spreadsheet cells that themselves contain
// line breaks arrive split across lines and are reported as skipped.)

export const SEPARATOR = ';;';

export function parseBulk(text) {
  const cards = [];
  const skipped = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    // Checked before trimming: trim() would eat a leading tab and turn an
    // empty first column into "no separator" instead of "front is empty".
    if (!raw.trim()) return;
    const line = raw.trim();
    let front, back;
    const at = line.indexOf(SEPARATOR);
    if (at !== -1) {
      front = line.slice(0, at);
      back = line.slice(at + SEPARATOR.length);
    } else if (raw.includes('\t')) {
      const [first, ...rest] = raw.split('\t').map(c => c.trim());
      front = first;
      back = rest.filter(Boolean).join('\n');
    } else {
      skipped.push({ line: i + 1, text: line, reason: `no "${SEPARATOR}" or tab separator` });
      return;
    }
    front = unescape(front.trim());
    back = unescape(back.trim());
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
