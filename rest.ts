/**
 * rest.ts — the REST v3 surface under /api/v3.
 *
 * Every handler returns `{ status, json?, headers? }`; app.ts serializes.
 * Errors are always JSON with a string `message`, as the contract demands.
 * Handlers never throw on bad input: unknown routes and missing objects
 * are 404, validation problems are 422, a stale contents sha is 409.
 */
import { identityTimestamp, parseCommit } from './gitcore.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type CommentRec,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, already URI-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** Absolute origin (http://host) for building Link headers. */
  origin: string;
  /** The full request path (for Link headers). */
  path: string;
}

export interface RestResponse {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResponse => ({ status: 404, json: { message: 'Not Found' } });
const unprocessable = (message: string): RestResponse => ({ status: 422, json: { message } });

// --------------------------------------------------------------------- shapes

export function userJson() {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: 'U_1000',
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    site_admin: false,
    html_url: `https://forge.invalid/${VIEWER_LOGIN}`,
  };
}

export function repoJson(forge: Forge, repo: RepoRec) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(),
    html_url: `https://forge.invalid/${VIEWER_LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    created_at: forge.iso(repo.createdAt),
    updated_at: forge.iso(repo.updatedAt),
    pushed_at: forge.iso(repo.updatedAt),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: forge.openIssueCount(repo),
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(forge: Forge, repo: RepoRec, name: string) {
  const label = repo.labels.get(name);
  return {
    id: 0,
    node_id: `LA_${repo.id}_${name}`,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: label?.description ?? '',
  };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec) {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(forge, repo, name)),
    user: userJson(),
    assignees: [],
    comments: issue.comments.length,
    created_at: forge.iso(issue.createdAt),
    updated_at: forge.iso(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : forge.iso(issue.closedAt),
    html_url: `https://forge.invalid/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(forge: Forge, comment: CommentRec) {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: forge.iso(comment.createdAt),
    updated_at: forge.iso(comment.updatedAt),
    html_url: `https://forge.invalid/comments/${comment.id}`,
  };
}

function refObjectJson(forge: Forge, repo: RepoRec, ref: string, sha: string) {
  return {
    label: `${VIEWER_LOGIN}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(forge, repo),
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec) {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = pull.merged ? pull.baseSha : forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    draft: false,
    created_at: forge.iso(pull.createdAt),
    updated_at: forge.iso(pull.updatedAt),
    closed_at: pull.closedAt === null ? null : forge.iso(pull.closedAt),
    merged_at: pull.mergedAt === null ? null : forge.iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    head: refObjectJson(forge, repo, pull.headRef, headSha),
    base: refObjectJson(forge, repo, pull.baseRef, baseSha),
    html_url: `https://forge.invalid/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
  };
}

function identityJson(line: string) {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: '', email: '', date: new Date(0).toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commitJson(forge: Forge, oid: string) {
  const object = forge.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const info = parseCommit(object.data);
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: identityJson(info.author),
      committer: identityJson(info.committer),
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree },
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: info.parents.map((sha) => ({ sha })),
  };
}

/** Commits reachable from `tip`, newest generation first (log order). */
export function listCommits(forge: Forge, tip: string): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const json = commitJson(forge, current);
    if (json === null) continue;
    out.push(json);
    const info = forge.commitInfo(current);
    if (info !== null) queue.push(...info.parents);
  }
  return out;
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

function paginate<T>(req: RestRequest, all: readonly T[]): Page<T> {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const pageRaw = Number(req.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const params = new URLSearchParams(req.query);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    const lastPage = Math.ceil(all.length / perPage);
    const lastParams = new URLSearchParams(req.query);
    lastParams.set('page', String(lastPage));
    lastParams.set('per_page', String(perPage));
    headers.Link =
      `<${req.origin}${req.path}?${params.toString()}>; rel="next", ` +
      `<${req.origin}${req.path}?${lastParams.toString()}>; rel="last"`;
  }
  return { items, headers };
}

// ------------------------------------------------------------------ contents

