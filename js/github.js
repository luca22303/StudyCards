// Minimal GitHub REST client for the Git Data API.
//
// Sync uses blobs/trees/commits/refs rather than the Contents API because it
// turns one sync into exactly one commit, however many files changed, and the
// final ref update is a compare-and-swap: if the other device pushed in
// between, GitHub refuses the fast-forward and sync re-pulls instead of
// overwriting it.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class ConflictError extends Error {}

export function client({ owner, repo, token }) {
  async function request(method, path, body) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(`${API}/repos/${owner}/${repo}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        // GitHub sends max-age=60 on unauthenticated reads; a cached head
        // commit would make the app think nothing changed remotely.
        cache: 'no-store',
      });
    } catch {
      throw new GitHubError(0, 'Network error — are you offline?');
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let detail = '';
    try { detail = (await res.json()).message ?? ''; } catch { /* body was not JSON */ }
    throw new GitHubError(res.status, explain(res.status, detail, !!token));
  }

  return {
    repoInfo: () => request('GET', ''),
    // Returns null for a branch that does not exist or an empty repository.
    async head(branch) {
      try {
        const c = await request('GET', `/commits/${encodeURIComponent(branch)}`);
        return { sha: c.sha, treeSha: c.commit.tree.sha };
      } catch (e) {
        if (e.status === 404 || e.status === 409 || e.status === 422) return null;
        throw e;
      }
    },
    tree: sha => request('GET', `/git/trees/${sha}?recursive=1`),
    blob: sha => request('GET', `/git/blobs/${sha}`),
    createBlob: base64 => request('POST', '/git/blobs', { content: base64, encoding: 'base64' }),
    createTree: (baseTree, tree) => request('POST', '/git/trees', baseTree ? { base_tree: baseTree, tree } : { tree }),
    createCommit: (message, tree, parents) => request('POST', '/git/commits', { message, tree, parents }),
    async updateRef(branch, sha) {
      try {
        return await request('PATCH', `/git/refs/heads/${branch}`, { sha, force: false });
      } catch (e) {
        // 422 "Update is not a fast forward": someone else pushed first.
        if (e.status === 422) throw new ConflictError('Remote changed during sync');
        throw e;
      }
    },
    rawUrl: (ref, path) => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
  };
}

function explain(status, detail, hasToken) {
  if (status === 401) return 'GitHub rejected the token. Check it in Settings.';
  if (status === 403 && /rate limit/i.test(detail)) {
    return hasToken ? 'GitHub rate limit reached. Try again later.' : 'GitHub rate limit reached. Adding a token in Settings raises it.';
  }
  if (status === 403) return `GitHub refused the request: ${detail || 'the token lacks permission'}. The token needs Contents: Read and write on this repository.`;
  if (status === 404) return hasToken ? 'Repository not found, or the token has no access to it.' : 'Repository not found. Check owner and name in Settings.';
  return `GitHub error ${status}${detail ? `: ${detail}` : ''}`;
}
