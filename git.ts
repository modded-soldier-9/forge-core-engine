import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type GitObject } from './store.ts';
import {
  ZERO_OID,
  encodePktLine,
  pktLineFlush,
  pktLineDelim,
  decodePktLines,
  PktLineDecoder,
  collectReachable,
  readPack,
  writePack,
  parseCommit,
  parseTag,
  encodeSideband,
  type GitObjectInput,
  type GitPacket,
} from './git-core.ts';

const GIT_ROUTE_RE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function getStorage(owner: string, name: string): any {
  return (store as any).repos?.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendGitResponse(res: ServerResponse, status: number, contentType: string, data: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    'cache-control': 'no-cache, no-store, must-revalidate',
    'pragma': 'no-cache',
    'expires': '0',
  });
  res.end(data);
}

function send404(res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8');
  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

function peelTag(oid: string, storage: any): string | undefined {
  let cur = oid;
  let peeled: string | undefined;
  while (true) {
    const obj = storage.getObject(cur);
    if (!obj || obj.type !== 'tag') break;
    const parsed = parseTag(obj.data);
    peeled = parsed.object;
    cur = parsed.object;
  }
  return peeled;
}

function isAncestor(ancestorOid: string, commitOid: string, storage: any): boolean {
  if (ancestorOid.toLowerCase() === commitOid.toLowerCase()) return true;
  const target = ancestorOid.toLowerCase();
  const seen = new Set<string>();
  const queue = [commitOid.toLowerCase()];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = storage.getObject(cur);
    if (obj && obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      for (const parent of parsed.parents) {
        if (!seen.has(parent.toLowerCase())) queue.push(parent.toLowerCase());
      }
    }
  }
  return false;
}

export async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = GIT_ROUTE_RE.exec(url.pathname);
  if (!match) return false;

  const owner = match[1];
  const repoName = match[2];
  const action = match[3];

  const storage = getStorage(owner, repoName);
  if (!storage) {
    send404(res);
    return true;
  }

  const method = req.method ?? 'GET';

  if (action === 'info/refs') {
    if (method !== 'GET') {
      res.writeHead(405).end();
      return true;
    }
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      handleInfoRefsUploadPack(req, res, storage);
      return true;
    }
    if (service === 'git-receive-pack') {
      handleInfoRefsReceivePack(req, res, storage);
      return true;
    }
    res.writeHead(400).end('Unknown service');
    return true;
  }

  if (action === 'git-upload-pack') {
    if (method !== 'POST') {
      res.writeHead(405).end();
      return true;
    }
    await handleUploadPack(req, res, storage);
    return true;
  }

  if (action === 'git-receive-pack') {
    if (method !== 'POST') {
      res.writeHead(405).end();
      return true;
    }
    await handleReceivePack(req, res, storage);
    return true;
  }

  return false;
}

export const handleGitRequest = handleGit;