function encodeBase64(data: Buffer): string {
  const raw = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 60) lines.push(raw.slice(i, i + 60));
  return lines.join('\n');
}

function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
}

// --------------------------------------------------------------------- pulls

/** Line counts for one changed file, via a longest-common-subsequence diff. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const split = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = split(oldText);
  const b = split(newText);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** Files changed between the merge-base tree and the head tree of a pull. */
export function pullFiles(forge: Forge, repo: RepoRec, pull: PullRec): ChangedFile[] {
  const headOid = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseOid = pull.baseSha;
  const mergeBase = forge.mergeBase(headOid, baseOid) ?? baseOid;
  const fromFlat = forge.flattenCommit(mergeBase);
  const toFlat = forge.flattenCommit(headOid);
  const files: ChangedFile[] = [];
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    const oldText = from === undefined ? '' : (forge.get(from.oid)?.data.toString('utf8') ?? '');
    const newText = to === undefined ? '' : (forge.get(to.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    files.push({
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: (to ?? from)!.oid,
    });
  }
  return files;
}

/**
 * Merge a pull request into its base branch. Returns the merge outcome so
 * REST (status codes) and GraphQL (payload/errors) can share the logic.
 */
export function mergePull(
  forge: Forge,
  repo: RepoRec,
  pull: PullRec,
  method: 'squash' | 'merge' | 'rebase',
  titleOverride?: string,
  messageOverride?: string,
): { ok: true; sha: string } | { ok: false; reason: 'not-mergeable' | 'conflict' } {
  if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'not-mergeable' };
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'not-mergeable' };
  const mergeBase = forge.mergeBase(headTip, baseTip);
  const baseFlat = mergeBase === null ? new Map() : forge.flattenCommit(mergeBase);
  const oursFlat = forge.flattenCommit(baseTip);
  const theirsFlat = forge.flattenCommit(headTip);
  const merged = forge.mergeFlats(baseFlat, oursFlat, theirsFlat);
  if (!merged.ok) return { ok: false, reason: 'conflict' };
  const ts = forge.tick();
  const tree = forge.buildTreeFromFlat(merged.flat);
  let commit: string;
  if (method === 'merge') {
    const message = titleOverride ?? `Merge pull request #${pull.number} from ${pull.headRef}`;
    commit = forge.makeCommit(tree, [baseTip, headTip], messageOverride ? `${message}\n\n${messageOverride}` : message, ts);
  } else if (method === 'rebase') {
    // Replay the head-only commits onto the base tip, oldest first.
    const baseAncestors = forge.ancestorsOf(baseTip);
    const chain: string[] = [];
    let cursor: string | undefined = headTip;
    while (cursor !== undefined && !baseAncestors.has(cursor)) {
      chain.push(cursor);
      const info = forge.commitInfo(cursor);
      cursor = info !== null && info.parents.length > 0 ? info.parents[0] : undefined;
    }
    chain.reverse();
    let newParent = baseTip;
    let currentFlat = oursFlat;
    for (const old of chain) {
      const info = forge.commitInfo(old);
      if (info === null) return { ok: false, reason: 'conflict' };
      const oldBase = info.parents.length > 0 ? forge.flattenCommit(info.parents[0]!) : new Map();
      const step = forge.mergeFlats(oldBase, currentFlat, forge.flattenCommit(old));
      if (!step.ok) return { ok: false, reason: 'conflict' };
      const stepTree = forge.buildTreeFromFlat(step.flat);
      newParent = forge.makeCommit(stepTree, [newParent], info.message, ts);
      currentFlat = step.flat;
    }
    commit = newParent;
  } else {
    const title = titleOverride ?? `${pull.title} (#${pull.number})`;
    const extra = messageOverride ?? (pull.body !== '' ? pull.body : undefined);
    commit = forge.makeCommit(tree, [baseTip], extra ? `${title}\n\n${extra}` : title, ts);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.headSha = headTip;
  pull.baseSha = baseTip;
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = ts;
  pull.closedAt = ts;
  pull.updatedAt = ts;
  pull.mergeCommitSha = commit;
  repo.updatedAt = ts;
  return { ok: true, sha: commit };
}

