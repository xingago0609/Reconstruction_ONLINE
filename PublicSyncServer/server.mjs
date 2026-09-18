import http from 'node:http';
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CARDS = new Set([
  ...Array.from({ length: 28 }, (_, i) => `Con${String(i + 3).padStart(2, '0')}`),
  ...[2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(i => `Phen${String(i).padStart(2, '0')}`),
  ...[2, 3, 4, 5, 6, 7].map(i => `Theo${String(i).padStart(2, '0')}`),
]);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_TTL = 24 * 60 * 60 * 1000;
class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
function reject(status, code) { throw new ApiError(status, code); }
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) reject(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject(400, 'INVALID_JSON');
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    reject(400, 'INVALID_JSON');
  }
}
function tokenOf(req) {
  const match = /^Bearer ([a-f0-9]{32})$/.exec(req.headers.authorization || '');
  if (!match) reject(401, 'INVALID_TOKEN');
  return match[1];
}
function nameOf(value) {
  if (typeof value !== 'string') reject(400, 'INVALID_NAME');
  const name = value.trim();
  if (!name || name.length > 20 || /[\u0000-\u001f\u007f]/.test(name)) reject(400, 'INVALID_NAME');
  return name;
}

// One process owns the state file. Mount its directory on durable storage in production.
export function createSyncServer({ dataFile = resolve('data/rooms.json'), now = Date.now, maxRooms = 200 } = {}) {
  let rooms = {};
  if (dataFile) {
    try {
      const saved = JSON.parse(readFileSync(dataFile, 'utf8'));
      if (saved.schema !== 1 || !saved.rooms || typeof saved.rooms !== 'object') throw new Error('Unsupported room data');
      rooms = saved.rooms;
      for (const room of Object.values(rooms)) for (const player of room.players) player.lastSeen = 0;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function persist() {
    if (!dataFile) return;
    mkdirSync(dirname(dataFile), { recursive: true });
    const temporary = dataFile + '.tmp';
    writeFileSync(temporary, JSON.stringify({ schema: 1, rooms }), { mode: 0o600 });
    renameSync(temporary, dataFile);
  }
  function commit(change) {
    const backup = JSON.stringify(rooms);
    try { const result = change(); persist(); return result; }
    catch (error) { rooms = JSON.parse(backup); throw error; }
  }
  function cleanup() {
    for (const [code, room] of Object.entries(rooms)) if (room.expiresAt <= now()) delete rooms[code];
  }
  function getRoom(code) {
    const room = rooms[code];
    if (!room || room.expiresAt <= now()) reject(404, 'ROOM_NOT_FOUND');
    return room;
  }
  function member(room, token) {
    const player = room.players.find(p => p.token === token);
    if (!player) reject(403, 'NOT_A_MEMBER');
    player.lastSeen = now();
    return player;
  }
  function snapshot(room) {
    return {
      protocol: 1, roomCode: room.code, revision: room.publications.length,
      expiresAt: room.expiresAt,
      players: room.players.map(p => ({ slot: p.slot, name: p.name, online: now() - p.lastSeen < 15000 })),
      publications: room.publications,
    };
  }
  const rates = new Map();
  function limit(req) {
    const key = req.socket.remoteAddress;
    const time = now();
    // High enough for a classroom sharing one NAT address. Do not trust X-Forwarded-For.
    if (rates.size > 2000) for (const [ip, item] of rates) if (time - item.start >= 60000) rates.delete(ip);
    let rate = rates.get(key);
    if (!rate || time - rate.start >= 60000) { rate = { start: time, count: 0, creates: 0 }; rates.set(key, rate); }
    if (++rate.count > 12000) reject(429, 'TOO_MANY_REQUESTS');
    if (req.method === 'POST' && req.url === '/v1/rooms' && ++rate.creates > 40) reject(429, 'TOO_MANY_ROOMS');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    function send(status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    }
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      limit(req);
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
        send(200, { service: 'Reconstruction public-card sync', protocol: 1, status: 'ok' }); return;
      }
      const token = tokenOf(req);
      if (req.method === 'POST' && req.url === '/v1/rooms') {
        const body = await readJson(req);
        const name = nameOf(body.name);
        cleanup();
        // A lost create response can be retried without creating another room.
        const existing = Object.values(rooms).find(r => r.ownerToken === token);
        if (existing) { member(existing, token); send(200, snapshot(existing)); return; }
        if (Object.keys(rooms).length >= maxRooms) reject(503, 'SERVER_FULL');
        let code;
        do { code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms[code]);
        const room = commit(() => {
          const created = { code, ownerToken: token, expiresAt: now() + ROOM_TTL,
            players: [{ token, slot: 1, name, lastSeen: now() }], publications: [] };
          rooms[code] = created;
          return created;
        });
        send(201, snapshot(room)); return;
      }
      const match = /^\/v1\/rooms\/([A-Z2-9]{8})(?:\/(join|publish))?$/.exec(req.url || '');
      if (!match) reject(404, 'NOT_FOUND');
      const [, code, action] = match;
      // Read the body before retrieving state: another request may mutate it while reading.
      const body = req.method === 'POST' ? await readJson(req) : null;
      const room = getRoom(code);
      if (req.method === 'POST' && action === 'join') {
        const name = nameOf(body.name);
        const existing = room.players.find(p => p.token === token);
        if (existing) { existing.lastSeen = now(); send(200, snapshot(room)); return; }
        if (room.players.length >= 4) reject(409, 'ROOM_FULL');
        commit(() => { room.players.push({ token, slot: room.players.length + 1, name, lastSeen: now() }); });
        send(200, snapshot(room)); return;
      }
      const player = member(room, token);
      if (req.method === 'GET' && !action) { send(200, snapshot(room)); return; }
      if (req.method === 'POST' && action === 'publish') {
        if (typeof body.cardId !== 'string' || !CARDS.has(body.cardId)) reject(400, 'INVALID_CARD');
        // The server serializes first publication; retries and concurrent clicks never duplicate it.
        if (!room.publications.some(p => p.cardId === body.cardId)) {
          commit(() => room.publications.push({ cardId: body.cardId, slot: player.slot,
            name: player.name, revision: room.publications.length + 1, publishedAt: now() }));
        }
        send(200, snapshot(room)); return;
      }
      reject(405, 'METHOD_NOT_ALLOWED');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Room request failed:', error.message);
      if (!res.headersSent) send(error.status || 500, { error: error instanceof ApiError ? error.message : 'SERVER_ERROR' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const server = createSyncServer({ dataFile: resolve(process.env.DATA_FILE || 'data/rooms.json') });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Public-card sync listening on port ${port}. Health: /health`));
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
