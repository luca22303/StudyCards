// Record-level merge used when two devices have both changed data.
//
// Every record (class, lecture, card, review state) carries `updatedAt`
// (ms since epoch). Deletion is a tombstone — the record stays with
// `deleted: true` and a fresh updatedAt — because a missing key cannot be
// told apart from "the other device has not seen it yet", and would let a
// deleted card come back from the other device on the next sync.

// Newer updatedAt wins. On an exact tie the remote copy wins, so two devices
// converge on the same value instead of each keeping its own.
export function pickNewer(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  return (local.updatedAt ?? 0) > (remote.updatedAt ?? 0) ? local : remote;
}

// Merge two id->record maps. Returns { merged, localChanged, remoteChanged }:
// localChanged — the merge took something from remote (local must be updated);
// remoteChanged — local has something remote lacks (remote must be pushed).
export function mergeMaps(local = {}, remote = {}) {
  const merged = {};
  let localChanged = false, remoteChanged = false;
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const id of ids) {
    const winner = pickNewer(local[id], remote[id]);
    merged[id] = winner;
    if (winner !== local[id] && !sameRecord(winner, local[id])) localChanged = true;
    if (winner !== remote[id] && !sameRecord(winner, remote[id])) remoteChanged = true;
  }
  return { merged, localChanged, remoteChanged };
}

function sameRecord(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Stable JSON for files written to the repo: sorted keys, so an unchanged
// file produces byte-identical content and git diffs stay readable.
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 1) + '\n';
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function live(map) {
  return Object.values(map ?? {}).filter(r => r && !r.deleted);
}
