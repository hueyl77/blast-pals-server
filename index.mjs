import { Server, Room, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createServer } from 'node:http';
import { rm, readFile, writeFile } from 'node:fs/promises';

const U = String.fromCharCode(95);
const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const maxPals = 4;
const usedCodes = new Set();

function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return usedCodes.has(s) ? makeCode() : s;
}

class BlastRoom extends Room {
  maxClients = maxPals;
  hostId = null;
  slots = new Map();
  onCreate() {
    this.roomId = makeCode();
    usedCodes.add(this.roomId);
    this.onMessage('snap', (c, d) => {
      if (c.sessionId === this.hostId) {
        this.broadcast('snap', d, { except: c });
      }
    });
    this.onMessage('in', (c, d) => {
      this.toHost('in', Object.assign({ slot: this.slots.get(c.sessionId) }, d));
    });
    this.onMessage('bomb', (c) => {
      this.toHost('bomb', { slot: this.slots.get(c.sessionId) });
    });
  }
  toHost(type, data) {
    const h = this.clients.find((c) => c.sessionId === this.hostId);
    if (h) {
      h.send(type, data);
    }
  }

  onJoin(c) {
    const taken = new Set(this.slots.values());
    let slot = 0;
    while (taken.has(slot)) {
      slot++;
    }
    this.slots.set(c.sessionId, slot);
    if (!this.hostId) {
      this.hostId = c.sessionId;
    }
    c.send('welcome', { code: this.roomId, slot: slot, host: c.sessionId === this.hostId });
    if (c.sessionId !== this.hostId) {
      this.toHost('joined', { slot: slot });
    }
    if (this.clients.length >= maxPals) {
      this.lock();
    }
  }
  onLeave(c) {
    const slot = this.slots.get(c.sessionId);
    this.slots.delete(c.sessionId);
    if (c.sessionId === this.hostId) {
      this.broadcast('hostLeft', {});
      this.disconnect();
      return;
    }
    this.toHost('left', { slot: slot });
    this.unlock();
  }
  onDispose() {
    usedCodes.delete(this.roomId);
  }
}

const arenaOwners = new Map();

class ArenaRoom extends BlastRoom {
  playing = false;
  owner = '';
  onCreate(options) {
    super.onCreate();
    this.setMetadata({ playing: false });
    this.owner = String((options && options.owner) || '').replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (this.owner) {
      const old = arenaOwners.get(this.owner);
      if (old && old !== this) {
        old.broadcast('hostLeft', {});
        old.disconnect();
      }
      arenaOwners.set(this.owner, this);
    }
    this.onMessage('state', (c, d) => {
      if (c.sessionId !== this.hostId) {
        return;
      }
      this.playing = !!(d && d.playing);
      this.setMetadata({ playing: this.playing });
      if (this.playing || this.clients.length >= maxPals) {
        this.lock();
      } else {
        this.unlock();
      }
    });
  }
  onLeave(c) {
    super.onLeave(c);
    if (this.playing) {
      this.lock();
    }
  }
  onDispose() {
    super.onDispose();
    if (this.owner && arenaOwners.get(this.owner) === this) {
      arenaOwners.delete(this.owner);
    }
  }
}

const players = {};
readFile('stats.json', 'utf8').then((t) => Object.assign(players, JSON.parse(t))).catch(() => {});
let saveTimer = null;

function saveStats() {
  if (saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeFile('stats.json', JSON.stringify(players)).catch(() => {});
  }, 5000);
}

function readBody(req, limit) {
  const max = limit || 4000;
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > max) {
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : 0;
}

function addStats(text) {
  const o = JSON.parse(text);
  const id = String(o.id || '').replace(/[^a-z0-9]/g, '').slice(0, 20);
  if (id.length < 8) {
    return;
  }
  const p = players[id] || { firstSeen: Date.now() };
  p.firstSeen = Math.min(p.firstSeen, num(o.firstSeen) || Date.now());
  p.lastSeen = Date.now();
  p.sessions = Math.max(p.sessions || 0, num(o.sessions));
  p.playMinutes = Math.max(p.playMinutes || 0, num(o.playMinutes));
  p.completion = Math.min(100, Math.max(p.completion || 0, num(o.completion)));
  p.arenaGames = Math.max(p.arenaGames || 0, num(o.arenaGames));
  players[id] = p;
  saveStats();
}

