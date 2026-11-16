import type { IncomingMessage, ServerResponse } from 'node:http';
import { store } from './store.ts';
import { sendJson } from './app.ts';

// ---------------------------------------------------------------------------------------------
// GraphQL AST & Types
// ---------------------------------------------------------------------------------------------

type TokenType = 'NAME' | 'STRING' | 'INT' | 'FLOAT' | 'PUNCT' | 'SPREAD';

interface Token {
  type: TokenType;
  value: string;
  line: number;
}

interface Selection {
  alias?: string;
  name: string;
  args: Record<string, any>;
  selections: Selection[];
  onType?: string;
}

interface ExecutionContext {
  errors: Array<{ message: string; locations?: { line: number; column: number }[] }>;
  variables: Record<string, any>;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'SPREAD', value: '...', line });
      i += 3;
      continue;
    }
    if ('{}():!$[]'.includes(ch)) {
      tokens.push({ type: 'PUNCT', value: ch, line });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let str = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          str += source[i + 1];
          i += 2;
        } else {
          str += source[i];
          i += 1;
        }
      }
      i += 1; // skip closing "
      tokens.push({ type: 'STRING', value: str, line });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let num = '';
      while (i < source.length && /[0-9.-]/.test(source[i])) {
        num += source[i];
        i += 1;
      }
      tokens.push({ type: num.includes('.') ? 'FLOAT' : 'INT', value: num, line });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let name = '';
      while (i < source.length && /[a-zA-Z0-9_]/.test(source[i])) {
        name += source[i];
        i += 1;
      }
      tokens.push({ type: 'NAME', value: name, line });
      continue;
    }
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

class Parser {
  idx = 0;
  tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.idx];
  }

  next(): Token | undefined {
    return this.tokens[this.idx++];
  }

  consume(type: TokenType, value?: string): Token {
    const tok = this.next();
    if (!tok || tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new Error(`Expected token ${type}${value ? ` '${value}'` : ''}, got ${tok ? `${tok.type} '${tok.value}'` : 'EOF'}`);
    }
    return tok;
  }
}

function parseValue(p: Parser, variables?: Record<string, any>): any {
  const tok = p.peek();
  if (!tok) return null;
  if (tok.value === '$') {
    p.next(); // consume $
    const varName = p.consume('NAME').value;
    return variables ? variables[varName] : undefined;
  }
  if (tok.type === 'STRING') {
    p.next();
    return tok.value;
  }
  if (tok.type === 'INT') {
    p.next();
    return parseInt(tok.value, 10);
  }
  if (tok.type === 'FLOAT') {
    p.next();
    return parseFloat(tok.value);
  }
  if (tok.type === 'NAME') {
    p.next();
    if (tok.value === 'true') return true;
    if (tok.value === 'false') return false;
    if (tok.value === 'null') return null;
    return tok.value;
  }
  if (tok.value === '[') {
    p.next(); // consume [
    const arr: any[] = [];
    while (p.peek() && p.peek()!.value !== ']') {
      arr.push(parseValue(p, variables));
    }
    p.consume('PUNCT', ']');
    return arr;
  }
  if (tok.value === '{') {
    p.next(); // consume {
    const obj: Record<string, any> = {};
    while (p.peek() && p.peek()!.value !== '}') {
      const key = p.consume('NAME').value;
      p.consume('PUNCT', ':');
      obj[key] = parseValue(p, variables);
    }
    p.consume('PUNCT', '}');
    return obj;
  }
  p.next();
  return null;
}

