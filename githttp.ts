/**
 * githttp.ts — the git smart HTTP protocol at /{owner}/{repo}.git, spoken
 * directly: pkt-line framing, protocol v2 (ls-refs and fetch) with a v0
 * fallback for upload-pack, and v0 receive-pack with report-status.
 *
 * Fetch pack planning follows shallow semantics precisely: `have` commits
 * are traversed without crossing a shallow boundary, the send set is the
 * want closure cut at the requested depth and at the boundary, and
 * shallow-info reports the boundary's new position.
 */
import { buildPack, parsePack, pktLine, readPkt, PKT_DELIM, PKT_FLUSH, ZERO_OID, type GitObject } from './gitcore.ts';
import type { Forge, RepoRec } from './store.ts';

export interface GitHttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta shallow agent=makefun-forge/1.0.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=makefun-forge/1.0.0';
const SIDEBAND_CHUNK = 65515;

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// -------------------------------------------------------------- advertisement

export function infoRefs(forge: Forge, repo: RepoRec, service: string, gitProtocol: string | null): GitHttpResponse {
  if (service === 'git-upload-pack' && gitProtocol !== null && /(?:^|[\s,])version=2(?:$|[\s,])/.test(gitProtocol)) {
    const lines = [
      'version 2',
      'agent=makefun-forge/1.0.0',
      'ls-refs=unborn',
      'fetch=shallow',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headRef = forge.defaultRef(repo);
    const headOid = repo.refs.get(headRef) ?? refs[0]![1];
    parts.push(pktLine(`${headOid} HEAD\0${caps} symref=HEAD:${headRef}\n`));
    for (const [name, oid] of refs) parts.push(pktLine(`${oid} ${name}\n`));
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(parts),
  };
}

// ------------------------------------------------------------------ ls-refs

interface LsRefsArgs {
  symrefs: boolean;
  peel: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(forge: Forge, repo: RepoRec, args: LsRefsArgs): Buffer {
  const headRef = forge.defaultRef(repo);
  const headOid = repo.refs.get(headRef);
  const lines: string[] = [];
  const prefixes = args.prefixes;
  // HEAD is listed only when a prefix matches the literal name "HEAD"
  // (or no prefix was given at all) — a prefix over refs/heads/ must not
  // pull it in, which the raw-response prefix check verifies.
  const headWanted = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headWanted) {
    if (headOid !== undefined) {
      lines.push(args.symrefs ? `${headOid} HEAD symref-target:${headRef}` : `${headOid} HEAD`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:${headRef}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = forge.peelTag(oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// --------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepen: number | null;
  done: boolean;
}

interface FetchPlan {
  objects: GitObject[];
  shallowLines: string[];
  unshallowLines: string[];
}

/**
 * Plan a fetch: which objects to pack and where the shallow boundary sits
 * afterwards. See the module header for the traversal rules.
 */
export function planFetch(forge: Forge, args: FetchArgs): FetchPlan {
  const shallowSet = new Set(args.shallow);
  const depthLimit = args.depth ?? args.deepen ?? null;

  const wantCommits: string[] = [];
  const extraRoots: string[] = [];
  for (const want of args.wants) {
    const commit = forge.peelToCommit(want);
    if (commit === null) continue;
    wantCommits.push(commit);
    if (want !== commit) extraRoots.push(want);
  }

  // Commits the client demonstrably holds: traverse from the haves without
  // expanding a shallow boundary commit's parents (it does not have them).
  const held = new Set<string>();
  {
    const stack: string[] = [];
    for (const have of args.haves) {
      const commit = forge.peelToCommit(have);
      if (commit !== null) stack.push(commit);
    }
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (held.has(current)) continue;
      held.add(current);
      if (shallowSet.has(current)) continue;
      const info = forge.commitInfo(current);
      if (info !== null) stack.push(...info.parents);
    }
  }

  // Generation map from the wants. A shallow boundary blocks expansion
  // unless a depth (or deepen) target asks us to go past it.
  const gens = new Map<string, number>();
  {
    const queue: [string, number][] = wantCommits.map((commit) => [commit, 1]);
    while (queue.length > 0) {
      const [current, gen] = queue.shift()!;
      if (gens.has(current)) continue;
      gens.set(current, gen);
      if (depthLimit !== null && gen >= depthLimit) continue;
      if (depthLimit === null && shallowSet.has(current)) continue;
      const info = forge.commitInfo(current);
      if (info !== null) for (const parent of info.parents) queue.push([parent, gen + 1]);
    }
  }

  const sendCommits = new Set<string>();
  for (const commit of gens.keys()) if (!held.has(commit)) sendCommits.add(commit);

  // Objects: snapshots of the sent commits, minus anything held.
  const heldObjects = new Set<string>();
  for (const commit of held) for (const oid of forge.snapshotObjects(commit).keys()) heldObjects.add(oid);
  const sendObjects = new Map<string, GitObject>();
  for (const commit of sendCommits) {
    for (const [oid, object] of forge.snapshotObjects(commit)) {
      if (!heldObjects.has(oid)) sendObjects.set(oid, object);
    }
  }
  // Tag objects named directly as wants travel with their target.
  for (const root of extraRoots) {
    let current: string | null = root;
    while (current !== null) {
      const object = forge.get(current);
      if (object === undefined) break;
      if (!heldObjects.has(current)) sendObjects.set(current, object);
      if (object.type !== 'tag') break;
      current = forge.peelTag(current);
    }
  }

  // The boundary afterwards: included commits with a parent outside the
  // client's world (not in gens, not held). Roots are not shallow.
  const available = new Set<string>([...gens.keys(), ...held]);
  const newBoundary = new Set<string>();
  for (const commit of available) {
    const info = forge.commitInfo(commit);
    if (info === null) continue;
    if (info.parents.some((parent) => !available.has(parent))) newBoundary.add(commit);
  }
  const shallowLines = [...newBoundary].sort();
  const unshallowLines = args.shallow.filter((oid) => !newBoundary.has(oid)).sort();

  // Deterministic pack order: commits by generation, then trees, then
  // blobs, then tags, each by oid.
  const ordered = [...sendObjects.entries()].sort(([oidA, a], [oidB, b]) => {
    const rank = (object: GitObject): number =>
      object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'blob' ? 2 : 3;
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    if (a.type === 'commit' && b.type === 'commit') {
      const genDiff = (gens.get(oidA) ?? 0) - (gens.get(oidB) ?? 0);
      if (genDiff !== 0) return genDiff;
    }
    return oidA < oidB ? -1 : 1;
  });
  return { objects: ordered.map(([, object]) => object), shallowLines, unshallowLines };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, offset + SIDEBAND_CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

function fetchResponse(forge: Forge, args: FetchArgs, version: 0 | 2): Buffer {
  const plan = planFetch(forge, args);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  const shallowRequested = args.shallow.length > 0 || args.depth !== null || args.deepen !== null;
  if (version === 2) {
    // With `done` in the request the negotiation is over: git forbids an
    // acknowledgments section in that case, so it is only sent when the
    // client is still negotiating.
    if (!args.done && (args.haves.length > 0 || shallowRequested)) {
      parts.push(pktLine('acknowledgments\n'));
      const common = args.haves.find((have) => forge.get(have) !== undefined);
      if (common !== undefined) {
        parts.push(pktLine(`ACK ${common}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(PKT_DELIM);
    }
    if (shallowRequested) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  } else {
    if (shallowRequested) {
      // In a shallow v0 exchange over stateless RPC, git's fetch-pack
      // consumes a shallow block (lines + flush) from EVERY response,
      // including the final one — see consume_shallow_list in fetch-pack.
      for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
      if (!args.done) return Buffer.concat(parts);
    }
    parts.push(pktLine('NAK\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------- request parsing

/** Split a request body into sections separated by flush packets. */
function splitSections(body: Buffer): { sections: Buffer[][]; tail: Buffer } {
  const sections: Buffer[][] = [];
  let current: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const packet = readPkt(body, offset);
    if (packet === null) break;
    offset = packet.next;
    if (packet.kind === 'flush') {
      sections.push(current);
      current = [];
      if (offset < body.length) {
        // Anything after a flush that is not another section is the pack.
        const peek = readPkt(body, offset);
        if (peek === null || peek.kind !== 'data') break;
      }
    } else if (packet.kind === 'data') {
      current.push(packet.data);
    }
  }
  if (current.length > 0) sections.push(current);
  return { sections, tail: body.subarray(offset) };
}

function linesOf(section: Buffer[]): string[] {
  return section.map((data) => data.toString('utf8').replace(/\n$/, ''));
}

export function handleUploadPack(forge: Forge, repo: RepoRec, body: Buffer, gitProtocol: string | null): GitHttpResponse {
  const isV2 = gitProtocol !== null && /(?:^|[\s,])version=2(?:$|[\s,])/.test(gitProtocol);
  try {
    if (isV2) return handleUploadPackV2(forge, repo, body);
    return handleUploadPackV0(forge, repo, body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('invalid upload-pack request\n') };
  }
}

function handleUploadPackV2(forge: Forge, repo: RepoRec, body: Buffer): GitHttpResponse {
  // One section: command line, capability lines, a delimiter, argument
  // lines, and a flush.
  const commandLines: string[] = [];
  const argLines: string[] = [];
  let offset = 0;
  let phase: 'command' | 'args' = 'command';
  while (offset < body.length) {
    const packet = readPkt(body, offset);
    if (packet === null) break;
    offset = packet.next;
    if (packet.kind === 'delim') {
      phase = 'args';
      continue;
    }
    if (packet.kind === 'flush' || packet.kind === 'response-end') break;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    if (phase === 'command') commandLines.push(line);
    else argLines.push(line);
  }
  const command = commandLines[0]?.startsWith('command=') ? commandLines[0].slice('command='.length) : '';
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { symrefs: false, peel: false, unborn: false, prefixes: [] };
    for (const line of argLines) {
      if (line === 'symrefs') args.symrefs = true;
      else if (line === 'peel') args.peel = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(forge, repo, args) };
  }
  if (command === 'fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepen: null, done: false };
    for (const line of argLines) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim()) || null;
      else if (line.startsWith('depth ')) args.depth = Number(line.slice(6).trim()) || null;
      else if (line === 'done') args.done = true;
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(forge, args, 2) };
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown command ${command}\n`) };
}

function handleUploadPackV0(forge: Forge, repo: RepoRec, body: Buffer): GitHttpResponse {
  const { sections } = splitSections(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepen: null, done: false };
  const parseLines = (lines: string[]): void => {
    for (const rawLine of lines) {
      const nul = rawLine.indexOf('\0');
      const line = nul >= 0 ? rawLine.slice(0, nul) : rawLine;
      // The first want line also carries space-separated capabilities
      // after the object id; only the id itself is parsed here.
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]!);
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim()) || null;
      else if (line === 'done') args.done = true;
    }
  };
  for (const section of sections) parseLines(linesOf(section));
  if (args.wants.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('no wants\n') };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(forge, args, 0) };
}

// -------------------------------------------------------------- receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string[];
}

export function handleReceivePack(forge: Forge, repo: RepoRec, body: Buffer): GitHttpResponse {
  let offset = 0;
  const commands: RefCommand[] = [];
  let packStart = -1;
  try {
    let firstLine = true;
    while (offset < body.length) {
      const packet = readPkt(body, offset);
      if (packet === null) break;
      offset = packet.next;
      if (packet.kind === 'flush') {
        packStart = offset;
        break;
      }
      if (packet.kind !== 'data') continue;
      let line = packet.data.toString('utf8').replace(/\n$/, '');
      let caps: string[] = [];
      if (firstLine) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          caps = line.slice(nul + 1).split(' ').filter((cap) => cap !== '');
          line = line.slice(0, nul);
        }
        firstLine = false;
      }
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' '), caps });
      }
    }
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('invalid receive-pack request\n') };
  }
  if (packStart < 0) packStart = offset;
  const pack = body.subarray(packStart);
  const useSideband = commands.length > 0 && commands[0]!.caps.includes('side-band-64k');

  // Unpack first (when a pack was sent), so ref validation sees the objects.
  let unpackError: string | null = null;
  const anyCreate = commands.some((command) => command.newOid !== ZERO_OID);
  if (anyCreate && pack.length > 0) {
    try {
      const objects = parsePack(pack, (oid) => forge.get(oid));
      for (const object of objects.values()) forge.putObject(object);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'corrupt pack';
    }
  } else if (anyCreate && pack.length === 0) {
    unpackError = 'no pack sent for a ref update';
  }

  const report: string[] = [];
  report.push(unpackError === null ? 'unpack ok' : `unpack ${unpackError}`);
  for (const command of commands) {
    const reason = unpackError === null ? applyRefUpdate(forge, repo, command) : 'failed to apply';
    report.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }

  // The report is a pkt-line stream. When side-band-64k was negotiated it
  // travels inside band-1 packets: the demultiplexed band-1 payload is the
  // pkt-line stream itself, so chunk the stream, not the individual lines.
  const reportBytes = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const responseBody = useSideband
    ? Buffer.concat([...sidebandPack(reportBytes), PKT_FLUSH])
    : reportBytes;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** Apply one ref update; returns null on success or the ng reason. */
