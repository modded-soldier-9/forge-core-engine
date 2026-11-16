import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repository, type Issue, type PullRequest } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'The owner of the repository (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        title: { type: 'string', description: 'The title of the issue' },
        body: { type: 'string', description: 'The contents of the issue' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        state: { type: 'string', description: 'State of the issues to return (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        title: { type: 'string', description: 'The title of the new pull request' },
        body: { type: 'string', description: 'The contents of the pull request' },
        head: { type: 'string', description: 'The name of the branch where your changes are implemented' },
        base: { type: 'string', description: 'The name of the branch you want the changes pulled into' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        pull_number: { type: 'number', description: 'The number that identifies the pull request' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

function formatRepo(repo: Repository) {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: {
      login: repo.owner,
      id: store.getUser(repo.owner)?.id ?? 1000,
    },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function formatIssue(issue: Issue, owner: string, repo: string) {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: {
      login: issue.user.login,
      id: issue.user.id,
    },
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function formatPull(pr: PullRequest, owner: string, repo: string) {
  return {
    id: pr.id,
    node_id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: {
      ref: pr.head.ref,
      sha: pr.head.sha,
    },
    base: {
      ref: pr.base.ref,
      sha: pr.base.sha,
    },
    user: {
      login: pr.user.login,
      id: pr.user.id,
    },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
  };
}

function normalizeToolName(rawName: string): string | null {
  const name = rawName.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (name === 'create_repo' || name.endsWith('create_repo') || ['create_repository', 'repo_create', 'repos_create', 'repository_create'].some((a) => name.endsWith(a))) {
    return 'create_repo';
  }
  if (name === 'get_repo' || name.endsWith('get_repo') || ['get_repository', 'repo_get', 'repos_get', 'repository_get'].some((a) => name.endsWith(a))) {
    return 'get_repo';
  }
  if (name === 'create_issue' || name.endsWith('create_issue') || ['issue_create', 'issues_create'].some((a) => name.endsWith(a))) {
    return 'create_issue';
  }
  if (name === 'list_issues' || name.endsWith('list_issues') || ['issues_list', 'issue_list'].some((a) => name.endsWith(a))) {
    return 'list_issues';
  }
  if (name === 'create_pull_request' || name.endsWith('create_pull_request') || ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'].some((a) => name.endsWith(a))) {
    return 'create_pull_request';
  }
  if (name === 'merge_pull_request' || name.endsWith('merge_pull_request') || ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'].some((a) => name.endsWith(a))) {
    return 'merge_pull_request';
  }
  return null;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== '/mcp') return false;

  const method = req.method ?? 'GET';

  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const rawBody = await readBody(req);
  let rpcReq: any;
  try {
    rpcReq = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    });
    return true;
  }

  if (!rpcReq || typeof rpcReq !== 'object' || Array.isArray(rpcReq)) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    });
    return true;
  }

  const { id = null, method: rpcMethod, params } = rpcReq;

  // Check auth requirement for tools/call
  if (rpcMethod === 'tools/call') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      sendJson(res, 401, {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: 'Unauthorized: missing Authorization header',
        },
      });
      return true;
    }
  }

  switch (rpcMethod) {
    case 'server/discover': {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'forge-bot-mcp',
            version: '1.0.0',
          },
          _meta: {
            'io.modelcontextprotocol/serverInfo': {
              name: 'forge-bot-mcp',
              version: '1.0.0',
            },
          },
        },
      });
      return true;
    }

    case 'initialize': {
      const requestedVersion = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'forge-bot-mcp',
            version: '1.0.0',
          },
        },
      });
      return true;
    }

    case 'notifications/initialized': {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        result: {},
      });
      return true;
    }

    case 'tools/list': {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS,
        },
      });
      return true;
    }

    case 'tools/call': {
      const toolName = typeof params?.name === 'string' ? params.name : '';
      const canonical = normalizeToolName(toolName);

      if (!canonical) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Unknown tool: ${toolName}`,
          },
        });
        return true;
      }

      const args = (params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
        ? params.arguments
        : {};

      try {
        if (canonical === 'create_repo') {
          const repoName = args.name ?? args.repo ?? args.repository;
          if (!repoName || typeof repoName !== 'string' || repoName.trim() === '') {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Missing required argument: name',
              },
            });
            return true;
          }

          const owner = (typeof args.owner === 'string' && args.owner.trim() !== '')
            ? args.owner.trim()
            : store.getViewer().login;

          if (!store.getUser(owner)) {
            store.createUser({ id: 1000, login: owner, name: owner, email: `${owner}@example.invalid` });
          }

          let repo = store.getRepo(owner, repoName.trim());
          if (!repo) {
            repo = store.createRepo(owner, repoName.trim(), {
              description: typeof args.description === 'string' ? args.description : '',
              private: Boolean(args.private ?? args.is_private),
            });
          }

          const formatted = formatRepo(repo);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          });
          return true;
        }

        if (canonical === 'get_repo') {
          let owner = typeof args.owner === 'string' ? args.owner.trim() : undefined;
          let repo = typeof args.repo === 'string' ? args.repo.trim() : (typeof args.name === 'string' ? args.name.trim() : undefined);
          if (!owner && typeof args.full_name === 'string' && args.full_name.includes('/')) {
            const parts = args.full_name.split('/', 2);
            owner = parts[0];
            repo = parts[1];
          }

          if (!owner || !repo) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Missing required arguments: owner, repo',
              },
            });
            return true;
          }

          const found = store.getRepo(owner, repo);
          if (!found) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: {
                isError: true,
                content: [{ type: 'text', text: `Repository ${owner}/${repo} not found` }],
              },
            });
            return true;
          }

          const formatted = formatRepo(found);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          });
          return true;
        }

        if (canonical === 'create_issue') {
          let owner = typeof args.owner === 'string' ? args.owner.trim() : undefined;
          let repo = typeof args.repo === 'string' ? args.repo.trim() : undefined;
          if (!owner && typeof args.full_name === 'string' && args.full_name.includes('/')) {
            const parts = args.full_name.split('/', 2);
            owner = parts[0];
            repo = parts[1];
          }
          const title = typeof args.title === 'string' ? args.title.trim() : undefined;

          if (!owner || !repo || !title) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Missing required arguments: owner, repo, title',
              },
            });
            return true;
          }

          const body = typeof args.body === 'string' ? args.body : '';
          const issue = store.createIssue(owner, repo, { title, body });
          const formatted = formatIssue(issue, owner, repo);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          });
          return true;
        }

        if (canonical === 'list_issues') {
          let owner = typeof args.owner === 'string' ? args.owner.trim() : undefined;
          let repo = typeof args.repo === 'string' ? args.repo.trim() : undefined;
          if (!owner && typeof args.full_name === 'string' && args.full_name.includes('/')) {
            const parts = args.full_name.split('/', 2);
            owner = parts[0];
            repo = parts[1];
          }

          if (!owner || !repo) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Missing required arguments: owner, repo',
              },
            });
            return true;
          }

          const stateFilter = (typeof args.state === 'string' && ['open', 'closed', 'all'].includes(args.state))
            ? (args.state as 'open' | 'closed' | 'all')
            : 'open';

          const issues = store.listIssues(owner, repo, { state: stateFilter });
          const formatted = issues.map((i) => formatIssue(i, owner, repo));
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          });
          return true;
        }

        if (canonical === 'create_pull_request') {
          let owner = typeof args.owner === 'string' ? args.owner.trim() : undefined;
          let repo = typeof args.repo === 'string' ? args.repo.trim() : undefined;
          if (!owner && typeof args.full_name === 'string' && args.full_name.includes('/')) {
            const parts = args.full_name.split('/', 2);
            owner = parts[0];
            repo = parts[1];
          }
          const title = typeof args.title === 'string' ? args.title.trim() : undefined;
          const head = typeof args.head === 'string' ? args.head.trim() : (typeof args.head_ref === 'string' ? args.head_ref.trim() : undefined);
          const base = typeof args.base === 'string' ? args.base.trim() : (typeof args.base_ref === 'string' ? args.base_ref.trim() : undefined);

          if (!owner || !repo || !title || !head || !base) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Missing required arguments: owner, repo, title, head, base',
              },
            });
            return true;
          }

          const body = typeof args.body === 'string' ? args.body : '';
          const pr = store.createPullRequest(owner, repo, { title, body, head, base });
          const formatted = formatPull(pr, owner, repo);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(formatted) }],
              structuredContent: formatted,
            },
          });
          return true;
        }

        if (canonical === 'merge_pull_request') {
          let owner = typeof args.owner === 'string' ? args.owner.trim() : undefined;
          let repo = typeof args.repo === 'string' ? args.repo.trim() : undefined;
          if (!owner && typeof args.full_name === 'string' && args.full_name.includes('/')) {
            const parts = args.full_name.split('/', 2);
            owner = parts[0];
            repo = parts[1];
          }
          const pullNum = args.pull_number !== undefined ? Number(args.pull_number) : (args.number !== undefined ? Number(args.number) : NaN);

          if (!owner || !repo || Number.isNaN(pullNum)) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Missing required arguments: owner, repo, pull_number',
              },
            });
            return true;
          }

          const mergeRes = store.mergePullRequest(owner, repo, pullNum);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(mergeRes) }],
              structuredContent: mergeRes,
            },
          });
          return true;
        }
      } catch (err) {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          },
        });
        return true;
      }

      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${canonical}`,
        },
      });
      return true;
    }

    default: {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${rpcMethod}`,
        },
      });
      return true;
    }
  }
}
