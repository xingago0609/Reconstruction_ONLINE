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
export const ROLES = new Set(['托勒密', '柏拉圖', '菲洛勞斯', '哥白尼']);
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
function deviceIdOf(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) reject(400, 'INVALID_DEVICE_ID');
  return value;
}

// One process owns the state file. Mount its directory on durable storage in production.
export function createSyncServer({ dataFile = resolve('data/rooms.json'), now = Date.now, maxRooms = 200 } = {}) {
  let rooms = {};
  if (dataFile) {
    try {
      const saved = JSON.parse(readFileSync(dataFile, 'utf8'));
      if (saved.schema !== 1 || !saved.rooms || typeof saved.rooms !== 'object') throw new Error('Unsupported room data');
      rooms = saved.rooms;
      for (const room of Object.values(rooms)) {
        room.kickedDeviceIds = Array.isArray(room.kickedDeviceIds) ? room.kickedDeviceIds : [];
        room.kickedTokens = Array.isArray(room.kickedTokens) ? room.kickedTokens : [];
        for (const player of room.players) player.lastSeen = 0;
      }
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
  function member(room, token, deviceId) {
    if ((room.kickedTokens || []).includes(token)) reject(403, 'ROOM_KICKED');
    if (room.kickedDeviceIds.includes(deviceId)) reject(403, 'ROOM_KICKED');
    const player = room.players.find(p => p.token === token);
    if (!player) reject(403, 'NOT_A_MEMBER');
    if (player.deviceId !== deviceId) reject(403, 'IDENTITY_MISMATCH');
    player.lastSeen = now();
    return player;
  }
  function snapshot(room, token) {
    return {
      protocol: 1, roomCode: room.code, revision: room.publications.length,
      expiresAt: room.expiresAt,
      rolesSupported: true, roomRulesVersion: 2, stateRevision: room.stateRevision || 0,
      selfSlot: room.players.find(p => p.token === token)?.slot || 0,
      players: room.players.map(p => ({ slot: p.slot, name: p.name, role: p.role || null, online: p.lastSeen > 0 && now() - p.lastSeen < 15000 })),
      publications: room.publications,
      ownerSlot: room.players.find(p => p.token === room.ownerToken)?.slot || 0,
      gameStarted: room.gameStarted === true,
      century: room.century || 1,
      currentSlot: room.currentSlot || 1,
      actionPoints: [1, 2, 3, 4].map(slot => {
        const player = room.players.find(p => p.slot === slot);
        return player ? (player.actionPoints == null ? 3 : player.actionPoints) : 0;
      }),
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Player-Device');
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
        send(200, { service: 'Reconstruction public-card sync', protocol: 1, roomRulesVersion: 2, status: 'ok' }); return;
      }
      const token = tokenOf(req);
      const deviceId = deviceIdOf(req.headers['x-player-device']);
      if (req.method === 'POST' && req.url === '/v1/rooms') {
        const body = await readJson(req);
        const name = nameOf(body.name);
        if (deviceIdOf(body.deviceId) !== deviceId) reject(403, 'IDENTITY_MISMATCH');
        cleanup();
        // A lost create response can be retried without creating another room.
        const existing = Object.values(rooms).find(r => r.ownerToken === token);
        if (existing) { member(existing, token, deviceId); send(200, snapshot(existing, token)); return; }
        if (Object.keys(rooms).length >= maxRooms) reject(503, 'SERVER_FULL');
        let code;
        do { code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms[code]);
        const room = commit(() => {
          const created = { code, ownerToken: token, expiresAt: now() + ROOM_TTL,
            players: [{ token, deviceId, slot: 1, name, role: null, lastSeen: now(), actionPoints: 3 }],
            kickedDeviceIds: [], kickedTokens: [], publications: [], stateRevision: 0, gameStarted: false, century: 1, currentSlot: 1 };
          rooms[code] = created;
          return created;
        });
        send(201, snapshot(room, token)); return;
      }
      const match = /^\/v1\/rooms\/([A-Z2-9]{8})(?:\/(join|publish|role|start|kick|leave))?$/.exec(req.url || '');
      if (!match) reject(404, 'NOT_FOUND');
      const [, code, action] = match;
      // Read the body before retrieving state: another request may mutate it while reading.
      const body = req.method === 'POST' ? await readJson(req) : null;
      const room = getRoom(code);
      const player = action === 'join' ? null : member(room, token, deviceId);
      if (req.method === 'POST' && action === 'role') {
        // A replacement may choose a freed role, but existing players cannot switch mid-game.
        if (room.gameStarted && player.role) reject(409, 'GAME_ALREADY_STARTED');
        const role = nameOf(body.role);
        if (!ROLES.has(role)) reject(400, 'INVALID_ROLE');
        if (room.players.some(p => p.role === role && p.token !== token)) reject(409, 'ROLE_TAKEN');
        commit(() => { player.role = role; room.stateRevision = (room.stateRevision || 0) + 1; });
        send(200, snapshot(room, token)); return;
      }
      if (req.method === 'POST' && action === 'start') {
        if (player.token !== room.ownerToken) reject(403, 'NOT_OWNER');
        if (room.gameStarted) { send(200, snapshot(room, token)); return; }
        if (room.players.length !== 4 || room.players.some(p => !ROLES.has(p.role)) || new Set(room.players.map(p => p.role)).size !== 4)
          reject(409, 'FOUR_UNIQUE_ROLES_REQUIRED');
        if (room.players.some(p => !p.lastSeen || now() - p.lastSeen >= 15000)) reject(409, 'PLAYERS_OFFLINE');
        commit(() => { room.gameStarted = true; room.currentSlot = 1; room.stateRevision = (room.stateRevision || 0) + 1; });
        send(200, snapshot(room, token)); return;
      }
      if (req.method === 'POST' && action === 'kick') {
        if (player.token !== room.ownerToken) reject(403, 'NOT_OWNER');
        const slot = Number(body.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > 4) reject(400, 'INVALID_SLOT');
        if (slot === player.slot) reject(403, 'CANNOT_KICK_OWNER');
        const target = room.players.find(p => p.slot === slot);
        if (!target) reject(404, 'PLAYER_NOT_FOUND');
        if (!Number.isInteger(body.expectedRevision) || body.expectedRevision !== (room.stateRevision || 0))
          reject(409, 'ROOM_CHANGED');
        commit(() => {
          if (target.deviceId && !room.kickedDeviceIds.includes(target.deviceId)) room.kickedDeviceIds.push(target.deviceId);
          if (!room.kickedTokens.includes(target.token)) room.kickedTokens.push(target.token);
          room.players = room.players.filter(p => p !== target);
          room.stateRevision = (room.stateRevision || 0) + 1;
        });
        send(200, snapshot(room, token)); return;
      }
      if (req.method === 'POST' && action === 'leave') {
        if (player.token === room.ownerToken) {
          commit(() => { delete rooms[code]; });
          send(200, { left: true, roomClosed: true }); return;
        }
        commit(() => {
          room.players = room.players.filter(p => p !== player);
          room.stateRevision = (room.stateRevision || 0) + 1;
        });
        send(200, { left: true, roomClosed: false }); return;
      }
      if (req.method === 'POST' && action === 'join') {
        const name = nameOf(body.name);
        if (deviceIdOf(body.deviceId) !== deviceId) reject(403, 'IDENTITY_MISMATCH');
        if (room.kickedTokens.includes(token) || room.kickedDeviceIds.includes(deviceId)) reject(403, 'ROOM_KICKED');
        const existing = room.players.find(p => p.token === token);
        if (existing) { member(room, token, deviceId); send(200, snapshot(room, token)); return; }
        const returning = room.players.find(p => p.deviceId === deviceId);
        if (returning) {
          if (returning.lastSeen > 0 && now() - returning.lastSeen < 15000) reject(409, 'DEVICE_ALREADY_ONLINE');
          commit(() => {
            const wasOwner = returning.token === room.ownerToken;
            returning.token = token;
            returning.name = name;
            returning.lastSeen = now();
            if (wasOwner) room.ownerToken = token;
            room.stateRevision = (room.stateRevision || 0) + 1;
          });
          send(200, snapshot(room, token)); return;
        }
        if (room.players.length >= 4) reject(409, 'ROOM_FULL');
        const occupiedSlots = new Set(room.players.map(p => p.slot));
        const slot = [1, 2, 3, 4].find(candidate => !occupiedSlots.has(candidate));
        commit(() => { room.players.push({ token, deviceId, slot, name, role: null, lastSeen: now(), actionPoints: 3 }); room.stateRevision = (room.stateRevision || 0) + 1; });
        send(200, snapshot(room, token)); return;
      }
      if (req.method === 'GET' && !action) { send(200, snapshot(room, token)); return; }
      if (req.method === 'POST' && action === 'publish') {
        if (typeof body.cardId !== 'string' || !CARDS.has(body.cardId)) reject(400, 'INVALID_CARD');
        if (!room.gameStarted || !ROLES.has(player.role)) reject(409, 'GAME_NOT_READY');
        // The server serializes first publication; retries and concurrent clicks never duplicate it.
        if (!room.publications.some(p => p.cardId === body.cardId)) {
          commit(() => {
            room.publications.push({ cardId: body.cardId, slot: player.slot,
              name: player.name, revision: room.publications.length + 1, publishedAt: now() });
            room.stateRevision = (room.stateRevision || 0) + 1;
          });
        }
        send(200, snapshot(room, token)); return;
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