function applyRefUpdate(forge: Forge, repo: RepoRec, command: RefCommand): string | null {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);

  if (newOid === ZERO_OID) {
    // Deletion.
    if (current === undefined) return 'reference not found';
    if (ref === forge.defaultRef(repo)) return 'deletion of the current branch prohibited';
    repo.refs.delete(ref);
    repo.updatedAt = forge.tick();
    return null;
  }

  const target = forge.get(newOid);
  if (target === undefined) return 'invalid object';
  if (ref.startsWith('refs/heads/') && target.type !== 'commit') return 'invalid object';

  if (oldOid === ZERO_OID) {
    if (current !== undefined && current !== newOid) return 'already exists';
  } else {
    if (current !== oldOid) return 'stale info';
    if (current !== newOid) {
      const oldCommit = forge.peelToCommit(oldOid);
      const newCommit = forge.peelToCommit(newOid);
      if (oldCommit !== null && newCommit !== null && !forge.isAncestor(oldCommit, newCommit)) {
        return 'non-fast-forward';
      }
    }
  }
  repo.refs.set(ref, newOid);
  repo.updatedAt = forge.tick();
  return null;
}

/** The owner segment is validated by the caller; kept for route clarity. */
export function gitPathOwner(pathname: string): { owner: string; repo: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/.*)?$/.exec(pathname);
  if (match === null) return null;
  return { owner: decodeURIComponent(match[1]!), repo: decodeURIComponent(match[2]!) };
}
