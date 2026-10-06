import { Server, Room } from '@colyseus/core'; import { WebSocketTransport } from '@colyseus/ws-transport'; import { createServer } from 'node:http'; import { rm } from 'node:fs/promises';

const CODECHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const CODESCHANNEL = '$blastpals-codes'; const MAX_PALS = 4;

function makeCode() { let s = ''; for (let i = 0; i < 5; i++) { s += CODECHARS[Math.floor(Math.random() * CODECHARS.length)]; } return s; }

class BlastRoom extends Room { maxClients = MAX_PALS; hostId = null; slots = new Map();

async onCreate() { const used = await this.presence.smembers(CODESCHANNEL); let code; do { code = makeCode(); } while (used.includes(code)); await this.presence.sadd(CODESCHANNEL, code); this.roomId = code;

this.onMessage('snap', (client, data) => { if (client.sessionId === this.hostId) { this.broadcast('snap', data, { except: client }); } });

this.onMessage('in', (client, data) => { this.toHost('in', { slot: this.slots.get(client.sessionId), ...data }); });

this.onMessage('bomb', (client) => { this.toHost('bomb', { slot: this.slots.get(client.sessionId) }); }); }

toHost(type, data) { const host = this.clients.find((c) => c.sessionId === this.hostId); if (host) { host.send(type, data); } }

onJoin(client) { const taken = new Set(this.slots.values()); let slot = 0; while (taken.has(slot)) { slot++; } this.slots.set(client.sessionId, slot); if (!this.hostId) { this.hostId = client.sessionId; } client.send('welcome', { code: this.roomId, slot, host: client.sessionId === this.hostId }); if (client.sessionId !== this.hostId) { this.toHost('joined', { slot }); } if (this.clients.length >= MAX_PALS) { this.lock(); } }

onLeave(client) { const slot = this.slots.get(client.sessionId); this.slots.delete(client.sessionId); if (client.sessionId === this.hostId) { this.broadcast('hostLeft', {}); this.disconnect(); return; } this.toHost('left', { slot }); this.unlock(); }

async onDispose() { await this.presence.srem(CODES_CHANNEL, this.roomId); } }

const http = createServer((req, res) => { res.writeHead(200); res.end('Blast Pals server OK'); });

const gameServer = new Server({ transport: new WebSocketTransport({ server: http }) }); gameServer.define('blast', BlastRoom);

async function start() { const instance = Number(process.env.NODEAPPINSTANCE || 0); if (process.env.COLYSEUS_CLOUD !== undefined) { const socketPath = /run/colyseus/${2567 + instance}.sock; await rm(socketPath, { force: true }); await gameServer.listen(socketPath); console.log(Blast Pals server listening on ${socketPath}); } else { const port = (Number(process.env.PORT) || 2567) + instance; await gameServer.listen(port); console.log(Blast Pals server listening on ws://localhost:${port}); } if (typeof process.send === 'function') { process.send('ready'); } }

start(); 
