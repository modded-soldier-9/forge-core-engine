/**
 * Forge Core Engine Entrypoint & Lifecycle Manager
 * Autonomous GitHub-compatible Git Smart-HTTP & REST/GraphQL API server
 * Optimized for make.fun evaluation harness with ultra-low-latency response caching.
 */

import { createApp } from './app.ts';

// Resolve environment URL provided by make.fun test harness
const rawEnvUrl = process.env.MAKEFUN_ENV_URL ?? '';
const ENV_URL = rawEnvUrl.replace(/\/+$/, '');

if (!ENV_URL) {
  process.stderr.write('[forge-entry] FATAL: MAKEFUN_ENV_URL environment variable is not defined\n');
  process.exit(1);
}

// Timeout and exponential backoff configuration for robust registration
const REQUEST_TIMEOUT_MS = 30_000;
const INITIAL_RETRY_INTERVAL_MS = 200;
const MAX_RETRY_INTERVAL_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt: number): number {
  const delay = INITIAL_RETRY_INTERVAL_MS * Math.pow(2, Math.min(attempt, 8));
  return Math.min(MAX_RETRY_INTERVAL_MS, delay);
}

/**
 * Registers the ephemeral server port with the test environment coordinator.
 * Accepts HTTP 200 (OK) or HTTP 409 (another worker already registered).
 */
async function registerServerPort(port: number): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 200 || res.status === 409) {
        return;
      }

      if (res.status === 400 || res.status === 405) {
        const errorText = await res.text();
        throw new Error(`[forge-entry] Contract error on register: HTTP ${res.status} - ${errorText}`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('[forge-entry] Contract error')) {
        throw err;
      }
    }

    await wait(computeBackoff(attempt));
    attempt += 1;
  }
}

/**
 * Polls the environment coordinator until all test suites complete.
 */
async function pollUntilComplete(): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        method: 'GET',
        headers: { 'accept': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        const payload = (await res.json()) as { done?: unknown };
        if (payload && payload.done === true) {
          return;
        }
      }
    } catch {
      // Coordinator is evaluating test suites; continue polling
    }

    await wait(computeBackoff(attempt));
    attempt += 1;
  }
}

/**
 * Main application bootstrap: bind ephemeral port, announce to harness, and await trial conclusion.
 */
async function run(): Promise<void> {
  const app = createApp();

  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, () => resolve());
  });

  const addressInfo = app.address();
  if (!addressInfo || typeof addressInfo === 'string') {
    throw new Error('[forge-entry] Server failed to bind to a valid ephemeral TCP socket');
  }

  process.stdout.write(`[forge-entry] Active server listening on port ${addressInfo.port}\n`);

  await registerServerPort(addressInfo.port);
  process.stdout.write('[forge-entry] Successfully registered port with test coordinator\n');

  await pollUntilComplete();

  app.close();
  process.stdout.write('[forge-entry] Test execution completed. Graceful shutdown complete.\n');
}

try {
  await run();
  process.exit(0);
} catch (fatalError: unknown) {
  const msg = fatalError instanceof Error ? fatalError.message : String(fatalError);
  process.stderr.write(`[forge-entry] Unhandled runtime exception: ${msg}\n`);
  process.exit(1);
}
