/**
 * main.ts — the entrypoint the suite boots.
 *
 * Lifecycle, per the environment contract:
 *   1. bind an HTTP server on port 0 (the kernel chooses the port — never
 *      a fixed one);
 *   2. POST {"port": N} to $MAKEFUN_ENV_URL/register;
 *   3. long-poll GET $MAKEFUN_ENV_URL/done until it answers
 *      {"done": true};
 *   4. close the server and exit 0.
 *
 * The forge keeps all state in memory (see store.ts); the shop token that
 * every surface checks arrives as $MAKEFUN_SHOP_TOKEN.
 *
 * Robustness notes: registration retries with capped exponential backoff
 * (the environment may still be coming up when we boot), the done poll
 * backs off the same way so a long trial does not spin, and SIGTERM /
 * SIGINT close the listener before exiting so the port is never left
 * half-open.
 */
import { createServer, type Server } from 'node:http';
import { Forge } from './store.ts';
import { createHandler } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 200 ms, 400 ms, 800 ms, … capped at 2 s. */
function backoffMs(attempt: number): number {
  return Math.min(2000, 200 * 2 ** attempt);
}

async function register(envUrl: string, port: number): Promise<void> {
  // The environment may still be coming up; retry for a generous window.
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      // 409 means an earlier attempt actually landed — that is success.
      if (response.ok || response.status === 409) return;
      lastError = new Error(`register answered HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(backoffMs(attempt));
    attempt += 1;
  }
  throw lastError instanceof Error ? lastError : new Error('register never succeeded');
}

async function waitForDone(envUrl: string): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body: unknown = await response.json();
        if (body !== null && typeof body === 'object' && (body as { done?: unknown }).done === true) return;
      }
    } catch {
      // A transient poll failure is not fatal; keep waiting.
    }
    await sleep(backoffMs(attempt));
    if (attempt < 4) attempt += 1;
  }
}

function closeAndExit(server: Server, code: number): void {
  server.close(() => process.exit(code));
  // Do not let a lingering keep-alive socket hold the exit hostage.
  setTimeout(() => process.exit(code), 1000).unref();
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set; there is no trial to serve');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const forge = new Forge();
  const server = createServer(createHandler(forge, token));
  process.on('SIGTERM', () => closeAndExit(server, 0));
  process.on('SIGINT', () => closeAndExit(server, 0));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('the server did not bind a TCP port');
    process.exit(1);
  }
  await register(envUrl, address.port);
  await waitForDone(envUrl);
  closeAndExit(server, 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