// ------------------------------------------------------------- shared writes

export function createIssueRecord(
  forge: Forge,
  repo: RepoRec,
  input: { title: string; body: string; labels: string[] },
): IssueRec {
  const ts = forge.tick();
  const issue: IssueRec = {
    id: forge.nextId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    comments: [],
    user: VIEWER_LOGIN,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  forge.issueById.set(issue.id, { repo, issue });
  repo.updatedAt = ts;
  return issue;
}

export function createPullRecord(
  forge: Forge,
  repo: RepoRec,
  input: { title: string; body: string; head: string; base: string },
): PullRec {
  const ts = forge.tick();
  const pull: PullRec = {
    id: forge.nextId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headSha: forge.branchTip(repo, input.head) ?? '',
    baseSha: forge.branchTip(repo, input.base) ?? '',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    user: VIEWER_LOGIN,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  forge.pullById.set(pull.id, { repo, pull });
  repo.updatedAt = ts;
  return pull;
}

/** Validate a head/base pair for pull creation; returns an error message or null. */
export function pullValidationError(forge: Forge, repo: RepoRec, head: string, base: string): string | null {
  if (forge.branchTip(repo, base) === undefined) return `Validation Failed: base branch "${base}" does not exist`;
  if (forge.branchTip(repo, head) === undefined) return `Validation Failed: head branch "${head}" does not exist`;
  if (head === base) return 'Validation Failed: head and base are the same branch';
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return `A pull request already exists for ${VIEWER_LOGIN}:${head} -> ${base}`;
    }
  }
  return null;
}

/** Strip an optional "owner:" prefix from a head ref, as GitHub accepts. */
export function normalizeHeadRef(head: string): string {
  const colon = head.indexOf(':');
  return colon > 0 ? head.slice(colon + 1) : head;
}

// -------------------------------------------------------------------- router

function repoFromSegments(forge: Forge, segments: string[]): RepoRec | null {
  const owner = segments[1];
  const name = segments[2];
  if (owner !== VIEWER_LOGIN || name === undefined) return null;
  return forge.getRepo(name) ?? null;
}

export function handleRest(forge: Forge, req: RestRequest): RestResponse {
  const { method, segments } = req;

  // API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: {
        current_user_url: `${req.origin}/api/v3/user`,
        repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
        issue_url: `${req.origin}/api/v3/repos/{owner}/{repo}/issues`,
        emojis_url: `${req.origin}/api/v3/emojis`,
      },
      headers: { 'X-OAuth-Scopes': 'repo, read:org' },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: {
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        installed_version: '1.0.0',
        github_developer_program: false,
      },
    };
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, json: userJson() };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const page = paginate(req, [...forge.repos.values()]);
      return { status: 200, json: page.items.map((repo) => repoJson(forge, repo)), headers: page.headers };
    }
    if (method === 'POST') {
      const name = typeof req.body.name === 'string' ? req.body.name : '';
      if (name === '') return unprocessable('Validation Failed: name is required');
      if (forge.getRepo(name) !== undefined) {
        return {
          status: 422,
          json: {
            message: 'Repository creation failed.',
            errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
          },
        };
      }
      const repo = forge.createRepo(
        name,
        typeof req.body.description === 'string' ? req.body.description : '',
        req.body.private === true,
      );
      if (req.body.auto_init === true) {
        forge.commitOnBranch(repo, repo.defaultBranch, new Map(), 'Initial commit');
      }
      return { status: 201, json: repoJson(forge, repo) };
    }
    return notFound();
  }
  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const repo = repoFromSegments(forge, segments);
  if (repo === null) return notFound();
  const rest = segments.slice(3);
  return handleRepoRoute(forge, req, repo, rest);
}