function handleInfoRefsUploadPack(req: IncomingMessage, res: ServerResponse, storage: any): void {
  const gitProtocol = (req.headers['git-protocol'] as string) ?? '';
  const isV2 = gitProtocol.includes('version=2');

  if (isV2) {
    const packets = [
      encodePktLine('version 2\n'),
      encodePktLine('ls-refs=unborn\n'),
      encodePktLine('fetch=shallow\n'),
      encodePktLine('server-option\n'),
      encodePktLine('object-format=sha1\n'),
      encodePktLine('agent=forge-bot/1.0\n'),
      pktLineFlush(),
    ];
    sendGitResponse(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(packets));
    return;
  }

  // v0 upload-pack advertisement
  const defaultBranch = storage.repo.defaultBranch ?? 'main';
  const headSha = storage.resolveRef('HEAD');

  const packets: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
  ];

  const caps = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow agent=forge-bot/1.0 symref=HEAD:refs/heads/${defaultBranch}`;

  if (!headSha) {
    packets.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    packets.push(pktLineFlush());
  } else {
    packets.push(encodePktLine(`${headSha} HEAD\0${caps}\n`));
    for (const [refName, refObj] of storage.refs.entries()) {
      if (refName === 'HEAD' || refObj.isSymbolic) continue;
      packets.push(encodePktLine(`${refObj.target} ${refName}\n`));
      if (refName.startsWith('refs/tags/')) {
        const peeled = peelTag(refObj.target, storage);
        if (peeled) packets.push(encodePktLine(`${peeled} ${refName}^{}\n`));
      }
    }
    packets.push(pktLineFlush());
  }

  sendGitResponse(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(packets));
}

function handleInfoRefsReceivePack(_req: IncomingMessage, res: ServerResponse, storage: any): void {
  const packets: Buffer[] = [
    encodePktLine('# service=git-receive-pack\n'),
    pktLineFlush(),
  ];

  const caps = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=forge-bot/1.0';

  const realRefs: Array<{ name: string; oid: string }> = [];
  for (const [refName, refObj] of storage.refs.entries()) {
    if (refName === 'HEAD' || refObj.isSymbolic) continue;
    realRefs.push({ name: refName, oid: refObj.target });
  }

  if (realRefs.length === 0) {
    packets.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    packets.push(pktLineFlush());
  } else {
    let first = true;
    for (const ref of realRefs) {
      if (first) {
        packets.push(encodePktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
        first = false;
      } else {
        packets.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      }
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelTag(ref.oid, storage);
        if (peeled) packets.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
    packets.push(pktLineFlush());
  }

  sendGitResponse(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(packets));
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, storage: any): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400).end();
    return;
  }

  let packets: GitPacket[];
  try {
    packets = decodePktLines(body);
  } catch {
    res.writeHead(400).end('Malformed pkt-line request');
    return;
  }

  const firstData = packets.find((p) => p.kind === 'data');
  const firstText = firstData && firstData.kind === 'data' ? firstData.payload.toString('utf8') : '';

  if (firstText.startsWith('command=')) {
    handleUploadPackV2(packets, res, storage);
    return;
  }

  handleUploadPackV0(packets, res, storage);
}

function handleUploadPackV2(packets: GitPacket[], res: ServerResponse, storage: any): void {
  const commandLine = packets.find((p) => p.kind === 'data')?.kind === 'data'
    ? (packets.find((p) => p.kind === 'data') as any).payload.toString('utf8').trim()
    : '';

  if (commandLine === 'command=ls-refs') {
    handleLsRefsV2(packets, res, storage);
    return;
  }

  if (commandLine === 'command=fetch') {
    handleFetchV2(packets, res, storage);
    return;
  }

  res.writeHead(400).end(`Unsupported v2 command: ${commandLine}`);
}

function handleLsRefsV2(packets: GitPacket[], res: ServerResponse, storage: any): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];

  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) {
      prefixes.push(line.slice('ref-prefix '.length));
    }
  }

  const matchesPrefix = (name: string): boolean => {
    if (prefixes.length === 0) return true;
    return prefixes.some((p) => name.startsWith(p));
  };

  const defaultBranch = storage.repo.defaultBranch ?? 'main';
  const headSha = storage.resolveRef('HEAD');
  const outPackets: Buffer[] = [];

  if (!headSha) {
    if (unborn && matchesPrefix('HEAD')) {
      outPackets.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${defaultBranch}\n`));
    }
  } else {
    if (matchesPrefix('HEAD')) {
      const symrefSuffix = symrefs ? ` symref-target:refs/heads/${defaultBranch}` : '';
      outPackets.push(encodePktLine(`${headSha} HEAD${symrefSuffix}\n`));
    }

    const refEntries = [...storage.refs.entries()]
      .filter(([name, ref]: [string, any]) => name !== 'HEAD' && !ref.isSymbolic && matchesPrefix(name))
      .sort(([a]: [string, any], [b]: [string, any]) => a.localeCompare(b));

    for (const [refName, refObj] of refEntries) {
      let line = `${refObj.target} ${refName}`;
      if (peel && refName.startsWith('refs/tags/')) {
        const peeled = peelTag(refObj.target, storage);
        if (peeled) line += ` peeled:${peeled}`;
      }
      outPackets.push(encodePktLine(`${line}\n`));
    }
  }

  outPackets.push(pktLineFlush());
  sendGitResponse(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(outPackets));
}