function day(t) {
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

function statsPage() {
  const list = Object.entries(players).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  let mins = 0;
  let arena = 0;
  const rows = list.map(([id, p], i) => {
    mins += p.playMinutes || 0;
    arena += p.arenaGames || 0;
    return '<tr><td>' + (i + 1) + '</td><td>' + id.slice(0, 6) + '</td><td>' + day(p.firstSeen) + '</td><td>' + day(p.lastSeen) + '</td><td>' + (p.sessions || 0) + '</td><td>' + Math.round(p.playMinutes || 0) + '</td><td>' + (p.completion || 0) + '%</td><td>' + (p.arenaGames || 0) + '</td></tr>';
  }).join('');
  return '<!doctype html><meta charset="utf-8"><title>Blast Pals stats</title>' +
    '<style>body{font-family:sans-serif;background:#1b1030;color:#fff;padding:20px}table{border-collapse:collapse}td,th{border:1px solid #6a4a8a;padding:6px 10px}th{background:#3a1d6a}h1{color:#ffcf5a}</style>' +
    '<h1>Blast Pals players</h1><p>Players: <b>' + list.length + '</b> &nbsp; Total play time: <b>' + Math.round(mins) + ' minutes</b> &nbsp; Arena battles: <b>' + arena + '</b> (times are UTC)</p>' +
    '<table><tr><th>#</th><th>Player</th><th>First played</th><th>Last played</th><th>Sessions</th><th>Minutes played</th><th>Completed</th><th>Arena battles</th></tr>' + rows + '</table>';
}


const hubRooms = new Map();
const hubClients = new Map();
const hubOwners = new Map();

function hubId() {
  let s = '';
  for (let i = 0; i < 20; i++) {
    s += 'abcdefghijkmnpqrstuvwxyz23456789'.charAt(Math.floor(Math.random() * 32));
  }
  return s;
}

function hubCode() {
  let s = makeCode();
  while (hubRooms.has(s) || usedCodes.has(s)) {
    s = makeCode();
  }
  return s;
}

function hubPush(c, type, data) {
  const line = 'data: ' + JSON.stringify([type, data]) + '\n\n';
  if (c.res) {
    c.res.write(line);
  } else {
    c.queue.push(line);
    if (c.queue.length > 300) {
      c.queue.splice(0, c.queue.length - 300);
    }
  }
}

function hubToHost(room, type, data) {
  const host = hubClients.get(room.hostId);
  if (host) {
    hubPush(host, type, data);
  }
}

function hubAdd(room) {
  const taken = new Set([...room.members].map((id) => hubClients.get(id).slot));
  let slot = 0;
  while (taken.has(slot)) {
    slot++;
  }
  const c = { id: hubId(), room: room.code, slot: slot, res: null, queue: [], gone: null };
  hubClients.set(c.id, c);
  room.members.add(c.id);
  if (!room.hostId) {
    room.hostId = c.id;
  }
  hubPush(c, 'welcome', { code: room.code, slot: slot, host: c.id === room.hostId });
  if (c.id !== room.hostId) {
    hubToHost(room, 'joined', { slot: slot });
  }
  return c;
}

function hubClose(room) {
  for (const id of room.members) {
    const c = hubClients.get(id);
    if (c) {
      hubPush(c, 'bye', {});
      if (c.res) {
        c.res.end();
      }
      hubClients.delete(id);
    }
  }
  hubRooms.delete(room.code);
  if (room.owner && hubOwners.get(room.owner) === room) {
    hubOwners.delete(room.owner);
  }
}

function hubRemove(id) {
  const c = hubClients.get(id);
  if (!c) {
    return;
  }
  const room = hubRooms.get(c.room);
  hubClients.delete(id);
  if (c.res) {
    c.res.end();
  }
  if (!room) {
    return;
  }
  room.members.delete(id);
  if (id === room.hostId) {
    for (const other of room.members) {
      const o = hubClients.get(other);
      if (o) {
        hubPush(o, 'hostLeft', {});
      }
    }
    hubClose(room);
    return;
  }
  hubToHost(room, 'left', { slot: c.slot });
}

function hubCreate(o) {
  const kind = o.kind === 'arena' ? 'arena' : 'blast';
  const owner = String(o.owner || '').replace(/[^a-z0-9]/g, '').slice(0, 20);
  if (kind === 'arena' && owner && hubOwners.has(owner)) {
    const old = hubOwners.get(owner);
    for (const id of old.members) {
      const c = hubClients.get(id);
      if (c) {
        hubPush(c, 'hostLeft', {});
      }
    }
    hubClose(old);
  }
  const room = { code: hubCode(), kind: kind, owner: owner, hostId: '', members: new Set(), playing: false, created: Date.now() };
  hubRooms.set(room.code, room);
  if (kind === 'arena' && owner) {
    hubOwners.set(owner, room);
  }
  return hubAdd(room);
}

function hubJoin(o) {
  const room = hubRooms.get(String(o.code || '').toUpperCase());
  if (!room) {
    return { error: 'not found' };
  }
  if (room.members.size >= maxPals) {
    return { error: 'full' };
  }
  if (room.playing) {
    return { error: 'in battle' };
  }
  return hubAdd(room);
}

function hubSend(o) {
  const c = hubClients.get(String(o.id || ''));
  if (!c) {
    return false;
  }
  const room = hubRooms.get(c.room);
  if (!room) {
    return false;
  }
  if (o.type === 'snap') {
    if (c.id === room.hostId) {
      for (const id of room.members) {
        if (id !== c.id) {
          hubPush(hubClients.get(id), 'snap', o.data);
        }
      }
    }
  } else if (o.type === 'in') {
    hubToHost(room, 'in', Object.assign({ slot: c.slot }, o.data));
  } else if (o.type === 'bomb') {
    hubToHost(room, 'bomb', { slot: c.slot });
  } else if (o.type === 'state' && c.id === room.hostId) {
    room.playing = !!(o.data && o.data.playing);
  }
  return true;
}

function hubEvents(req, res, id) {
  const c = hubClients.get(id);
  const head = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*', Connection: 'keep-alive' };
  if (!c) {
    res.writeHead(200, head);
    res.end('data: ' + JSON.stringify(['bye', {}]) + '\n\n');
    return;
  }
  if (c.gone) {
    clearTimeout(c.gone);
    c.gone = null;
  }
  if (c.res) {
    c.res.end();
  }
  res.writeHead(200, head);
  res.write(': hello\n\n');
  c.res = res;
  for (const line of c.queue) {
    res.write(line);
  }
  c.queue = [];
  req.on('close', () => {
    if (c.res !== res) {
      return;
    }
    c.res = null;
    c.gone = setTimeout(() => hubRemove(c.id), 10000);
  });
}

setInterval(() => {
  for (const c of hubClients.values()) {
    if (c.res) {
      c.res.write(': ping\n\n');
    }
  }
}, 15000);

async function hubPost(req, res, what) {
  let o = {};
  try {
    o = JSON.parse((await readBody(req, 400000)) || '{}');
  } catch (e) {
    o = {};
  }
  let out = { ok: true };
  if (what === 'create') {
    const c = hubCreate(o);
    out = { id: c.id };
  } else if (what === 'join') {
    const r = hubJoin(o);
    out = r.error ? { error: r.error } : { id: r.id };
  } else if (what === 'send') {
    out = { ok: hubSend(o) };
  } else if (what === 'leave') {
    hubRemove(String(o.id || ''));
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(out));
}

const http = createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/hub/')) {
    const url = new URL(req.url, 'http://x');
    const what = url.pathname.slice(5);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' });
      res.end();
      return;
    }
    if (what === 'events') {
      hubEvents(req, res, String(url.searchParams.get('id') || ''));
      return;
    }
    await hubPost(req, res, what);
    return;
  }
  if (req.url && req.url.startsWith('/stats')) {
    if (req.method === 'POST') {
      try {
        addStats(await readBody(req));
      } catch (e) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(statsPage());
    return;
  }
  if (req.url && req.url.startsWith('/arena-rooms')) {
    let list = [];
    try {
      const rooms = await matchMaker.query({ name: 'arena' });
      list = rooms.map((r) => ({ code: r.roomId, players: r.clients, max: r.maxClients, playing: !!(r.metadata && r.metadata.playing) }));
      for (const r of hubRooms.values()) {
        if (r.kind === 'arena') {
          list.push({ code: r.code, players: r.members.size, max: maxPals, playing: r.playing });
        }
      }
    } catch (e) {
      list = [];
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(list));
    return;
  }
  res.writeHead(200);
  res.end('Blast Pals server OK');
});

const server = new Server({ transport: new WebSocketTransport({ server: http, pingInterval: 5000, pingMaxRetries: 6 }) });
server.define('blast', BlastRoom);
server.define('arena', ArenaRoom);
const inst = Number(process.env['NODE' + U + 'APP' + U + 'INSTANCE'] || 0);
if (process.env['COLYSEUS' + U + 'CLOUD'] !== undefined) {
  const sock = '/run/colyseus/' + (2567 + inst) + '.sock';
  rm(sock, { force: true }).then(() => server.listen(sock)).then(() => console.log('listening on ' + sock));
} else {
  server.listen((Number(process.env.PORT) || 2567) + inst).then(() => console.log('listening'));
}
