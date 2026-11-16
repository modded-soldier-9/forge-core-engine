import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleMcp } from './mcp.ts';
import { handleGraphql } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = (res.getHeader('x-github-request-id') as string) || randomUUID();
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Ensure every response carries X-GitHub-Request-Id
    const incomingReqId = req.headers['x-github-request-id'];
    const requestId = typeof incomingReqId === 'string' && incomingReqId ? incomingReqId : randomUUID();
    res.setHeader('x-github-request-id', requestId);

    try {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // 1. Health probe: 200 {"ok":true}
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // 2. GitHub API root: 200 with token's scopes
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(
          res,
          200,
          { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
          { 'x-oauth-scopes': 'repo, read:org' },
        );
        return;
      }

      // 3. Git Smart HTTP handler (/<owner>/<repo>.git/...)
      try {
        if (typeof handleGit === 'function' && (await handleGit(req, res))) {
          return;
        }
      } catch (gitErr) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Git handler error' });
        }
        return;
      }

      // 4. REST v3 API handler (/api/v3/...)
      try {
        if (typeof handleRest === 'function' && (await handleRest(req, res))) {
          return;
        }
      } catch (restErr) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'REST handler error' });
        }
        return;
      }

      // 5. GraphQL v4 handler (/api/graphql)
      try {
        if (typeof handleGraphql === 'function' && (await handleGraphql(req, res))) {
          return;
        }
      } catch (gqlErr) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'GraphQL handler error' });
        }
        return;
      }

      // 6. MCP Protocol handler (/mcp)
      try {
        if (typeof handleMcp === 'function' && (await handleMcp(req, res))) {
          return;
        }
      } catch (mcpErr) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'MCP handler error' });
        }
        return;
      }

      // 7. Fallthrough for unknown routes: GitHub's JSON 404
      if (!res.headersSent) {
        sendJson(res, 404, { message: 'Not Found' });
      }
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      }
    }
  });
}