function handleFetchV2(packets: GitPacket[], res: ServerResponse, storage: any): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;

  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }

  const lookup = (id: string) => storage.getObject(id);
  const outPackets: Buffer[] = [];

  outPackets.push(encodePktLine('acknowledgments\n'));
  if (haves.length === 0) {
    outPackets.push(encodePktLine('NAK\n'));
  } else {
    let acked = false;
    for (const have of haves) {
      if (storage.hasObject(have)) {
        outPackets.push(encodePktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) outPackets.push(encodePktLine('NAK\n'));
  }
  outPackets.push(encodePktLine('ready\n'));
  outPackets.push(pktLineDelim());

  let shallowList: string[] = [];
  let unshallowList: string[] = [];
  let objectsToSend: GitObjectInput[] = [];

  if (depth !== undefined && depth > 0) {
    const shallowResult = computeShallowFetch(wants, haves, shallowBoundaries, depth, storage);
    shallowList = shallowResult.shallow;
    unshallowList = shallowResult.unshallow;
    objectsToSend = shallowResult.objects;

    if (shallowList.length > 0 || unshallowList.length > 0) {
      outPackets.push(encodePktLine('shallow-info\n'));
      for (const s of shallowList) outPackets.push(encodePktLine(`shallow ${s}\n`));
      for (const u of unshallowList) outPackets.push(encodePktLine(`unshallow ${u}\n`));
      outPackets.push(pktLineDelim());
    }
  } else {
    const haveSet = haves.length ? collectReachable(haves, lookup, { allowMissing: true }) : new Set<string>();
    const wantedSet = collectReachable(wants, lookup, { allowMissing: true });
    for (const oid of wantedSet) {
      if (!haveSet.has(oid)) {
        const obj = lookup(oid);
        if (obj) objectsToSend.push(obj);
      }
    }
  }

  const packBytes = writePack(objectsToSend);
  outPackets.push(encodePktLine('packfile\n'));
  const sidebandPackets = encodeSideband(1, packBytes);
  for (const sp of sidebandPackets) outPackets.push(sp);
  outPackets.push(pktLineFlush());

  sendGitResponse(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(outPackets));
}

function handleUploadPackV0(packets: GitPacket[], res: ServerResponse, storage: any): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;

  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const parts = line.slice(5).trim().split(' ');
      wants.push(parts[0]);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      shallowBoundaries.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      depth = Number.parseInt(line.slice(7).trim(), 10);
    }
  }

  const lookup = (id: string) => storage.getObject(id);
  const outPackets: Buffer[] = [];

  outPackets.push(encodePktLine('NAK\n'));

  let objectsToSend: GitObjectInput[] = [];

  if (depth !== undefined && depth > 0) {
    const shallowResult = computeShallowFetch(wants, haves, shallowBoundaries, depth, storage);
    for (const s of shallowResult.shallow) outPackets.push(encodePktLine(`shallow ${s}\n`));
    for (const u of shallowResult.unshallow) outPackets.push(encodePktLine(`unshallow ${u}\n`));
    objectsToSend = shallowResult.objects;
  } else {
    const haveSet = haves.length ? collectReachable(haves, lookup, { allowMissing: true }) : new Set<string>();
    const wantedSet = collectReachable(wants, lookup, { allowMissing: true });
    for (const oid of wantedSet) {
      if (!haveSet.has(oid)) {
        const obj = lookup(oid);
        if (obj) objectsToSend.push(obj);
      }
    }
  }

  const packBytes = writePack(objectsToSend);
  const sidebandPackets = encodeSideband(1, packBytes);
  for (const sp of sidebandPackets) outPackets.push(sp);
  outPackets.push(pktLineFlush());

  sendGitResponse(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(outPackets));
}

