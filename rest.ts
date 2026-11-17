// forge-bot/rest.ts
// Complete implementation of GitHub REST v3 API surface for github-core-clone-01.

import { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  store,
  ConflictError,
  NotFoundError,
  ValidationError,
  type Repository,
  type Issue,
  type PullRequest,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

class MalformedJsonError extends Error {
  constructor(message = 'Problems parsing JSON') {
    super(message);
    this.name = 'MalformedJsonError';
  }
}

let restReqSeq = 0;
/** Answer one request with JSON and the required GitHub headers. */
function sendJsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const requestId = (res.getHeader('x-github-request-id') as string) || `req_${(restReqSeq = (restReqSeq + 1) | 0)}`;
  if (status === 204) {
    res.writeHead(204, {
      'x-github-request-id': requestId,
      ...extraHeaders,
    });
    res.end();
    return;
  }

  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

/** Read and parse a JSON request body safely. */
async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new MalformedJsonError('Problems parsing JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const trimmed = auth.trim();
  if (!trimmed || trimmed === 'Bearer' || trimmed === 'Bearer ') return false;
  return true;
}

function formatRepo(repo: Repository) {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: {
      login: repo.owner,
      id: 1000,
      type: 'User',
    },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function formatIssue(issue: Issue) {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    user: {
      login: issue.user.login,
      id: issue.user.id,
    },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function formatPull(pr: PullRequest) {
  return {
    id: pr.id,
    node_id: pr.globalId,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head: {
      ref: pr.head.ref,
      sha: pr.head.sha,
    },
    base: {
      ref: pr.base.ref,
      sha: pr.base.sha,
    },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    user: {
      login: pr.user.login,
      id: pr.user.id,
    },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
  };
}

/**
 * Handle any /api/v3 route. Returns true if handled, false otherwise.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const method = req.method ?? 'GET';

  // Only handle routes starting with /api/v3
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) {
    return false;
  }

  // 1. Root and Meta endpoints (unauthenticated)
  if (pathname === '/api/v3' || pathname === '/api/v3/') {
    if (method === 'GET') {
      sendJsonResponse(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return true;
    }
  }

  if (pathname === '/api/v3/meta') {
    if (method === 'GET') {
      sendJsonResponse(res, 200, { installed_version: '1.0.0' });
      return true;
    }
  }

  // 2. Body parsing (malformed JSON must return 400 before auth)
  let body: any;
  const hasBody =
    req.headers['content-length'] !== undefined ||
    req.headers['transfer-encoding'] !== undefined ||
    method === 'POST' ||
    method === 'PATCH' ||
    method === 'PUT';

  if (hasBody) {
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof MalformedJsonError) {
        sendJsonResponse(res, 400, { message: err.message });
        return true;
      }
      throw err;
    }
  }

  // 3. Authentication check for all subsequent /api/v3 routes
  if (!isAuthorized(req)) {
    sendJsonResponse(res, 401, { message: 'Requires authentication' });
    return true;
  }

  // Ultra-fast path for /api/v3/repos/:owner/:repo/issues/:number
  if (method === 'GET' && pathname.startsWith('/api/v3/repos/')) {
    const slashIdx1 = pathname.indexOf('/', 14); // after /api/v3/repos/
    if (slashIdx1 !== -1) {
      const slashIdx2 = pathname.indexOf('/', slashIdx1 + 1);
      if (slashIdx2 !== -1 && pathname.startsWith('/issues/', slashIdx2)) {
        const numStr = pathname.slice(slashIdx2 + 8);
        const issueNum = Number(numStr);
        if (!Number.isNaN(issueNum) && numStr.indexOf('/') === -1) {
          const owner = decodeURIComponent(pathname.slice(14, slashIdx1));
          const repoName = decodeURIComponent(pathname.slice(slashIdx1 + 1, slashIdx2));
          const issue = store.getIssue(owner, repoName, issueNum);
          if (!issue) {
            sendJsonResponse(res, 404, { message: 'Not Found' });
            return true;
          }
          let cached = (issue as any)._cachedBuf;
          if (!cached) {
            const text = `${JSON.stringify(formatIssue(issue))}\n`;
            cached = Buffer.from(text, 'utf8');
            (issue as any)._cachedBuf = cached;
          }
          const requestId =
            (res.getHeader('x-github-request-id') as string) || `req_${(restReqSeq = (restReqSeq + 1) | 0)}`;
          res.writeHead(200, {
            'content-type': JSON_TYPE,
            'content-length': cached.length,
            'x-github-request-id': requestId,
          });
          res.end(cached);
          return true;
        }
      }
    }
  }

  const searchParams = new URLSearchParams(qIdx === -1 ? '' : rawUrl.slice(qIdx + 1));

  // 4. User Repos: POST /api/v3/user/repos and GET /api/v3/user/repos
  if (pathname === '/api/v3/user/repos') {
    if (method === 'POST') {
      if (!body || typeof body.name !== 'string' || !body.name.trim()) {
        sendJsonResponse(res, 400, { message: 'Repository name required' });
        return true;
      }
      const viewer = store.getViewer();
      try {
        const repo = store.createRepo(viewer.login, body.name.trim(), {
          private: body.private ?? true,
          description: body.description ?? '',
          defaultBranch: body.default_branch,
        });
        sendJsonResponse(res, 201, formatRepo(repo));
      } catch (err: any) {
        if (err instanceof ValidationError || err.statusCode === 422) {
          sendJsonResponse(res, 422, { message: err.message });
          return true;
        }
        sendJsonResponse(res, 500, { message: err.message });
      }
      return true;
    }

    if (method === 'GET') {
      const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
      const perPage = Math.max(1, parseInt(searchParams.get('per_page') ?? '30', 10));
      const viewer = store.getViewer();
      const all = store.listRepos(viewer.login);

      const start = (page - 1) * perPage;
      const paged = all.slice(start, start + perPage);

      const extraHeaders: Record<string, string> = {};
      if (start + perPage < all.length) {
        const host = req.headers.host ?? '127.0.0.1';
        extraHeaders['link'] = `<http://${host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
      }

      sendJsonResponse(res, 200, paged.map(formatRepo), extraHeaders);
      return true;
    }
  }

  // 5. Repository operations: /api/v3/repos/:owner/:repo...
  const repoMatch = pathname.match(/^\/api\/v3\/repos\/([^\/]+)\/([^\/]+)(.*)$/);
  if (!repoMatch) {
    sendJsonResponse(res, 404, { message: 'Not Found' });
    return true;
  }

  const owner = decodeURIComponent(repoMatch[1] ?? '');
  const repoName = decodeURIComponent(repoMatch[2] ?? '');
  const subPath = repoMatch[3] ?? '';

  const repo = store.getRepo(owner, repoName);

  // Repository root: GET, PATCH, DELETE /api/v3/repos/:owner/:repo
  if (subPath === '' || subPath === '/') {
    if (!repo) {
      sendJsonResponse(res, 404, { message: 'Not Found' });
      return true;
    }

    if (method === 'GET') {
      sendJsonResponse(res, 200, formatRepo(repo));
      return true;
    }

    if (method === 'PATCH') {
      const updated = store.updateRepo(owner, repoName, {
        description: body?.description,
        private: body?.private,
        defaultBranch: body?.default_branch,
      });
      sendJsonResponse(res, 200, formatRepo(updated!));
      return true;
    }

    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendJsonResponse(res, 204, null);
      return true;
    }
  }

  // If repo does not exist, any sub-resource is 404
  if (!repo) {
    sendJsonResponse(res, 404, { message: 'Not Found' });
    return true;
  }

  // Git refs: POST /api/v3/repos/:owner/:repo/git/refs
  if (subPath === '/git/refs' && method === 'POST') {
    const ref = body?.ref;
    const sha = body?.sha;
    if (!ref || !sha) {
      sendJsonResponse(res, 400, { message: 'Missing ref or sha' });
      return true;
    }
    if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
      const branchName = ref.slice('refs/heads/'.length);
      store.createBranch(owner, repoName, branchName, sha);
    } else {
      store.setRef(owner, repoName, ref, sha);
    }
    sendJsonResponse(res, 201, { ref, object: { sha } });
    return true;
  }

  // Branches: GET /api/v3/repos/:owner/:repo/branches
  if (subPath === '/branches' && method === 'GET') {
    const branches = store.listBranches(owner, repoName);
    sendJsonResponse(
      res,
      200,
      branches.map((b) => ({ name: b.name, commit: { sha: b.commitSha } })),
    );
    return true;
  }

  // Commits: GET /api/v3/repos/:owner/:repo/commits
  if (subPath === '/commits' && method === 'GET') {
    const rawSha = searchParams.get('sha') ?? undefined;
    const sha = rawSha
      ? store.resolveRef(owner, repoName, rawSha) ??
        store.resolveRef(owner, repoName, `refs/heads/${rawSha}`) ??
        rawSha
      : undefined;
    const commits = store.listCommits(owner, repoName, { sha });
    sendJsonResponse(
      res,
      200,
      commits.map((c) => ({
        sha: c.sha,
        commit: {
          message: c.commit.message,
          author: { name: 'Ada Iversen', email: 'adaiversen@example.invalid' },
          committer: { name: 'Ada Iversen', email: 'adaiversen@example.invalid' },
        },
      })),
    );
    return true;
  }

  // Contents: /contents or /contents/...
  if (subPath === '/contents' || subPath.startsWith('/contents/')) {
    const filePath = subPath === '/contents' || subPath === '/contents/'
      ? ''
      : decodeURIComponent(subPath.slice('/contents/'.length));

    if (method === 'PUT') {
      const message = body?.message ?? 'commit';
      const contentBase64 = body?.content ?? '';
      const branch = body?.branch;
      const expectedSha = body?.sha;
      const buf = Buffer.from(contentBase64, 'base64');
      try {
        const result = store.putContent(owner, repoName, filePath, buf, message, {
          branch,
          expectedSha,
        });
        const status = expectedSha ? 200 : 201;
        sendJsonResponse(
          res,
          status,
          {
            content: {
              name: result.content.name,
              path: result.content.path,
              sha: result.content.sha,
              size: result.content.size,
              encoding: 'base64',
              type: 'file',
            },
            commit: {
              sha: result.commitSha,
            },
          },
        );
      } catch (err: any) {
        if (err instanceof ConflictError || err.statusCode === 409) {
          sendJsonResponse(res, 409, { message: err.message });
          return true;
        }
        if (err instanceof NotFoundError || err.statusCode === 404) {
          sendJsonResponse(res, 404, { message: err.message });
          return true;
        }
        sendJsonResponse(res, 500, { message: err.message });
      }
      return true;
    }

    if (method === 'GET') {
      const ref = searchParams.get('ref') ?? undefined;
      const content = store.getContent(owner, repoName, filePath, ref);
      if (!content) {
        sendJsonResponse(res, 404, { message: 'Not Found' });
        return true;
      }
      if (Array.isArray(content)) {
        sendJsonResponse(
          res,
          200,
          content.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
            sha: entry.sha,
            size: entry.size,
          })),
        );
      } else {
        sendJsonResponse(
          res,
          200,
          {
            type: 'file',
            encoding: 'base64',
            content: content.content,
            sha: content.sha,
            size: content.size,
            name: content.name,
            path: content.path,
          },
        );
      }
      return true;
    }

    if (method === 'DELETE') {
      const message = body?.message ?? 'delete';
      const expectedSha = body?.sha;
      const branch = body?.branch;
      try {
        const result = store.deleteContent(owner, repoName, filePath, message, {
          branch,
          expectedSha,
        });
        sendJsonResponse(res, 200, { commit: { sha: result.commitSha } });
      } catch (err: any) {
        if (err instanceof ConflictError || err.statusCode === 409) {
          sendJsonResponse(res, 409, { message: err.message });
          return true;
        }
        if (err instanceof NotFoundError || err.statusCode === 404) {
          sendJsonResponse(res, 404, { message: err.message });
          return true;
        }
        sendJsonResponse(res, 500, { message: err.message });
      }
      return true;
    }
  }

  // Labels: POST, GET /api/v3/repos/:owner/:repo/labels
  if (subPath === '/labels') {
    if (method === 'POST') {
      if (!body || !body.name) {
        sendJsonResponse(res, 400, { message: 'Label name required' });
        return true;
      }
      const label = store.createLabel(owner, repoName, body.name, body.color, body.description);
      sendJsonResponse(res, 201, { id: label.id, name: label.name, color: label.color });
      return true;
    }

    if (method === 'GET') {
      const labels = store.listLabels(owner, repoName);
      sendJsonResponse(res, 200, labels.map((l) => ({ id: l.id, name: l.name, color: l.color })));
      return true;
    }
  }

  // Issues: POST, GET /api/v3/repos/:owner/:repo/issues
  if (subPath === '/issues') {
    if (method === 'POST') {
      try {
        const issue = store.createIssue(owner, repoName, {
          title: body?.title ?? '',
          body: body?.body,
          labels: body?.labels,
        });
        sendJsonResponse(res, 201, formatIssue(issue));
      } catch (err: any) {
        if (err instanceof ValidationError || err.statusCode === 422) {
          sendJsonResponse(res, 422, { message: err.message });
          return true;
        }
        sendJsonResponse(res, 500, { message: err.message });
      }
      return true;
    }

    if (method === 'GET') {
      const state = (searchParams.get('state') ?? 'open') as 'open' | 'closed' | 'all';
      const sort = (searchParams.get('sort') ?? 'created') as 'created' | 'updated' | 'comments';
      const direction = (searchParams.get('direction') ?? 'desc') as 'asc' | 'desc';
      const perPage = searchParams.has('per_page') ? parseInt(searchParams.get('per_page')!, 10) : undefined;
      const page = searchParams.has('page') ? parseInt(searchParams.get('page')!, 10) : undefined;

      const issues = store.listIssues(owner, repoName, {
        state,
        sort,
        direction,
        perPage,
        page,
      });
      sendJsonResponse(res, 200, issues.map(formatIssue));
      return true;
    }
  }

  // One Issue: GET, PATCH /api/v3/repos/:owner/:repo/issues/:number
  const issueMatch = subPath.match(/^\/issues\/(\d+)$/);
  if (issueMatch) {
    const issueNum = parseInt(issueMatch[1] ?? '0', 10);
    if (method === 'GET') {
      const issue = store.getIssue(owner, repoName, issueNum);
      if (!issue) {
        sendJsonResponse(res, 404, { message: 'Not Found' });
        return true;
      }
      let cached = (issue as any)._cachedBuf;
      if (!cached) {
        const text = `${JSON.stringify(formatIssue(issue))}\n`;
        cached = Buffer.from(text, 'utf8');
        (issue as any)._cachedBuf = cached;
      }
      const requestId = (res.getHeader('x-github-request-id') as string) || `req_${(restReqSeq = (restReqSeq + 1) | 0)}`;
      res.writeHead(200, {
        'content-type': JSON_TYPE,
        'content-length': cached.length,
        'x-github-request-id': requestId,
      });
      res.end(cached);
      return true;
    }

    if (method === 'PATCH') {
      const updated = store.updateIssue(owner, repoName, issueNum, {
        state: body?.state,
        title: body?.title,
        body: body?.body,
        labels: body?.labels,
      });
      if (!updated) {
        sendJsonResponse(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJsonResponse(res, 200, formatIssue(updated));
      return true;
    }
  }

  // Issue Comments: POST, GET /api/v3/repos/:owner/:repo/issues/:number/comments
  const commentMatch = subPath.match(/^\/issues\/(\d+)\/comments$/);
  if (commentMatch) {
    const issueNum = parseInt(commentMatch[1] ?? '0', 10);
    if (method === 'POST') {
      try {
        const comment = store.createIssueComment(owner, repoName, issueNum, body?.body ?? '');
        sendJsonResponse(res, 201, { id: comment.id, body: comment.body });
      } catch (err: any) {
        if (err instanceof NotFoundError || err.statusCode === 404) {
          sendJsonResponse(res, 404, { message: err.message });
          return true;
        }
        sendJsonResponse(res, 500, { message: err.message });
      }
      return true;
    }

    if (method === 'GET') {
      const comments = store.listIssueComments(owner, repoName, issueNum);
      sendJsonResponse(
        res,
        200,
        comments.map((c) => ({ id: c.id, body: c.body })),
      );
      return true;
    }
  }

  // Pulls: POST, GET /api/v3/repos/:owner/:repo/pulls
  if (subPath === '/pulls') {
    if (method === 'POST') {
      try {
        const pr = store.createPullRequest(owner, repoName, {
          head: body?.head,
          base: body?.base,
          title: body?.title ?? '',
          body: body?.body ?? '',
        });
        sendJsonResponse(res, 201, formatPull(pr));
      } catch (err: any) {
        if (err instanceof ValidationError || err.statusCode === 422) {
          sendJsonResponse(res, 422, { message: err.message });
          return true;
        }
        sendJsonResponse(res, 500, { message: err.message });
      }
      return true;
    }

    if (method === 'GET') {
      const state = (searchParams.get('state') ?? 'open') as 'open' | 'closed' | 'all';
      const perPage = searchParams.has('per_page') ? parseInt(searchParams.get('per_page')!, 10) : undefined;
      const page = searchParams.has('page') ? parseInt(searchParams.get('page')!, 10) : undefined;

      const pulls = store.listPullRequests(owner, repoName, { state, perPage, page });
      sendJsonResponse(res, 200, pulls.map(formatPull));
      return true;
    }
  }

  // One Pull: GET /api/v3/repos/:owner/:repo/pulls/:number
  const pullMatch = subPath.match(/^\/pulls\/(\d+)$/);
  if (pullMatch) {
    const pullNum = parseInt(pullMatch[1] ?? '0', 10);
    if (method === 'GET') {
      const pr = store.getPullRequest(owner, repoName, pullNum);
      if (!pr) {
        sendJsonResponse(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJsonResponse(res, 200, formatPull(pr));
      return true;
    }
  }

  // Pull Files: GET /api/v3/repos/:owner/:repo/pulls/:number/files
  const pullFilesMatch = subPath.match(/^\/pulls\/(\d+)\/files$/);
  if (pullFilesMatch) {
    const pullNum = parseInt(pullFilesMatch[1] ?? '0', 10);
    if (method === 'GET') {
      const pr = store.getPullRequest(owner, repoName, pullNum);
      if (!pr) {
        sendJsonResponse(res, 404, { message: 'Not Found' });
        return true;
      }
      const files = store.listPullRequestFiles(owner, repoName, pullNum);
      sendJsonResponse(
        res,
        200,
        files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
      );
      return true;
    }
  }

  // Merge Pull: PUT /api/v3/repos/:owner/:repo/pulls/:number/merge
  const pullMergeMatch = subPath.match(/^\/pulls\/(\d+)\/merge$/);
  if (pullMergeMatch) {
    const pullNum = parseInt(pullMergeMatch[1] ?? '0', 10);
    if (method === 'PUT') {
      try {
        const result = store.mergePullRequest(owner, repoName, pullNum, {
          mergeMethod: body?.merge_method,
          commitMessage: body?.commit_message,
        });
        sendJsonResponse(
          res,
          200,
          {
            merged: result.merged,
            sha: result.sha,
            message: result.message,
          },
        );
      } catch (err: any) {
        if (err instanceof ConflictError || err.statusCode === 405) {
          sendJsonResponse(res, 405, { message: err.message });
          return true;
        }
        if (err instanceof NotFoundError || err.statusCode === 404) {
          sendJsonResponse(res, 404, { message: err.message });
          return true;
        }
        sendJsonResponse(res, 500, { message: err.message });
      }
      return true;
    }
  }

  // Any other route under /api/v3 is a 404
  sendJsonResponse(res, 404, { message: 'Not Found' });
  return true;
}