function parseSelectionSet(p: Parser, variables?: Record<string, any>): Selection[] {
  p.consume('PUNCT', '{');
  const selections: Selection[] = [];
  while (p.peek() && p.peek()!.value !== '}') {
    if (p.peek()!.type === 'SPREAD') {
      p.next(); // consume ...
      if (p.peek() && p.peek()!.value === 'on') {
        p.next(); // consume on
        const onType = p.consume('NAME').value;
        const sub = parseSelectionSet(p, variables);
        selections.push({
          name: '...',
          onType,
          args: {},
          selections: sub,
        });
        continue;
      }
    }
    const first = p.consume('NAME').value;
    let alias: string | undefined;
    let name = first;
    if (p.peek() && p.peek()!.value === ':') {
      p.next(); // consume :
      alias = first;
      name = p.consume('NAME').value;
    }
    const args: Record<string, any> = {};
    if (p.peek() && p.peek()!.value === '(') {
      p.next(); // consume (
      while (p.peek() && p.peek()!.value !== ')') {
        const argName = p.consume('NAME').value;
        p.consume('PUNCT', ':');
        args[argName] = parseValue(p, variables);
      }
      p.consume('PUNCT', ')');
    }
    let sub: Selection[] = [];
    if (p.peek() && p.peek()!.value === '{') {
      sub = parseSelectionSet(p, variables);
    }
    selections.push({
      alias,
      name,
      args,
      selections: sub,
    });
  }
  p.consume('PUNCT', '}');
  return selections;
}

function parseOperation(tokens: Token[], variables?: Record<string, any>): { type: 'query' | 'mutation'; selections: Selection[] } {
  const p = new Parser(tokens);
  let opType: 'query' | 'mutation' = 'query';
  if (p.peek() && (p.peek()!.value === 'query' || p.peek()!.value === 'mutation')) {
    opType = p.next()!.value as 'query' | 'mutation';
    if (p.peek() && p.peek()!.type === 'NAME') {
      p.next();
    }
    if (p.peek() && p.peek()!.value === '(') {
      p.next();
      while (p.peek() && p.peek()!.value !== ')') {
        p.next();
      }
      p.consume('PUNCT', ')');
    }
  }
  const selections = parseSelectionSet(p, variables);
  return { type: opType, selections };
}

// ---------------------------------------------------------------------------------------------
// Resolvers & Helpers
// ---------------------------------------------------------------------------------------------

function toCursor(issue: { number: number }): string {
  return Buffer.from(`cursor:${issue.number}`).toString('base64');
}

function findRepoById(repoId: string | number | undefined): any {
  if (repoId === undefined || repoId === null) return undefined;
  if (typeof repoId === 'string') {
    const parsed = store.fromGlobalId(repoId);
    if (parsed) {
      const r = store.getRepoById(parsed.id);
      if (r) return r;
    }
  }
  for (const r of store.listRepos()) {
    if (r.globalId === repoId || String(r.id) === String(repoId) || String(r.databaseId) === String(repoId)) {
      return r;
    }
  }
  return undefined;
}

function findIssueByGlobalId(globalId: string): { owner: string; repo: string; issue: any } | undefined {
  const indexed = (store as any).globalIdIndex?.get(globalId);
  if (indexed && indexed.repoKey) {
    const [owner, repo] = indexed.repoKey.split('/');
    const issue = store.getNode(globalId);
    if (issue) return { owner, repo, issue };
  }
  const parsed = store.fromGlobalId(globalId);
  if (parsed) {
    for (const r of store.listRepos()) {
      for (const iss of store.listIssues(r.owner, r.name, { state: 'all' })) {
        if (iss.id === parsed.id || iss.globalId === globalId) {
          return { owner: r.owner, repo: r.name, issue: iss };
        }
      }
    }
  }
  return undefined;
}

function findPullRequestByGlobalId(globalId: string): { owner: string; repo: string; pr: any } | undefined {
  const indexed = (store as any).globalIdIndex?.get(globalId);
  if (indexed && indexed.repoKey) {
    const [owner, repo] = indexed.repoKey.split('/');
    const pr = store.getNode(globalId);
    if (pr) return { owner, repo, pr };
  }
  const parsed = store.fromGlobalId(globalId);
  if (parsed) {
    for (const r of store.listRepos()) {
      for (const pr of store.listPullRequests(r.owner, r.name, { state: 'all' })) {
        if (pr.id === parsed.id || pr.globalId === globalId) {
          return { owner: r.owner, repo: r.name, pr };
        }
      }
    }
  }
  return undefined;
}