function computeShallowFetch(
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number,
  storage: any,
): { shallow: string[]; unshallow: string[]; objects: GitObjectInput[] } {
  const lookup = (id: string) => storage.getObject(id);
  const includedCommits = new Set<string>();
  const shallowSet = new Set<string>();
  const clientShallowSet = new Set(clientShallow.map((s) => s.toLowerCase()));
  const unshallowSet = new Set<string>();

  interface QueueItem {
    oid: string;
    level: number;
  }

  const queue: QueueItem[] = wants.map((oid) => ({ oid: oid.toLowerCase(), level: 1 }));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);

    const obj = lookup(oid);
    if (!obj) continue;

    if (obj.type === 'commit') {
      includedCommits.add(oid);
      const parsed = parseCommit(obj.data);
      if (level < depth) {
        if (clientShallowSet.has(oid)) {
          unshallowSet.add(oid);
        }
        for (const parent of parsed.parents) {
          queue.push({ oid: parent.toLowerCase(), level: level + 1 });
        }
      } else {
        if (parsed.parents.length > 0) {
          shallowSet.add(oid);
        }
      }
    }
  }

  // When computing what the client already has, do not traverse beyond client's shallow boundaries!
  const haveSet = new Set<string>();
  if (haves.length > 0) {
    const haveQueue: string[] = haves.map((h) => h.toLowerCase());
    const haveVisited = new Set<string>();
    while (haveQueue.length > 0) {
      const hOid = haveQueue.pop()!;
      if (haveVisited.has(hOid)) continue;
      haveVisited.add(hOid);
      haveSet.add(hOid);

      const hObj = lookup(hOid);
      if (!hObj) continue;

      if (hObj.type === 'commit') {
        const parsed = parseCommit(hObj.data);
        // Add trees and blobs of this commit
        const treeReachable = collectReachable([parsed.tree], lookup, { allowMissing: true });
        for (const tid of treeReachable) haveSet.add(tid);

        // Only traverse parents if this commit is NOT a client shallow boundary!
        if (!clientShallowSet.has(hOid)) {
          for (const p of parsed.parents) {
            haveQueue.push(p.toLowerCase());
          }
        }
      } else if (hObj.type === 'tag') {
        haveQueue.push(parseTag(hObj.data).object.toLowerCase());
      } else if (hObj.type === 'tree') {
        const treeReachable = collectReachable([hOid], lookup, { allowMissing: true });
        for (const tid of treeReachable) haveSet.add(tid);
      }
    }
  }

  const objectsToSend: GitObjectInput[] = [];
  const objectOids = new Set<string>();

  for (const commitOid of includedCommits) {
    if (!haveSet.has(commitOid) && !objectOids.has(commitOid)) {
      const obj = lookup(commitOid);
      if (obj) {
        objectsToSend.push(obj);
        objectOids.add(commitOid);
      }
    }
    const commitObj = lookup(commitOid);
    if (commitObj && commitObj.type === 'commit') {
      const parsed = parseCommit(commitObj.data);
      const treeReachable = collectReachable([parsed.tree], lookup, { allowMissing: true });
      for (const oid of treeReachable) {
        if (!haveSet.has(oid) && !objectOids.has(oid)) {
          const o = lookup(oid);
          if (o) {
            objectsToSend.push(o);
            objectOids.add(oid);
          }
        }
      }
    }
  }

  return {
    shallow: Array.from(shallowSet),
    unshallow: Array.from(unshallowSet),
    objects: objectsToSend,
  };
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, storage: any): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400).end();
    return;
  }

  const decoder = new PktLineDecoder();
  decoder.push(body);
  const commandLines: string[] = [];

  for (let packet = decoder.next(); packet !== null; packet = decoder.next()) {
    if (packet.kind === 'flush') {
      break;
    }
    if (packet.kind === 'data') {
      commandLines.push(packet.payload.toString('utf8'));
    }
  }

  const packBytes = decoder.takeBuffered();

  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }

  const commands: Command[] = [];
  let sideband = false;

  commandLines.forEach((rawLine, index) => {
    let line = rawLine.replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        if (caps.includes('side-band-64k')) sideband = true;
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  });

  let unpackOk = true;
  let unpackDetail = 'ok';

  if (packBytes.length >= 32) {
    try {
      const packResult = readPack(packBytes, {
        resolveBase: (oid) => storage.getObject(oid),
      });
      for (const [oid, obj] of packResult.objects) {
        storage.objects.set(oid.toLowerCase(), obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const refReports: Array<{ ref: string; ok: boolean; reason: string }> = [];

  if (unpackOk) {
    for (const cmd of commands) {
      if (cmd.newOid === ZERO_OID) {
        storage.deleteRef(cmd.ref);
        refReports.push({ ref: cmd.ref, ok: true, reason: '' });
      } else if (cmd.oldOid === ZERO_OID) {
        storage.setRef(cmd.ref, cmd.newOid, false);
        if (cmd.ref === 'refs/heads/main' || !storage.repo.defaultBranch) {
          storage.repo.defaultBranch = cmd.ref.replace('refs/heads/', '');
        }
        refReports.push({ ref: cmd.ref, ok: true, reason: '' });
      } else {
        const curOid = storage.resolveRef(cmd.ref);
        if (curOid && curOid.toLowerCase() !== cmd.oldOid.toLowerCase()) {
          refReports.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
        } else if (!isAncestor(cmd.oldOid, cmd.newOid, storage)) {
          refReports.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          storage.setRef(cmd.ref, cmd.newOid, false);
          refReports.push({ ref: cmd.ref, ok: true, reason: '' });
        }
      }
    }
  } else {
    for (const cmd of commands) {
      refReports.push({ ref: cmd.ref, ok: false, reason: 'unpacker error' });
    }
  }

  const reportPackets: Buffer[] = [
    encodePktLine(`unpack ${unpackDetail}\n`),
  ];
  for (const report of refReports) {
    if (report.ok) {
      reportPackets.push(encodePktLine(`ok ${report.ref}\n`));
    } else {
      reportPackets.push(encodePktLine(`ng ${report.ref} ${report.reason}\n`));
    }
  }
  reportPackets.push(pktLineFlush());
  const reportData = Buffer.concat(reportPackets);

  let responseBody: Buffer;
  if (sideband) {
    const sidebandChunks = encodeSideband(1, reportData);
    responseBody = Buffer.concat([...sidebandChunks, pktLineFlush()]);
  } else {
    responseBody = reportData;
  }

  sendGitResponse(res, 200, 'application/x-git-receive-pack-result', responseBody);
}