function handleRepoRoute(forge: Forge, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  const { method, body } = req;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(forge, repo) };
    if (method === 'PATCH') {
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        if (forge.getRepo(body.name) !== undefined) return unprocessable('Validation Failed: name already exists on this account');
        forge.repos.delete(repo.name);
        repo.name = body.name;
        forge.repos.set(repo.name, repo);
      }
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') {
        if (repo.refs.size > 0 && forge.branchTip(repo, body.default_branch) === undefined) {
          return unprocessable(`Validation Failed: default branch "${body.default_branch}" does not exist`);
        }
        repo.defaultBranch = body.default_branch;
      }
      repo.updatedAt = forge.tick();
      return { status: 200, json: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! }, protected: false }));
      return { status: 200, json: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = forge.branchTip(repo, name);
      if (sha === undefined) return notFound();
      return { status: 200, json: { name, commit: { sha }, protected: false } };
    }
    return notFound();
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: forge.get(sha)?.type ?? 'commit' } }));
        return { status: 200, json: refs };
      }
      if (method === 'POST') {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/')) return unprocessable('Validation Failed: ref must start with refs/');
        const target = forge.get(sha);
        if (target === undefined) return unprocessable(`Validation Failed: object ${sha} does not exist`);
        if (repo.refs.has(ref)) return unprocessable('Reference already exists');
        repo.refs.set(ref, sha);
        repo.updatedAt = forge.tick();
        return { status: 201, json: { ref, object: { sha, type: target.type } } };
      }
      return notFound();
    }
    const ref = `refs/${rest.slice(2).join('/')}`;
    if (method === 'GET') {
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      return { status: 200, json: { ref, object: { sha, type: forge.get(sha)?.type ?? 'commit' } } };
    }
    if (method === 'DELETE') {
      if (!repo.refs.delete(ref)) return notFound();
      return { status: 204 };
    }
    return notFound();
  }
  if (rest[0] === 'git' && rest[1] === 'ref' && rest.length >= 3 && method === 'GET') {
    const ref = `refs/${rest.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound();
    return { status: 200, json: { ref, object: { sha, type: forge.get(sha)?.type ?? 'commit' } } };
  }

  // Commits.
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const shaParam = req.query.get('sha');
      const tip = shaParam === null ? forge.branchTip(repo, repo.defaultBranch) : forge.resolveRef(repo, shaParam);
      if (tip === undefined) return { status: 200, json: [] };
      const commitOid = forge.peelToCommit(tip);
      if (commitOid === null) return { status: 200, json: [] };
      const page = paginate(req, listCommits(forge, commitOid));
      return { status: 200, json: page.items, headers: page.headers };
    }
    if (rest.length === 2 && method === 'GET') {
      const json = commitJson(forge, rest[1]!);
      return json === null ? notFound() : { status: 200, json };
    }
    return notFound();
  }

  // Contents.
  if (rest[0] === 'contents') {
    return handleContents(forge, req, repo, rest.slice(1).join('/'));
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const labels = [...repo.labels.values()]
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((label) => labelJson(forge, repo, label.name));
        return { status: 200, json: labels };
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return unprocessable('Validation Failed: name is required');
        if (repo.labels.has(name)) return unprocessable('Validation Failed: label already exists');
        repo.labels.set(name, {
          name,
          color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        });
        return { status: 201, json: labelJson(forge, repo, name) };
      }
      return notFound();
    }
    if (rest.length === 2) {
      const name = rest[1]!;
      if (method === 'GET') {
        return repo.labels.has(name) ? { status: 200, json: labelJson(forge, repo, name) } : notFound();
      }
      if (method === 'DELETE') {
        if (!repo.labels.delete(name)) return notFound();
        return { status: 204 };
      }
    }
    return notFound();
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    return handleIssues(forge, req, repo, rest.slice(1));
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(forge, req, repo, rest.slice(1));
  }

  return notFound();
}

function handleContents(forge: Forge, req: RestRequest, repo: RepoRec, path: string): RestResponse {
  const { method, body } = req;

  if (method === 'GET') {
    const refParam = req.query.get('ref');
    const tip = refParam === null ? forge.branchTip(repo, repo.defaultBranch) : forge.resolveRef(repo, refParam);
    if (tip === undefined) return notFound();
    const commitOid = forge.peelToCommit(tip);
    if (commitOid === null) return notFound();
    const flat = forge.flattenCommit(commitOid);
    if (path === '') {
      return { status: 200, json: directoryJson(forge, flat, '') };
    }
    const entry = flat.get(path);
    if (entry !== undefined) {
      const blob = forge.get(entry.oid);
      if (blob === undefined) return notFound();
      return {
        status: 200,
        json: {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: path.split('/').pop()!,
          path,
          content: encodeBase64(blob.data),
          sha: entry.oid,
        },
      };
    }
    const prefix = `${path}/`;
    const isDir = [...flat.keys()].some((key) => key.startsWith(prefix));
    if (isDir) return { status: 200, json: directoryJson(forge, flat, path) };
    return notFound();
  }

  if (method === 'PUT') {
    if (path === '') return unprocessable('Validation Failed: a file path is required');
    const message = typeof body.message === 'string' ? body.message : '';
    if (message === '') return unprocessable('Validation Failed: message is required');
    if (typeof body.content !== 'string') return unprocessable('Validation Failed: content is required');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = forge.branchTip(repo, branch) ?? forge.branchTip(repo, repo.defaultBranch);
    const flat = tip === undefined ? new Map() : forge.flattenCommit(tip);
    const existing = flat.get(path);
    const providedSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing !== undefined && providedSha !== undefined && providedSha !== existing.oid) {
      return { status: 409, json: { message: `${path} has changed since ${providedSha}` } };
    }
    if (existing === undefined && providedSha !== undefined) {
      return { status: 409, json: { message: `${path} does not exist at ${providedSha}` } };
    }
    const data = decodeBase64(body.content);
    const blobOid = forge.put('blob', data);
    flat.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
    const commit = forge.commitOnBranch(repo, branch, flat, message);
    return {
      status: existing === undefined ? 201 : 200,
      json: {
        content: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: path.split('/').pop()!,
          path,
          sha: blobOid,
        },
        commit: { sha: commit, message },
      },
    };
  }

  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : '';
    if (message === '') return unprocessable('Validation Failed: message is required');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = forge.branchTip(repo, branch);
    if (tip === undefined) return notFound();
    const flat = forge.flattenCommit(tip);
    const existing = flat.get(path);
    if (existing === undefined) return notFound();
    const providedSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (providedSha !== undefined && providedSha !== existing.oid) {
      return { status: 409, json: { message: `${path} has changed since ${providedSha}` } };
    }
    flat.delete(path);
    const commit = forge.commitOnBranch(repo, branch, flat, message);
    return { status: 200, json: { content: null, commit: { sha: commit, message } } };
  }

  return notFound();
}

function directoryJson(forge: Forge, flat: Map<string, { mode: string; oid: string }>, dirPath: string) {
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash < 0) {
      entries.set(remainder, { type: 'file', sha: entry.oid, size: forge.get(entry.oid)?.data.length ?? 0 });
    } else {
      const dirName = remainder.slice(0, slash);
      if (!entries.has(dirName)) {
        // The directory's tree oid: recompute from the subtree for a stable id.
        const sub = new Map<string, { mode: string; oid: string }>();
        for (const [p, e] of flat) {
          if (p.startsWith(`${prefix}${dirName}/`)) sub.set(p.slice(prefix.length + dirName.length + 1), e);
        }
        entries.set(dirName, { type: 'dir', sha: forge.buildTreeFromFlat(sub), size: 0 });
      }
    }
  }
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: `${prefix}${name}`,
      sha: entry.sha,
      size: entry.size,
    }));
}

function handleIssues(forge: Forge, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  const { method, body } = req;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      const labelFilter = (req.query.get('labels') ?? '').split(',').filter((name) => name !== '');
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      if (labelFilter.length > 0) issues = issues.filter((issue) => labelFilter.every((name) => issue.labels.includes(name)));
      issues.sort((a, b) => {
        const key = sort === 'updated' ? 'updatedAt' : 'createdAt';
        const diff = a[key] - b[key] || a.number - b.number;
        return direction === 'asc' ? diff : -diff;
      });
      const page = paginate(req, issues);
      return { status: 200, json: page.items.map((issue) => issueJson(forge, repo, issue)), headers: page.headers };
    }
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return unprocessable('Validation Failed: title is required');
      const labels = readLabelNames(body.labels);
      for (const name of labels) {
        if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label "${name}" does not exist`);
      }
      const issue = createIssueRecord(forge, repo, {
        title,
        body: typeof body.body === 'string' ? body.body : '',
        labels,
      });
      return { status: 201, json: issueJson(forge, repo, issue) };
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);

  if (rest.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return { status: 200, json: issueJson(forge, repo, issue) };
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.labels !== undefined) {
        const labels = readLabelNames(body.labels);
        for (const name of labels) {
          if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label "${name}" does not exist`);
        }
        issue.labels = labels;
      }
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? forge.tick() : null;
      }
      issue.updatedAt = forge.tick();
      return { status: 200, json: issueJson(forge, repo, issue) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    // Conversation comments live on issues; a pull request number works too.
    const holder: { comments: CommentRec[] } | undefined = issue ?? repo.pulls.get(number);
    if (holder === undefined) return notFound();
    if (method === 'GET') {
      return { status: 200, json: holder.comments.map((comment) => commentJson(forge, comment)) };
    }
    if (method === 'POST') {
      if (typeof body.body !== 'string') return unprocessable('Validation Failed: body is required');
      const ts = forge.tick();
      const comment: CommentRec = { id: forge.nextId(), body: body.body, user: VIEWER_LOGIN, createdAt: ts, updatedAt: ts };
      holder.comments.push(comment);
      forge.commentById.set(comment.id, { repo, comment });
      return { status: 201, json: commentJson(forge, comment) };
    }
    return notFound();
  }

  return notFound();
}

function readLabelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function handlePulls(forge: Forge, req: RestRequest, repo: RepoRec, rest: string[]): RestResponse {
  const { method, body } = req;

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const page = paginate(req, pulls);
      return { status: 200, json: page.items.map((pull) => pullJson(forge, repo, pull)), headers: page.headers };
    }
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const head = normalizeHeadRef(typeof body.head === 'string' ? body.head : '');
      const base = typeof body.base === 'string' ? body.base : '';
      if (title === '') return unprocessable('Validation Failed: title is required');
      if (head === '' || base === '') return unprocessable('Validation Failed: head and base are required');
      const error = pullValidationError(forge, repo, head, base);
      if (error !== null) return unprocessable(error);
      const pull = createPullRecord(forge, repo, {
        title,
        body: typeof body.body === 'string' ? body.body : '',
        head,
        base,
      });
      return { status: 201, json: pullJson(forge, repo, pull) };
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (pull === undefined) return notFound();
    if (method === 'GET') return { status: 200, json: pullJson(forge, repo, pull) };
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if ((body.state === 'open' || body.state === 'closed') && !pull.merged) {
        pull.state = body.state;
        pull.closedAt = body.state === 'closed' ? forge.tick() : null;
      }
      pull.updatedAt = forge.tick();
      return { status: 200, json: pullJson(forge, repo, pull) };
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound();
    const files = pullFiles(forge, repo, pull).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    const page = paginate(req, files);
    return { status: 200, json: page.items, headers: page.headers };
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound();
    const methodName = body.merge_method === 'merge' ? 'merge' : body.merge_method === 'rebase' ? 'rebase' : 'squash';
    const result = mergePull(
      forge,
      repo,
      pull,
      methodName,
      typeof body.commit_title === 'string' ? body.commit_title : undefined,
      typeof body.commit_message === 'string' ? body.commit_message : undefined,
    );
    if (!result.ok) return { status: 405, json: { message: 'Pull Request is not mergeable' } };
    return { status: 200, json: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  return notFound();
}
