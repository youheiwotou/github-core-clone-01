/**
 * mcp.ts — the Model Context Protocol surface at /mcp: JSON-RPC 2.0 over
 * Streamable HTTP with plain application/json replies.
 *
 * Both protocol eras are served: the modern `server/discover` handshake
 * (revision 2026-07-28) and the legacy `initialize` +
 * `notifications/initialized` handshake (2025-11-25 and earlier). The
 * server is stateless — no session id is handed out. Tools act on the
 * same store as REST, so objects keep their ids across surfaces.
 */
import { VIEWER_LOGIN, type Forge, type RepoRec } from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  issueJson,
  mergePull,
  normalizeHeadRef,
  pullJson,
  pullValidationError,
  repoJson,
} from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Fetch a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Fetch one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpResponse {
  status: number;
  /** Undefined means: answer with an empty body (notification ack). */
  json?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function lookupRepo(forge: Forge, args: Record<string, unknown>): RepoRec | null {
  const owner = stringArg(args, 'owner');
  const name = stringArg(args, 'repo') || stringArg(args, 'name');
  if (owner !== '' && owner !== VIEWER_LOGIN) return null;
  if (name === '') return null;
  return forge.getRepo(name) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | { __rpcError: Record<string, unknown> } {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) {
    return { __rpcError: rpcError(null, -32602, `Unknown tool: ${name}`) };
  }
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (forge.getRepo(repoName) !== undefined) return toolError(`repository ${repoName} already exists`);
      const repo = forge.createRepo(
        repoName,
        stringArg(args, 'description'),
        args.private === true,
      );
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      return toolResult(repoJson(forge, repo));
    }
    case 'list_repos': {
      return toolResult([...forge.repos.values()].map((repo) => repoJson(forge, repo)));
    }
    case 'create_issue': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const issue = createIssueRecord(forge, repo, {
        title: stringArg(args, 'title'),
        body: stringArg(args, 'body'),
        labels: [],
      });
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const state = stringArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueJson(forge, repo, issue)));
    }
    case 'get_issue': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolError('issue not found');
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'create_pull_request': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const head = normalizeHeadRef(stringArg(args, 'head'));
      const base = stringArg(args, 'base');
      const error = pullValidationError(forge, repo, head, base);
      if (error !== null) return toolError(error);
      const pull = createPullRecord(forge, repo, {
        title: stringArg(args, 'title'),
        body: stringArg(args, 'body'),
        head,
        base,
      });
      return toolResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(forge, args);
      if (repo === null) return toolError('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError('pull request not found');
      const result = mergePull(forge, repo, pull, 'squash');
      if (!result.ok) return toolError('Pull Request is not mergeable');
      return toolResult(pullJson(forge, repo, pull));
    }
    default:
      return { __rpcError: rpcError(null, -32602, `Unknown tool: ${name}`) };
  }
}

function processRequest(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};
  if (id === undefined) return null; // A notification: nothing to answer.
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = params.arguments !== null && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      const outcome = callTool(forge, toolName, toolArgs);
      if ('__rpcError' in outcome) {
        const error = outcome.__rpcError as { error?: { code: number; message: string } };
        return { jsonrpc: '2.0', id, error: error.error ?? { code: -32602, message: 'invalid params' } };
      }
      return rpcResult(id, outcome);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one HTTP request to /mcp. Auth is enforced by app.ts. */
export function handleMcp(forge: Forge, method: string, rawBody: Buffer): McpResponse {
  if (method === 'DELETE') return { status: 200, json: {} };
  if (method !== 'POST') {
    return { status: 405, json: rpcError(null, -32601, `Method ${method} is not supported on this endpoint`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const answers: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (entry !== null && typeof entry === 'object') {
        const answer = processRequest(forge, entry as Record<string, unknown>);
        if (answer !== null) answers.push(answer);
      }
    }
    return { status: 200, json: answers };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, json: rpcError(null, -32600, 'Invalid request') };
  }
  const answer = processRequest(forge, parsed as Record<string, unknown>);
  if (answer === null) return { status: 202 };
  return { status: 200, json: answer };
}
