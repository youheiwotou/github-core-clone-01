/**
 * store.ts — the forge's single in-memory state, shared by the git, REST,
 * GraphQL and MCP surfaces so an object created on one surface is the same
 * object on all of them.
 *
 * Determinism: entity ids come from one sequential counter and every
 * timestamp comes from a logical clock seeded by MAKEFUN_TRIAL_NOW (the
 * only "now" a reply may carry), advanced by one second per mutation.
 * Git object ids are content-derived. Nothing random reaches a reply.
 */
import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  user: string;
  createdAt: number;
  updatedAt: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  user: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  user: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface RepoRec {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name ("refs/heads/main") -> object id. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one per-repository number sequence. */
  nextNumber: number;
  createdAt: number;
  updatedAt: number;
}

/** One file in a flattened tree: repo-relative path -> entry. */
export interface FlatEntry {
  mode: string;
  oid: string;
}
export type FlatTree = Map<string, FlatEntry>;

function parseTrialNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z
}

export class Forge {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, RepoRec>();
  readonly repoById = new Map<number, RepoRec>();
  readonly issueById = new Map<number, { repo: RepoRec; issue: IssueRec }>();
  readonly pullById = new Map<number, { repo: RepoRec; pull: PullRec }>();
  readonly commentById = new Map<number, { repo: RepoRec; comment: CommentRec }>();
  private nextEntityId = 1;
  private clockSec: number;
  requestSeq = 0;

  constructor() {
    this.clockSec = parseTrialNow();
  }

  /** Advance the logical clock and return the new "now" (epoch seconds). */
  tick(): number {
    this.clockSec += 1;
    return this.clockSec;
  }

  now(): number {
    return this.clockSec;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  /** The viewer's git identity line for a commit at `sec`. */
  identity(sec: number): string {
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${sec} +0000`;
  }

  nextId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  // ------------------------------------------------------------ object store

  put(type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObject(object: GitObject): string {
    return this.put(object.type, object.data);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Follow a tag object (if `oid` is one) down to the commit it names. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Peel a tag object one level (or to a commit) for ls-refs `peeled:`. */
  peelTag(oid: string): string | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'tag') return null;
    return parseTag(object.data).object;
  }

  commitInfo(oid: string) {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  treeOfCommit(commitOid: string): string | null {
    const info = this.commitInfo(commitOid);
    return info === null ? null : info.tree;
  }

  // ------------------------------------------------------------------- trees

  flattenTree(treeOid: string, prefix: string, out: FlatTree): void {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }

  flattenCommit(commitOid: string): FlatTree {
    const out: FlatTree = new Map();
    const tree = this.treeOfCommit(commitOid);
    if (tree !== null) this.flattenTree(tree, '', out);
    return out;
  }

  /** Every object (trees and blobs) inside a tree, not including the tree itself in `out` order. */
  collectTreeObjects(treeOid: string, out: Map<string, GitObject>): void {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, object);
    for (const entry of parseTree(object.data)) {
      const child = this.objects.get(entry.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') this.collectTreeObjects(entry.oid, out);
      else if (child.type === 'blob') out.set(entry.oid, child);
    }
  }

  /** A commit plus its full tree closure, as an oid -> object map. */
  snapshotObjects(commitOid: string): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return out;
    out.set(commitOid, commit);
    const tree = this.treeOfCommit(commitOid);
    if (tree !== null) this.collectTreeObjects(tree, out);
    return out;
  }

  buildTreeFromFlat(flat: FlatTree): string {
    interface Node {
      files: Map<string, FlatEntry>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i]!;
        let child = node.dirs.get(segment);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  // ----------------------------------------------------------------- commits

  makeCommit(tree: string, parents: string[], message: string, sec: number): string {
    const identity = this.identity(sec);
    const data = buildCommit({ tree, parents, author: identity, committer: identity, message });
    return this.put('commit', data);
  }

  /** All ancestor commits of `oid` (inclusive), following parents. */
  ancestorsOf(oid: string): Set<string> {
    const seen = new Set<string>();
    const start = this.peelToCommit(oid);
    if (start === null) return seen;
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const info = this.commitInfo(current);
      if (info !== null) for (const parent of info.parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestorsOf(descendant).has(ancestor);
  }

  /** A common ancestor of two commits (breadth-first from `b`), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = this.ancestorsOf(a);
    if (ancestorsA.size === 0) return null;
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsA.has(current)) return current;
      const info = this.commitInfo(current);
      if (info !== null) queue.push(...info.parents);
    }
    return null;
  }

  /**
   * Three-way merge of flattened trees. Returns the merged tree, or the
   * first conflicting path. Entries compare by oid and mode; a path changed
   * on both sides in different ways (or changed vs deleted) conflicts.
   */
  mergeFlats(
    base: FlatTree,
    ours: FlatTree,
    theirs: FlatTree,
  ): { ok: true; flat: FlatTree } | { ok: false; path: string } {
    const merged: FlatTree = new Map();
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
      x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode;
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      if (same(o, t)) {
        if (o !== undefined) merged.set(path, o);
      } else if (same(b, o)) {
        if (t !== undefined) merged.set(path, t);
      } else if (same(b, t)) {
        if (o !== undefined) merged.set(path, o);
      } else {
        return { ok: false, path };
      }
    }
    return { ok: true, flat: merged };
  }

  // ------------------------------------------------------------------- repos

  createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
    const ts = this.tick();
    const repo: RepoRec = {
      id: this.nextId(),
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    this.repos.set(name, repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  getRepo(name: string): RepoRec | undefined {
    return this.repos.get(name);
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repo.name);
    this.repoById.delete(repo.id);
    for (const issue of repo.issues.values()) this.issueById.delete(issue.id);
    for (const pull of repo.pulls.values()) this.pullById.delete(pull.id);
  }

  defaultRef(repo: RepoRec): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve HEAD, a full ref, a branch name, or a raw object id to an oid. */
  resolveRef(repo: RepoRec, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(this.defaultRef(repo));
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const asBranch = repo.refs.get(`refs/heads/${ref}`);
    if (asBranch !== undefined) return asBranch;
    const asTag = repo.refs.get(`refs/tags/${ref}`);
    if (asTag !== undefined) return asTag;
    if (/^[0-9a-f]{40}$/.test(ref) && this.objects.has(ref)) return ref;
    return undefined;
  }

  /**
   * Commit `flat` on `branch`, creating the branch when allowed: a missing
   * branch starts from the default branch's tip (or as a root commit when
   * the repository is still empty). Returns the new commit oid.
   */
  commitOnBranch(repo: RepoRec, branch: string, flat: FlatTree, message: string): string {
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined) {
      parent = repo.refs.get(this.defaultRef(repo));
    }
    const ts = this.tick();
    const tree = this.buildTreeFromFlat(flat);
    const commit = this.makeCommit(tree, parent === undefined ? [] : [parent], message, ts);
    repo.refs.set(ref, commit);
    repo.updatedAt = ts;
    return commit;
  }

  openIssueCount(repo: RepoRec): number {
    let count = 0;
    for (const issue of repo.issues.values()) if (issue.state === 'open') count += 1;
    for (const pull of repo.pulls.values()) if (pull.state === 'open') count += 1;
    return count;
  }
}
