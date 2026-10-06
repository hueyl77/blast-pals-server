```js import { Server, Room, matchMaker } from '@colyseus/core'; import { WebSocketTransport } from '@colyseus/ws-transport'; import { createServer } from 'node:http'; import { rm } from 'node:fs/promises';

const U = String.fromCharCode(95); const codeChars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const codesChannel = '$blastpals-codes'; const maxPals = 4;

function makeCode() { let s = ''; for (let i = 0; i < 5; i++) { s += codeChars.charAt(Math.floor(Math.random() * codeChars.length)); } return s; }

class BlastRoom extends Room { maxClients = maxPals; hostId = null; slots = new Map();

async onCreate() { const used = await this.presence.smembers(codesChannel); let code = makeCode(); while (used.includes(code)) { code = makeCode(); } await this.presence.sadd(codesChannel, code); this.roomId = code; this.onMessage('snap', (client, data) => { if (client.sessionId === this.hostId) { this.broadcast('snap', data, { except: client }); } }); this.onMessage('in', (client, data) => { this.toHost('in', Object.assign({ slot: this.slots.get(client.sessionId) }, data)); }); this.onMessage('bomb', (client) => { this.toHost('bomb', { slot: this.slots.get(client.sessionId) }); }); }

toHost(type, data) { const host = this.clients.find((c) => c.sessionId === this.hostId); if (host) { host.send(type, data); } }

onJoin(client) { const taken = new Set(this.slots.values()); let slot = 0; while (taken.has(slot)) { slot++; } this.slots.set(client.sessionId, slot); if (!this.hostId) { this.hostId = client.sessionId; } client.send('welcome', { code: this.roomId, slot: slot, host: client.sessionId === this.hostId }); if (client.sessionId !== this.hostId) { this.toHost('joined', { slot: slot }); } if (this.clients.length >= maxPals) { this.lock(); } }

onLeave(client) { const slot = this.slots.get(client.sessionId); this.slots.delete(client.sessionId); if (client.sessionId === this.hostId) { this.broadcast('hostLeft', {}); this.disconnect(); return; } this.toHost('left', { slot: slot }); this.unlock(); }

async onDispose() { await this.presence.srem(codesChannel, this.roomId); } }

class ArenaRoom extends BlastRoom { playing = false;

async onCreate() { await super.onCreate(); this.setMetadata({ playing: false }); this.onMessa