function resolveViewer(sel: Selection, context: ExecutionContext): any {
  const viewer = store.getViewer();
  const obj: Record<string, any> = {};
  for (const child of sel.selections) {
    if (child.name === 'login') {
      obj[child.alias || child.name] = viewer.login;
    } else if (child.name === 'name') {
      obj[child.alias || child.name] = viewer.name;
    } else if (child.name === 'id') {
      obj[child.alias || child.name] = store.toGlobalId('User' as any, viewer.id);
    } else {
      context.errors.push({ message: `Field '${child.name}' doesn't exist on type 'User'` });
    }
  }
  return obj;
}

function resolveType(sel: Selection, _context: ExecutionContext): any {
  const typeName = sel.args['name'];
  const typeDefs: Record<string, { fields?: string[]; enumValues?: string[] }> = {
    Issue: {
      fields: ['id', 'number', 'title', 'state', 'body'],
    },
    PullRequest: {
      fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    },
    Repository: {
      fields: [
        'id',
        'databaseId',
        'name',
        'nameWithOwner',
        'owner',
        'defaultBranchRef',
        'viewerPermission',
        'hasIssuesEnabled',
        'issue',
        'issues',
        'pullRequests',
        'pullRequest',
      ],
    },
    SearchType: {
      enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'PULL_REQUEST'],
    },
  };

  const def = typeDefs[typeName];
  if (!def) return null;

  const result: Record<string, any> = { name: typeName };
  for (const child of sel.selections) {
    if (child.name === 'fields' && def.fields) {
      result[child.alias || child.name] = def.fields.map((f) => ({ name: f }));
    } else if (child.name === 'enumValues' && def.enumValues) {
      result[child.alias || child.name] = def.enumValues.map((e) => ({ name: e }));
    }
  }
  return result;
}

function resolveNode(sel: Selection, _context: ExecutionContext): any {
  const id = sel.args['id'];
  if (!id) return null;
  const repo = findRepoById(id);
  if (!repo) return null;

  const result: Record<string, any> = {
    __typename: 'Repository',
  };

  function applySelections(selections: Selection[]): void {
    for (const child of selections) {
      if (child.name === '...') {
        if (child.onType === 'Repository') {
          applySelections(child.selections);
        }
      } else if (child.name === 'id') {
        result[child.alias || child.name] = repo.globalId;
      } else if (child.name === 'name') {
        result[child.alias || child.name] = repo.name;
      } else if (child.name === 'nameWithOwner') {
        result[child.alias || child.name] = `${repo.owner}/${repo.name}`;
      }
    }
  }

  applySelections(sel.selections);
  return result;
}

