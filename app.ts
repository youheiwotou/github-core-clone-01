/**
 * app.ts — HTTP wiring: one node:http server that routes to the four
 * surfaces (git smart HTTP, REST v3, GraphQL, MCP) plus /healthz.
 *
 * Cross-cutting rules from the contract:
 *  - every surface requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`;
 *    a missing or wrong token is a 401 (healthz is the only exception —
 *    the environment's boot probe calls it unauthenticated);
 *  - every reply carries a non-empty X-GitHub-Request-Id;
 *  - REST/GraphQL/MCP replies are application/json, errors included;
 *  - a repository under another owner is a 404, never a 403;
 *  - a handler bug must never take the server down: everything is wrapped.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN } from './store.ts';
import { handleRest, type RestResponse } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { gitPathOwner, handleReceivePack, handleUploadPack, infoRefs } from './githttp.ts';

const MAX_BODY_BYTES = 512 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, json: unknown, requestId: string, extraHeaders?: Record<string, string>): void {
  const body = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId,
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId,
  });
  res.end(body);
}

function authorized(req: IncomingMessage, token: string): boolean {
  if (token === '') return false;
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${token}`;
}

export function createHandler(forge: Forge, token: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    forge.requestSeq += 1;
    const requestId = `req-${forge.requestSeq}`;
    handle(forge, token, req, res, requestId).catch(() => {
      // Last-resort guard: a 500 JSON reply beats a dead connection.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
        else res.end();
      } catch {
        /* the socket is already gone */
      }
    });
  };
}

async function handle(
  forge: Forge,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    req.resume();
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  // Everything else requires the shop token.
  if (!authorized(req, token)) {
    req.resume();
    sendJson(res, 401, { message: 'Bad credentials' }, requestId);
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      req.resume();
      sendJson(res, 405, { errors: [{ message: 'GraphQL only accepts POST' }] }, requestId);
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'request body is not JSON' }] }, requestId);
      return;
    }
    if (Array.isArray(parsed)) {
      const answers = parsed.map((entry) =>
        executeGraphQL(forge, entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}),
      );
      sendJson(res, 200, answers, requestId);
      return;
    }
    const answer = executeGraphQL(forge, parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
    sendJson(res, 200, answer, requestId);
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const answer = handleMcp(forge, method, raw);
    if (answer.json === undefined) {
      res.writeHead(answer.status, { 'X-GitHub-Request-Id': requestId });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.json, requestId);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
          return;
        }
        body = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
        return;
      }
    }
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const answer: RestResponse = handleRest(forge, { method, segments, query: url.searchParams, body, origin, path: pathname });
    if (answer.status === 204 || answer.json === undefined) {
      res.writeHead(answer.status, { 'X-GitHub-Request-Id': requestId, ...(answer.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.json, requestId, answer.headers);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitPath = gitPathOwner(pathname);
  if (gitPath !== null) {
    if (gitPath.owner !== VIEWER_LOGIN) {
      req.resume();
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    const repo = forge.getRepo(gitPath.repo);
    if (repo === undefined) {
      req.resume();
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    const service = url.searchParams.get('service');
    if (method === 'GET' && pathname.endsWith('/info/refs') && (service === 'git-upload-pack' || service === 'git-receive-pack')) {
      req.resume();
      const answer = infoRefs(forge, repo, service, req.headers['git-protocol'] ?? null);
      sendBuffer(res, answer.status, answer.contentType, answer.body, requestId);
      return;
    }
    if (method === 'POST' && pathname.endsWith('/git-upload-pack')) {
      const raw = await readBody(req);
      const answer = handleUploadPack(forge, repo, raw, req.headers['git-protocol'] ?? null);
      sendBuffer(res, answer.status, answer.contentType, answer.body, requestId);
      return;
    }
    if (method === 'POST' && pathname.endsWith('/git-receive-pack')) {
      const raw = await readBody(req);
      const answer = handleReceivePack(forge, repo, raw);
      sendBuffer(res, answer.status, answer.contentType, answer.body, requestId);
      return;
    }
    req.resume();
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }

  req.resume();
  sendJson(res, 404, { message: 'Not Found' }, requestId);
}
