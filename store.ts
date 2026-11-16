import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------------------------
// Git object types & helpers
// ---------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

export interface BuildTagFields {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger?: string;
  readonly message: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_IDENTITY = 'Conformance <conformance@make.fun>';

/** Convert Uint8Array | Buffer into a Buffer. */
export function asBuffer(data: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** Compute SHA-1 object id for a git object: SHA1("<type> <size>\0<data>"). */
export function hashGitObject(type: GitObjectType, data: Uint8Array | Buffer): string {
  const buf = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(`${type} ${buf.length}\0`);
  hash.update(buf);
  return hash.digest('hex');
}

/** Loose git object encoding: "<type> <size>\0" + data. */
export function encodeLooseObject(type: GitObjectType, data: Uint8Array | Buffer): Buffer {
  const buf = asBuffer(data);
  const header = Buffer.from(`${type} ${buf.length}\0`, 'utf8');
  return Buffer.concat([header, buf]);
}

/** git's tree entry sorting: mode 40000 (tree/dir) is compared as if name had trailing slash '/'. */
function compareTreeNames(a: { readonly name: string; readonly mode: string }, b: { readonly name: string; readonly mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Parse a tree git object into sorted TreeEntry items. */
export function parseTree(data: Uint8Array | Buffer): TreeEntry[] {
  const buf = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = buf.indexOf(0x00, space + 1);
    if (nul < 0) break;
    if (nul + 21 > buf.length) break;
    const mode = buf.subarray(offset, space).toString('ascii');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree git object buffer from TreeEntry items. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit git object into CommitView. */
export function parseCommit(data: Uint8Array | Buffer): CommitView {
  const buf = asBuffer(data);
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const headerText = buf.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit git object buffer. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const timezone = fields.timezone ?? '+0000';
  const authorLine = fields.author?.includes('@') && fields.author.includes('>') && /\d+\s+[+-]\d{4}/.test(fields.author)
    ? fields.author
    : `${fields.author ?? DEFAULT_IDENTITY} ${timestamp} ${timezone}`;
  const committerLine = fields.committer?.includes('@') && fields.committer.includes('>') && /\d+\s+[+-]\d{4}/.test(fields.committer)
    ? fields.committer
    : `${fields.committer ?? DEFAULT_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${authorLine}`, `committer ${committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse a tag git object into TagView. */
export function parseTag(data: Uint8Array | Buffer): TagView {
  const buf = asBuffer(data);
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const headerText = buf.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value as GitObjectType;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

/** Build a tag git object buffer. */
export function buildTag(fields: BuildTagFields): Buffer {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const timezone = fields.timezone ?? '+0000';
  const tagger = fields.tagger ?? `${DEFAULT_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`object ${fields.object}`, `type ${fields.type}`, `tag ${fields.tag}`, `tagger ${tagger}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Entity Models
// ---------------------------------------------------------------------------------------------

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Repository {
  readonly id: number;
  readonly databaseId: number;
  readonly globalId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitRef {
  readonly name: string;
  readonly target: string;
  readonly isSymbolic?: boolean;
}

export interface Branch {
  readonly name: string;
  readonly commitSha: string;
}

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly id: number;
  readonly globalId: string;
  readonly body: string;
  readonly user: User;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly databaseId: number;
  readonly globalId: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: Label[];
  readonly user: User;
  readonly comments: IssueComment[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha?: string;
}

export interface PullRequest {
  readonly id: number;
  readonly databaseId: number;
  readonly globalId: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly head: {
    readonly ref: string;
    readonly sha: string;
  };
  readonly base: {
    readonly ref: string;
    readonly sha: string;
  };
  readonly user: User;
  readonly files: PullFile[];
  readonly comments: IssueComment[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface ContentFile {
  readonly type: 'file';
  readonly name: string;
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly encoding: 'base64';
  readonly content: string;
}

export interface ContentDirEntry {
  readonly type: 'file' | 'dir';
  readonly name: string;
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export class StoreError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'StoreError';
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends StoreError {
  constructor(message = 'Not Found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends StoreError {
  constructor(message: string, statusCode = 409) {
    super(message, statusCode);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends StoreError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------------------------
// Internal Repository Storage
// ---------------------------------------------------------------------------------------------

class RefMap extends Map<string, string> {
  storage: RepoStorage;
  constructor(storage: RepoStorage) {
    super();
    this.storage = storage;
  }
  override set(key: string, value: string): this {
    super.set(key, value);
    this.storage.refs.set(key, { name: key, target: value, isSymbolic: false });
    return this;
  }
  override delete(key: string): boolean {
    const res = super.delete(key);
    this.storage.refs.delete(key);
    return res;
  }
}

class RepoStorage {
  repo: Repository;
  objects = new Map<string, GitObject>();
  refs = new Map<string, GitRef>();
  refMap: RefMap;
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, PullRequest>();
  issueCounter = 1;
  pullCounter = 1;
  labelCounter = 1;
  commentCounter = 1;

  constructor(repo: Repository) {
    this.repo = repo;
    this.refMap = new RefMap(this);
    (this.repo as any).refs = this.refMap;
    (this.repo as any).objects = this.objects;
    // Unborn HEAD points to default branch
    this.refs.set('HEAD', { name: 'HEAD', target: `refs/heads/${repo.defaultBranch}`, isSymbolic: true });
  }

  saveObject(type: GitObjectType, data: Buffer | Uint8Array): { oid: string; object: GitObject } {
    const buf = asBuffer(data);
    const oid = hashGitObject(type, buf);
    const object: GitObject = { type, data: buf };
    this.objects.set(oid, object);
    return { oid, object };
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid.toLowerCase());
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid.toLowerCase());
  }

  setRef(name: string, target: string, isSymbolic = false): void {
    this.refs.set(name, { name, target, isSymbolic });
    if (!isSymbolic) {
      Map.prototype.set.call(this.refMap, name, target);
    }
  }

  getRef(name: string): GitRef | undefined {
    return this.refs.get(name);
  }

  resolveRef(name: string): string | undefined {
    const seen = new Set<string>();
    let current = name;
    while (!seen.has(current)) {
      seen.add(current);
      const ref = this.refs.get(current);
      if (!ref) {
        // If not a named ref, check if it's already an existing commit oid
        if (/^[0-9a-f]{40}$/i.test(current) && this.hasObject(current)) return current.toLowerCase();
        return undefined;
      }
      if (ref.isSymbolic) {
        current = ref.target;
        continue;
      }
      return ref.target.toLowerCase();
    }
    return undefined;
  }

  deleteRef(name: string): boolean {
    Map.prototype.delete.call(this.refMap, name);
    return this.refs.delete(name);
  }

  listRefs(prefix?: string): GitRef[] {
    const result: GitRef[] = [];
    for (const [name, ref] of this.refs.entries()) {
      if (prefix === undefined || name.startsWith(prefix)) {
        result.push(ref);
      }
    }
    return result;
  }

  /** Recursively resolve all files (path -> { oid, mode }) at a given commit SHA. */
  getFilesAtCommit(commitSha: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const commitObj = this.getObject(commitSha);
    if (!commitObj || commitObj.type !== 'commit') return files;
    const commitView = parseCommit(commitObj.data);
    if (!commitView.tree) return files;

    const walk = (treeOid: string, currentPath: string): void => {
      const treeObj = this.getObject(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      const entries = parseTree(treeObj.data);
      for (const entry of entries) {
        const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
        if (entry.mode === '40000') {
          walk(entry.oid, fullPath);
        } else {
          files.set(fullPath, { oid: entry.oid, mode: entry.mode });
        }
      }
    };

    walk(commitView.tree, '');
    return files;
  }

  /** Build hierarchical tree git objects from a map of file paths to { oid, mode }. */
  buildTreesFromFiles(files: Map<string, { oid: string; mode: string }>): string {
    if (files.size === 0) {
      const emptyTree = buildTree([]);
      const { oid } = this.saveObject('tree', emptyTree);
      return oid;
    }

    // Collect all directory paths
    const dirs = new Set<string>(['']);
    for (const filePath of files.keys()) {
      const parts = filePath.split('/');
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i += 1) {
        prefix = prefix ? `${prefix}/${parts[i]}` : (parts[i] ?? '');
        dirs.add(prefix);
      }
    }

    // Sort directories from deepest to root
    const sortedDirs = [...dirs].sort((a, b) => {
      const depthA = a ? a.split('/').length : 0;
      const depthB = b ? b.split('/').length : 0;
      return depthB - depthA;
    });

    const dirTreeOids = new Map<string, string>();

    for (const dir of sortedDirs) {
      const entries: TreeEntry[] = [];
      const dirPrefix = dir ? `${dir}/` : '';

      // Direct files in this directory
      for (const [filePath, file] of files.entries()) {
        if (dir === '') {
          if (!filePath.includes('/')) {
            entries.push({ mode: file.mode, name: filePath, oid: file.oid });
          }
        } else if (filePath.startsWith(dirPrefix)) {
          const rest = filePath.slice(dirPrefix.length);
          if (!rest.includes('/')) {
            entries.push({ mode: file.mode, name: rest, oid: file.oid });
          }
        }
      }

      // Direct subdirectories in this directory
      for (const [subDir, subTreeOid] of dirTreeOids.entries()) {
        if (dir === '') {
          if (subDir && !subDir.includes('/')) {
            entries.push({ mode: '40000', name: subDir, oid: subTreeOid });
          }
        } else if (subDir.startsWith(dirPrefix)) {
          const rest = subDir.slice(dirPrefix.length);
          if (!rest.includes('/')) {
            entries.push({ mode: '40000', name: rest, oid: subTreeOid });
          }
        }
      }

      const treeBuf = buildTree(entries);
      const { oid } = this.saveObject('tree', treeBuf);
      dirTreeOids.set(dir, oid);
    }

    return dirTreeOids.get('') ?? '';
  }
}

// ---------------------------------------------------------------------------------------------
// In-Memory Store
// ---------------------------------------------------------------------------------------------

export class Store {
  users = new Map<string, User>(); // login -> User
  usersById = new Map<number, User>();
  repos = new Map<string, RepoStorage>(); // "owner/name" (lowercase) -> RepoStorage
  reposById = new Map<number, RepoStorage>();
  repoCounter = 5000;
  globalIdIndex = new Map<string, { type: 'Repository' | 'Issue' | 'PullRequest' | 'Comment'; id: number; repoKey?: string }>();

  constructor() {
    this.seedDefaultUsers();
  }

  private seedDefaultUsers(): void {
    const viewer: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
    const stranger: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };
    this.createUser(viewer);
    this.createUser(stranger);
  }

  // ---------------------------------------------------------------- users
  createUser(user: User): User {
    this.users.set(user.login.toLowerCase(), user);
    this.usersById.set(user.id, user);
    return user;
  }

  getUser(login: string): User | undefined {
    return this.users.get(login.toLowerCase());
  }

  getUserById(id: number): User | undefined {
    return this.usersById.get(id);
  }

  getViewer(): User {
    return this.getUser('adaiversen') ?? { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
  }

  listUsers(): User[] {
    return [...this.users.values()];
  }

  // ---------------------------------------------------------------- global ID (Relay)
  toGlobalId(type: 'Repository' | 'Issue' | 'PullRequest' | 'Comment', id: number): string {
    return Buffer.from(`${type}:${id}`).toString('base64');
  }

  fromGlobalId(globalId: string): { type: string; id: number } | undefined {
    try {
      const decoded = Buffer.from(globalId, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx < 0) return undefined;
      const type = decoded.slice(0, idx);
      const id = parseInt(decoded.slice(idx + 1), 10);
      return Number.isFinite(id) ? { type, id } : undefined;
    } catch {
      return undefined;
    }
  }

  getNode(globalId: string): unknown | undefined {
    const parsed = this.fromGlobalId(globalId);
    if (!parsed) return undefined;
    if (parsed.type === 'Repository') {
      const storage = this.reposById.get(parsed.id);
      return storage ? storage.repo : undefined;
    }
    const indexed = this.globalIdIndex.get(globalId);
    if (!indexed || !indexed.repoKey) return undefined;
    const storage = this.repos.get(indexed.repoKey);
    if (!storage) return undefined;
    if (indexed.type === 'Issue') {
      for (const issue of storage.issues.values()) {
        if (issue.id === indexed.id) return issue;
      }
    } else if (indexed.type === 'PullRequest') {
      for (const pr of storage.pulls.values()) {
        if (pr.id === indexed.id) return pr;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- repos
  private repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  createRepo(
    owner: string,
    name: string,
    options: { private?: boolean; description?: string; defaultBranch?: string } = {},
  ): Repository {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) {
      throw new ValidationError(`Repository ${owner}/${name} already exists`);
    }
    const id = this.repoCounter++;
    const defaultBranch = options.defaultBranch && options.defaultBranch.trim() !== '' ? options.defaultBranch.trim() : 'main';
    const now = new Date().toISOString();
    const globalId = this.toGlobalId('Repository', id);

    const repo: Repository = {
      id,
      databaseId: id,
      globalId,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
    };

    const storage = new RepoStorage(repo);
    this.repos.set(key, storage);
    this.reposById.set(id, storage);
    this.globalIdIndex.set(globalId, { type: 'Repository', id });
    return repo;
  }

  getRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(this.repoKey(owner, name))?.repo;
  }

  findRepo(owner: string, name: string): Repository | undefined {
    return this.getRepo(owner, name);
  }

  getRepoById(id: number): Repository | undefined {
    return this.reposById.get(id)?.repo;
  }

  private getStorage(owner: string, name: string): RepoStorage | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  updateRepo(owner: string, name: string, patch: { description?: string; private?: boolean; defaultBranch?: string }): Repository | undefined {
    const storage = this.getStorage(owner, name);
    if (!storage) return undefined;
    const current = storage.repo;
    const updated: Repository = {
      ...current,
      description: patch.description !== undefined ? patch.description : current.description,
      private: patch.private !== undefined ? patch.private : current.private,
      defaultBranch: patch.defaultBranch !== undefined ? patch.defaultBranch : current.defaultBranch,
      updatedAt: new Date().toISOString(),
    };
    storage.repo = updated;
    return updated;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    const storage = this.repos.get(key);
    if (!storage) return false;
    this.repos.delete(key);
    this.reposById.delete(storage.repo.id);
    this.globalIdIndex.delete(storage.repo.globalId);
    return true;
  }

  listRepos(owner?: string, options: { perPage?: number; page?: number } = {}): Repository[] {
    let list: Repository[] = [];
    for (const storage of this.repos.values()) {
      if (!owner || storage.repo.owner.toLowerCase() === owner.toLowerCase()) {
        list.push(storage.repo);
      }
    }
    // Sort by creation / id ascending
    list.sort((a, b) => a.id - b.id);
    if (options.page !== undefined || options.perPage !== undefined) {
      const perPage = Math.max(1, options.perPage ?? 30);
      const page = Math.max(1, options.page ?? 1);
      const start = (page - 1) * perPage;
      list = list.slice(start, start + perPage);
    }
    return list;
  }

  // ---------------------------------------------------------------- git objects
  saveObject(owner: string, repo: string, type: GitObjectType, data: Buffer | Uint8Array): { oid: string; object: GitObject } {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);
    return storage.saveObject(type, data);
  }

  getObject(owner: string, repo: string, oid: string): GitObject | undefined {
    return this.getStorage(owner, repo)?.getObject(oid);
  }

  hasObject(owner: string, repo: string, oid: string): boolean {
    return this.getStorage(owner, repo)?.hasObject(oid) ?? false;
  }

  listObjects(owner: string, repo: string): GitObject[] {
    const storage = this.getStorage(owner, repo);
    return storage ? [...storage.objects.values()] : [];
  }

  // ---------------------------------------------------------------- refs & branches
  setRef(owner: string, repo: string, refName: string, target: string, isSymbolic = false): void {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);
    storage.setRef(refName, target, isSymbolic);
  }

  getRef(owner: string, repo: string, refName: string): GitRef | undefined {
    return this.getStorage(owner, repo)?.getRef(refName);
  }

  resolveRef(owner: string, repo: string, refName: string): string | undefined {
    return this.getStorage(owner, repo)?.resolveRef(refName);
  }

  deleteRef(owner: string, repo: string, refName: string): boolean {
    return this.getStorage(owner, repo)?.deleteRef(refName) ?? false;
  }

  listRefs(owner: string, repo: string, prefix?: string): GitRef[] {
    return this.getStorage(owner, repo)?.listRefs(prefix) ?? [];
  }

  createBranch(owner: string, repo: string, branchName: string, commitSha: string): Branch {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);
    const refName = `refs/heads/${branchName}`;
    storage.setRef(refName, commitSha);
    return { name: branchName, commitSha };
  }

  getBranch(owner: string, repo: string, branchName: string): Branch | undefined {
    const storage = this.getStorage(owner, repo);
    if (!storage) return undefined;
    const sha = storage.resolveRef(`refs/heads/${branchName}`);
    return sha ? { name: branchName, commitSha: sha } : undefined;
  }

  deleteBranch(owner: string, repo: string, branchName: string): boolean {
    const storage = this.getStorage(owner, repo);
    if (!storage) return false;
    return storage.deleteRef(`refs/heads/${branchName}`);
  }

  listBranches(owner: string, repo: string): Branch[] {
    const storage = this.getStorage(owner, repo);
    if (!storage) return [];
    const branches: Branch[] = [];
    for (const ref of storage.listRefs('refs/heads/')) {
      const name = ref.name.slice('refs/heads/'.length);
      const sha = storage.resolveRef(ref.name);
      if (sha) branches.push({ name, commitSha: sha });
    }
    return branches;
  }

  // ---------------------------------------------------------------- commits
  createCommit(
    owner: string,
    repo: string,
    params: {
      treeSha: string;
      parents?: string[];
      message: string;
      author?: { name: string; email: string };
      committer?: { name: string; email: string };
      timestamp?: number;
    },
  ): { sha: string; view: CommitView } {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);

    const authorLine = params.author ? `${params.author.name} <${params.author.email}>` : undefined;
    const committerLine = params.committer ? `${params.committer.name} <${params.committer.email}>` : authorLine;
    const buf = buildCommit({
      tree: params.treeSha,
      parents: params.parents ?? [],
      message: params.message,
      author: authorLine,
      committer: committerLine,
      timestamp: params.timestamp,
    });
    const { oid } = storage.saveObject('commit', buf);
    const view = parseCommit(buf);
    return { sha: oid, view };
  }

  getCommit(owner: string, repo: string, sha: string): CommitView | undefined {
    const obj = this.getObject(owner, repo, sha);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  listCommits(owner: string, repo: string, options: { sha?: string; branch?: string; path?: string } = {}): { sha: string; commit: CommitView }[] {
    const storage = this.getStorage(owner, repo);
    if (!storage) return [];

    let startSha: string | undefined;
    if (options.sha) {
      startSha = storage.resolveRef(options.sha) ?? storage.resolveRef(`refs/heads/${options.sha}`) ?? storage.resolveRef(`refs/tags/${options.sha}`) ?? options.sha;
    } else if (options.branch) {
      startSha = storage.resolveRef(`refs/heads/${options.branch}`);
    } else {
      startSha = storage.resolveRef(`refs/heads/${storage.repo.defaultBranch}`);
    }

    if (!startSha) return [];

    const result: { sha: string; commit: CommitView }[] = [];
    const queue = [startSha];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const commitObj = storage.getObject(current);
      if (!commitObj || commitObj.type !== 'commit') continue;
      const view = parseCommit(commitObj.data);
      result.push({ sha: current, commit: view });

      for (const parent of view.parents) {
        if (!visited.has(parent)) queue.push(parent);
      }
    }

    return result;
  }

  // ---------------------------------------------------------------- contents
  putContent(
    owner: string,
    repo: string,
    filePath: string,
    content: Buffer | string,
    message: string,
    options: { branch?: string; expectedSha?: string; author?: { name: string; email: string } } = {},
  ): { content: ContentFile; commitSha: string } {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);

    const branch = options.branch || storage.repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const currentTip = storage.resolveRef(refName);

    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const { oid: blobSha } = storage.saveObject('blob', buf);

    const files = currentTip ? storage.getFilesAtCommit(currentTip) : new Map<string, { oid: string; mode: string }>();

    const normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
    const existing = files.get(normalizedPath);

    if (options.expectedSha) {
      if (!existing || existing.oid.toLowerCase() !== options.expectedSha.toLowerCase()) {
        throw new ConflictError(`Expected sha ${options.expectedSha} does not match current sha ${existing?.oid ?? 'none'}`);
      }
    }

    files.set(normalizedPath, { oid: blobSha, mode: '100644' });

    const rootTreeSha = storage.buildTreesFromFiles(files);
    const { sha: commitSha } = this.createCommit(owner, repo, {
      treeSha: rootTreeSha,
      parents: currentTip ? [currentTip] : [],
      message,
      author: options.author,
    });

    storage.setRef(refName, commitSha);
    // If unborn repo, update HEAD symref to point to default branch
    if (!storage.resolveRef('HEAD')) {
      storage.setRef('HEAD', refName, true);
    }

    const name = normalizedPath.split('/').pop() ?? normalizedPath;
    const contentFile: ContentFile = {
      type: 'file',
      name,
      path: normalizedPath,
      sha: blobSha,
      size: buf.length,
      encoding: 'base64',
      content: buf.toString('base64'),
    };

    return { content: contentFile, commitSha };
  }

  getContent(owner: string, repo: string, path: string, ref?: string): ContentFile | ContentDirEntry[] | undefined {
    const storage = this.getStorage(owner, repo);
    if (!storage) return undefined;

    const commitSha = ref ? storage.resolveRef(ref) ?? storage.resolveRef(`refs/heads/${ref}`) : storage.resolveRef(`refs/heads/${storage.repo.defaultBranch}`);
    if (!commitSha) return undefined;

    const files = storage.getFilesAtCommit(commitSha);
    const normalizedPath = path.replace(/^\/+|\/+$/g, '');

    // 1. Exact file match
    if (files.has(normalizedPath)) {
      const file = files.get(normalizedPath)!;
      const blobObj = storage.getObject(file.oid);
      if (!blobObj) return undefined;
      const name = normalizedPath.split('/').pop() ?? normalizedPath;
      return {
        type: 'file',
        name,
        path: normalizedPath,
        sha: file.oid,
        size: blobObj.data.length,
        encoding: 'base64',
        content: blobObj.data.toString('base64'),
      };
    }

    // 2. Directory match
    const dirPrefix = normalizedPath ? `${normalizedPath}/` : '';
    const entries: ContentDirEntry[] = [];
    const seenDirs = new Set<string>();

    for (const [filePath, file] of files.entries()) {
      if (normalizedPath === '' || filePath.startsWith(dirPrefix)) {
        const rest = normalizedPath === '' ? filePath : filePath.slice(dirPrefix.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx >= 0) {
          const subDirName = rest.slice(0, slashIdx);
          if (!seenDirs.has(subDirName)) {
            seenDirs.add(subDirName);
            const subDirPath = normalizedPath ? `${normalizedPath}/${subDirName}` : subDirName;
            entries.push({
              type: 'dir',
              name: subDirName,
              path: subDirPath,
              sha: file.oid,
              size: 0,
            });
          }
        } else {
          entries.push({
            type: 'file',
            name: rest,
            path: filePath,
            sha: file.oid,
            size: storage.getObject(file.oid)?.data.length ?? 0,
          });
        }
      }
    }

    if (entries.length > 0 || normalizedPath === '') {
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return entries;
    }

    return undefined;
  }

  deleteContent(
    owner: string,
    repo: string,
    filePath: string,
    message: string,
    options: { branch?: string; expectedSha?: string; author?: { name: string; email: string } } = {},
  ): { commitSha: string } {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);

    const branch = options.branch || storage.repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const currentTip = storage.resolveRef(refName);
    if (!currentTip) throw new NotFoundError('Branch not found');

    const files = storage.getFilesAtCommit(currentTip);
    const normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
    const existing = files.get(normalizedPath);
    if (!existing) throw new NotFoundError(`File ${filePath} not found`);

    if (options.expectedSha && existing.oid.toLowerCase() !== options.expectedSha.toLowerCase()) {
      throw new ConflictError(`Sha mismatch: expected ${options.expectedSha}, got ${existing.oid}`);
    }

    files.delete(normalizedPath);
    const rootTreeSha = storage.buildTreesFromFiles(files);
    const { sha: commitSha } = this.createCommit(owner, repo, {
      treeSha: rootTreeSha,
      parents: [currentTip],
      message,
      author: options.author,
    });

    storage.setRef(refName, commitSha);
    return { commitSha };
  }

  // ---------------------------------------------------------------- labels
  createLabel(owner: string, repo: string, name: string, color = 'ededed', description = ''): Label {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);
    const id = storage.labelCounter++;
    const label: Label = { id, name, color, description };
    storage.labels.set(name.toLowerCase(), label);
    return label;
  }

  getLabel(owner: string, repo: string, name: string): Label | undefined {
    return this.getStorage(owner, repo)?.labels.get(name.toLowerCase());
  }

  listLabels(owner: string, repo: string): Label[] {
    const storage = this.getStorage(owner, repo);
    return storage ? [...storage.labels.values()] : [];
  }

  // ---------------------------------------------------------------- issues
  createIssue(
    owner: string,
    repo: string,
    params: { title: string; body?: string; labels?: string[]; user?: User },
  ): Issue {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);

    const number = storage.issueCounter++;
    const id = 10000 + number;
    const globalId = this.toGlobalId('Issue', id);
    const resolvedLabels: Label[] = [];

    if (params.labels && params.labels.length > 0) {
      for (const lblName of params.labels) {
        const found = storage.labels.get(lblName.toLowerCase());
        if (!found) {
          throw new ValidationError(`Unknown label ${lblName}`);
        }
        resolvedLabels.push(found);
      }
    }

    const now = new Date().toISOString();
    const user = params.user ?? this.getViewer();

    const issue: Issue = {
      id,
      databaseId: id,
      globalId,
      number,
      title: params.title,
      body: params.body ?? '',
      state: 'open',
      labels: resolvedLabels,
      user,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };

    storage.issues.set(number, issue);
    this.globalIdIndex.set(globalId, { type: 'Issue', id, repoKey: this.repoKey(owner, repo) });
    return issue;
  }

  getIssue(owner: string, repo: string, number: number): Issue | undefined {
    return this.getStorage(owner, repo)?.issues.get(number);
  }

  updateIssue(
    owner: string,
    repo: string,
    number: number,
    patch: { state?: 'open' | 'closed'; title?: string; body?: string; labels?: string[] },
  ): Issue | undefined {
    const storage = this.getStorage(owner, repo);
    if (!storage) return undefined;
    const current = storage.issues.get(number);
    if (!current) return undefined;

    let labels = current.labels;
    if (patch.labels !== undefined) {
      labels = [];
      for (const lblName of patch.labels) {
        const found = storage.labels.get(lblName.toLowerCase());
        if (!found) throw new ValidationError(`Unknown label ${lblName}`);
        labels.push(found);
      }
    }

    const now = new Date().toISOString();
    const updatedState = patch.state ?? current.state;
    const closedAt = updatedState === 'closed' ? (current.closedAt ?? now) : null;

    const updated: Issue = {
      ...current,
      title: patch.title !== undefined ? patch.title : current.title,
      body: patch.body !== undefined ? patch.body : current.body,
      state: updatedState,
      labels,
      updatedAt: now,
      closedAt,
    };

    storage.issues.set(number, updated);
    return updated;
  }

  listIssues(
    owner: string,
    repo: string,
    options: {
      state?: 'open' | 'closed' | 'all';
      sort?: 'created' | 'updated' | 'comments';
      direction?: 'asc' | 'desc';
      perPage?: number;
      page?: number;
    } = {},
  ): Issue[] {
    const storage = this.getStorage(owner, repo);
    if (!storage) return [];

    let list = [...storage.issues.values()];
    const stateFilter = options.state ?? 'open';
    if (stateFilter !== 'all') {
      list = list.filter((i) => i.state === stateFilter);
    }

    const sortField = options.sort ?? 'created';
    const direction = options.direction ?? 'desc';
    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'created') {
        cmp = a.number - b.number;
      } else if (sortField === 'updated') {
        cmp = a.updatedAt.localeCompare(b.updatedAt);
      } else if (sortField === 'comments') {
        cmp = a.comments.length - b.comments.length;
      }
      return direction === 'asc' ? cmp : -cmp;
    });

    if (options.page !== undefined || options.perPage !== undefined) {
      const perPage = Math.max(1, options.perPage ?? 30);
      const page = Math.max(1, options.page ?? 1);
      const start = (page - 1) * perPage;
      list = list.slice(start, start + perPage);
    }

    return list;
  }

  // ---------------------------------------------------------------- comments
  createIssueComment(owner: string, repo: string, issueNumber: number, body: string, user?: User): IssueComment {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);
    const issue = storage.issues.get(issueNumber);
    if (!issue) throw new NotFoundError(`Issue #${issueNumber} not found`);

    const id = storage.commentCounter++;
    const globalId = this.toGlobalId('Comment', id);
    const now = new Date().toISOString();
    const commentUser = user ?? this.getViewer();

    const comment: IssueComment = {
      id,
      globalId,
      body,
      user: commentUser,
      createdAt: now,
      updatedAt: now,
    };

    issue.comments.push(comment);
    return comment;
  }

  listIssueComments(owner: string, repo: string, issueNumber: number): IssueComment[] {
    const storage = this.getStorage(owner, repo);
    if (!storage) return [];
    const issue = storage.issues.get(issueNumber);
    return issue ? [...issue.comments] : [];
  }

  // ---------------------------------------------------------------- pull requests
  createPullRequest(
    owner: string,
    repo: string,
    params: {
      title: string;
      body?: string;
      head: string;
      base: string;
      user?: User;
    },
  ): PullRequest {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);

    const headSha = storage.resolveRef(`refs/heads/${params.head}`) ?? storage.resolveRef(params.head);
    if (!headSha) throw new ValidationError(`Head ref ${params.head} not found`);

    const baseSha = storage.resolveRef(`refs/heads/${params.base}`) ?? storage.resolveRef(params.base);
    if (!baseSha) throw new ValidationError(`Base ref ${params.base} not found`);

    const number = storage.pullCounter++;
    const id = 20000 + number;
    const globalId = this.toGlobalId('PullRequest', id);
    const now = new Date().toISOString();
    const user = params.user ?? this.getViewer();

    // Compute changed files between head and base
    const headFiles = storage.getFilesAtCommit(headSha);
    const baseFiles = storage.getFilesAtCommit(baseSha);
    const files: PullFile[] = [];

    for (const [path, hFile] of headFiles.entries()) {
      const bFile = baseFiles.get(path);
      if (!bFile) {
        files.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1, sha: hFile.oid });
      } else if (bFile.oid !== hFile.oid) {
        files.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2, sha: hFile.oid });
      }
    }
    for (const [path, bFile] of baseFiles.entries()) {
      if (!headFiles.has(path)) {
        files.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1, sha: bFile.oid });
      }
    }

    const pr: PullRequest = {
      id,
      databaseId: id,
      globalId,
      number,
      title: params.title,
      body: params.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergeable: 'MERGEABLE',
      head: { ref: params.head, sha: headSha },
      base: { ref: params.base, sha: baseSha },
      user,
      files,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };

    storage.pulls.set(number, pr);
    this.globalIdIndex.set(globalId, { type: 'PullRequest', id, repoKey: this.repoKey(owner, repo) });
    return pr;
  }

  getPullRequest(owner: string, repo: string, number: number): PullRequest | undefined {
    return this.getStorage(owner, repo)?.pulls.get(number);
  }

  listPullRequests(
    owner: string,
    repo: string,
    options: {
      state?: 'open' | 'closed' | 'all';
      perPage?: number;
      page?: number;
    } = {},
  ): PullRequest[] {
    const storage = this.getStorage(owner, repo);
    if (!storage) return [];

    let list = [...storage.pulls.values()];
    const stateFilter = options.state ?? 'open';
    if (stateFilter !== 'all') {
      list = list.filter((p) => p.state === stateFilter);
    }
    list.sort((a, b) => b.number - a.number);

    if (options.page !== undefined || options.perPage !== undefined) {
      const perPage = Math.max(1, options.perPage ?? 30);
      const page = Math.max(1, options.page ?? 1);
      const start = (page - 1) * perPage;
      list = list.slice(start, start + perPage);
    }

    return list;
  }

  listPullRequestFiles(owner: string, repo: string, number: number): PullFile[] {
    const pr = this.getPullRequest(owner, repo, number);
    return pr ? [...pr.files] : [];
  }

  mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    options: { mergeMethod?: 'merge' | 'squash' | 'rebase'; commitMessage?: string } = {},
  ): { merged: boolean; sha: string; message: string } {
    const storage = this.getStorage(owner, repo);
    if (!storage) throw new NotFoundError(`Repository ${owner}/${repo} not found`);

    const pr = storage.pulls.get(number);
    if (!pr) throw new NotFoundError(`Pull request #${number} not found`);

    if (pr.merged || pr.state === 'closed') {
      throw new ConflictError('Pull request is already closed or merged', 405);
    }

    const currentBaseSha = storage.resolveRef(`refs/heads/${pr.base.ref}`) ?? storage.resolveRef(pr.base.ref);
    if (!currentBaseSha) throw new NotFoundError(`Base branch ${pr.base.ref} not found`);

    const headSha = storage.resolveRef(`refs/heads/${pr.head.ref}`) ?? storage.resolveRef(pr.head.ref) ?? pr.head.sha;

    // Detect merge conflicts: check if base has progressed and modified the same files as head
    const currentBaseFiles = storage.getFilesAtCommit(currentBaseSha);
    const headFiles = storage.getFilesAtCommit(headSha);

    if (currentBaseSha !== pr.base.sha) {
      const originalBaseFiles = storage.getFilesAtCommit(pr.base.sha);
      for (const file of pr.files) {
        const currFile = currentBaseFiles.get(file.filename);
        const origFile = originalBaseFiles.get(file.filename);
        const headFile = headFiles.get(file.filename);
        // Base was updated differently from head
        if (currFile?.oid !== origFile?.oid && currFile?.oid !== headFile?.oid) {
          throw new ConflictError('Pull Request is not mergeable', 405);
        }
      }
    }

    // Apply head changes to base files
    for (const file of pr.files) {
      if (file.status === 'removed') {
        currentBaseFiles.delete(file.filename);
      } else {
        const headFile = headFiles.get(file.filename);
        if (headFile) currentBaseFiles.set(file.filename, headFile);
      }
    }

    const newRootTree = storage.buildTreesFromFiles(currentBaseFiles);
    const commitMsg = options.commitMessage ?? `${pr.title} (#${pr.number})`;
    const { sha: mergeSha } = this.createCommit(owner, repo, {
      treeSha: newRootTree,
      parents: [currentBaseSha],
      message: commitMsg,
    });

    // Advance base branch ref
    storage.setRef(`refs/heads/${pr.base.ref}`, mergeSha);

    const now = new Date().toISOString();
    const updatedPr: PullRequest = {
      ...pr,
      state: 'closed',
      merged: true,
      mergedAt: now,
      mergeCommitSha: mergeSha,
      closedAt: now,
      updatedAt: now,
    };
    storage.pulls.set(number, updatedPr);

    return {
      merged: true,
      sha: mergeSha,
      message: 'Pull Request successfully merged',
    };
  }
}

// Export singleton instance
export const store = new Store();