function resolveRepository(sel: Selection, context: ExecutionContext): any {
  const owner = sel.args['owner'];
  const name = sel.args['name'];
  if (!owner || !name) return null;
  const repo = store.getRepo(owner, name);
  if (!repo) return null; // Unknown repository: data.repository = null and no errors

  const result: Record<string, any> = {};

  for (const child of sel.selections) {
    const key = child.alias || child.name;
    if (child.name === 'id') {
      result[key] = repo.globalId;
    } else if (child.name === 'databaseId') {
      result[key] = repo.databaseId;
    } else if (child.name === 'name') {
      result[key] = repo.name;
    } else if (child.name === 'nameWithOwner') {
      result[key] = `${repo.owner}/${repo.name}`;
    } else if (child.name === 'owner') {
      result[key] = { login: repo.owner };
    } else if (child.name === 'defaultBranchRef') {
      const tip = store.resolveRef(owner, name, `refs/heads/${repo.defaultBranch}`);
      result[key] = tip ? { name: repo.defaultBranch } : null;
    } else if (child.name === 'viewerPermission') {
      result[key] = 'ADMIN';
    } else if (child.name === 'hasIssuesEnabled') {
      result[key] = true;
    } else if (child.name === 'issue') {
      const issueNum = child.args['number'];
      const issue = store.getIssue(owner, name, issueNum);
      if (!issue) {
        result[key] = null;
      } else {
        result[key] = {
          id: issue.globalId,
          number: issue.number,
          title: issue.title,
          state: issue.state.toUpperCase(),
          body: issue.body,
        };
      }
    } else if (child.name === 'issues') {
      const first = child.args['first'] ?? 10;
      const states = child.args['states'] as string[] | undefined;
      const orderBy = child.args['orderBy'] as { field?: string; direction?: string } | undefined;
      const after = child.args['after'] as string | undefined | null;

      let list = store.listIssues(owner, name, { state: 'all' });
      if (states && states.length > 0) {
        const lowerStates = states.map((s) => s.toLowerCase());
        list = list.filter((i) => lowerStates.includes(i.state));
      }

      if (orderBy && orderBy.direction === 'DESC') {
        list.sort((a, b) => b.number - a.number);
      } else {
        list.sort((a, b) => a.number - b.number);
      }

      let start = 0;
      if (after) {
        const afterIdx = list.findIndex((i) => toCursor(i) === after);
        if (afterIdx >= 0) {
          start = afterIdx + 1;
        }
      }

      const paged = list.slice(start, start + first);
      const hasNextPage = start + first < list.length;
      const endCursor = paged.length > 0 ? toCursor(paged[paged.length - 1]!) : null;

      const nodes = paged.map((i) => ({
        id: i.globalId,
        number: i.number,
        title: i.title,
        state: i.state.toUpperCase(),
        body: i.body,
      }));

      result[key] = {
        nodes,
        pageInfo: {
          hasNextPage,
          endCursor,
        },
      };
    } else if (child.name === 'pullRequest') {
      const prNum = child.args['number'];
      const pr = store.getPullRequest(owner, name, prNum);
      if (!pr) {
        result[key] = null;
      } else {
        result[key] = {
          id: pr.globalId,
          number: pr.number,
          headRefName: pr.head.ref,
          baseRefName: pr.base.ref,
          mergeable: pr.mergeable ?? 'MERGEABLE',
          state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
          merged: pr.merged,
          files: {
            nodes: pr.files.map((f) => ({ path: f.filename })),
          },
        };
      }
    } else if (child.name === 'pullRequests') {
      const first = child.args['first'] ?? 10;
      const pulls = store.listPullRequests(owner, name, { state: 'all' });
      const paged = pulls.slice(0, first);
      result[key] = {
        nodes: paged.map((pr) => ({
          id: pr.globalId,
          number: pr.number,
          headRefName: pr.head.ref,
          baseRefName: pr.base.ref,
          mergeable: pr.mergeable ?? 'MERGEABLE',
          state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
          merged: pr.merged,
        })),
      };
    } else {
      context.errors.push({ message: `Field '${child.name}' doesn't exist on type 'Repository'` });
    }
  }

  return result;
}

function resolveCreateIssue(sel: Selection, context: ExecutionContext): any {
  const input = sel.args['input'] ?? {};
  const repo = findRepoById(input.repositoryId);
  if (!repo) {
    context.errors.push({ message: `Repository not found for id ${input.repositoryId}` });
    return null;
  }
  const issue = store.createIssue(repo.owner, repo.name, {
    title: input.title,
    body: input.body ?? '',
  });
  return {
    issue: {
      id: issue.globalId,
      number: issue.number,
    },
  };
}

function resolveCloseIssue(sel: Selection, context: ExecutionContext): any {
  const input = sel.args['input'] ?? {};
  const found = findIssueByGlobalId(input.issueId);
  if (!found) {
    context.errors.push({ message: `Issue not found for id ${input.issueId}` });
    return null;
  }
  const updated = store.updateIssue(found.owner, found.repo, found.issue.number, { state: 'closed' });
  return {
    issue: {
      id: updated?.globalId ?? input.issueId,
      number: updated?.number ?? found.issue.number,
      state: 'CLOSED',
    },
  };
}

function resolveCreatePullRequest(sel: Selection, context: ExecutionContext): any {
  const input = sel.args['input'] ?? {};
  const repo = findRepoById(input.repositoryId);
  if (!repo) {
    context.errors.push({ message: `Repository not found for id ${input.repositoryId}` });
    return null;
  }
  const pr = store.createPullRequest(repo.owner, repo.name, {
    title: input.title,
    head: input.headRefName,
    base: input.baseRefName,
  });
  return {
    pullRequest: {
      id: pr.globalId,
      number: pr.number,
      state: 'OPEN',
      headRefName: pr.head.ref,
      baseRefName: pr.base.ref,
    },
  };
}

function resolveMergePullRequest(sel: Selection, context: ExecutionContext): any {
  const input = sel.args['input'] ?? {};
  const found = findPullRequestByGlobalId(input.pullRequestId);
  if (!found) {
    context.errors.push({ message: `PullRequest not found for id ${input.pullRequestId}` });
    return null;
  }
  const method = (input.mergeMethod?.toLowerCase() || 'squash') as 'squash' | 'merge' | 'rebase';
  store.mergePullRequest(found.owner, found.repo, found.pr.number, { mergeMethod: method });
  return {
    pullRequest: {
      number: found.pr.number,
      merged: true,
      state: 'MERGED',
    },
  };
}

function resolveAddComment(sel: Selection, context: ExecutionContext): any {
  const input = sel.args['input'] ?? {};
  const found = findIssueByGlobalId(input.subjectId);
  if (!found) {
    context.errors.push({ message: `Subject not found for id ${input.subjectId}` });
    return null;
  }
  const comment = store.createIssueComment(found.owner, found.repo, found.issue.number, input.body);
  return {
    commentEdge: {
      node: {
        id: comment.globalId,
        body: comment.body,
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Operation Execution
// ---------------------------------------------------------------------------------------------

export function executeGraphQLOperation(op: { query?: string; variables?: Record<string, any>; operationName?: string }): { data?: any; errors?: any[] } {
  const context: ExecutionContext = {
    errors: [],
    variables: op.variables ?? {},
  };

  try {
    const tokens = tokenize(op.query ?? '');
    const operation = parseOperation(tokens, context.variables);
    const data: Record<string, any> = {};

    if (operation.type === 'query') {
      for (const sel of operation.selections) {
        const outputKey = sel.alias || sel.name;
        if (sel.name === 'viewer') {
          data[outputKey] = resolveViewer(sel, context);
        } else if (sel.name === '__type') {
          data[outputKey] = resolveType(sel, context);
        } else if (sel.name === 'node') {
          data[outputKey] = resolveNode(sel, context);
        } else if (sel.name === 'repository') {
          data[outputKey] = resolveRepository(sel, context);
        } else {
          context.errors.push({ message: `Field '${sel.name}' doesn't exist on type 'Query'` });
        }
      }
    } else if (operation.type === 'mutation') {
      for (const sel of operation.selections) {
        const outputKey = sel.alias || sel.name;
        if (sel.name === 'createIssue') {
          data[outputKey] = resolveCreateIssue(sel, context);
        } else if (sel.name === 'closeIssue') {
          data[outputKey] = resolveCloseIssue(sel, context);
        } else if (sel.name === 'createPullRequest') {
          data[outputKey] = resolveCreatePullRequest(sel, context);
        } else if (sel.name === 'mergePullRequest') {
          data[outputKey] = resolveMergePullRequest(sel, context);
        } else if (sel.name === 'addComment') {
          data[outputKey] = resolveAddComment(sel, context);
        } else {
          context.errors.push({ message: `Field '${sel.name}' doesn't exist on type 'Mutation'` });
        }
      }
    }

    const response: { data?: any; errors?: any[] } = {};
    if (Object.keys(data).length > 0) {
      response.data = data;
    } else if (context.errors.length === 0) {
      response.data = {};
    }
    if (context.errors.length > 0) {
      response.errors = context.errors;
    }
    return response;
  } catch (err: any) {
    return {
      errors: [{ message: err instanceof Error ? err.message : String(err) }],
    };
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP Request Handler
// ---------------------------------------------------------------------------------------------

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/api/graphql' && url.pathname !== '/api/graphql/') {
    return false;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  // Authentication check
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  const token = auth.slice('Bearer '.length).trim();
  if (token === '') {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;
  if (expectedToken && token !== expectedToken) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  // Read request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const bodyText = Buffer.concat(chunks).toString('utf8');

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }

  // Handle batched operations
  if (Array.isArray(body)) {
    const results = body.map((op) => executeGraphQLOperation(op));
    sendJson(res, 200, results);
    return true;
  }

  const result = executeGraphQLOperation(body);
  sendJson(res, 200, result);
  return true;
}

export const handleGraphql = handleGraphQL;
