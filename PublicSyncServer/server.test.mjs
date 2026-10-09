import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncServer, CARDS, ROLES } from './server.mjs';

async function fullRoom(service, started = false) {
  const users = Array.from({length: 4}, token);
  const created = await service.call('/v1/rooms', users[0], {name: '房主'});
  assert.equal(created.status, 201);
  const room = '/v1/rooms/' + created.body.roomCode;
  for (const user of users.slice(1)) await service.call(room + '/join', user, {name: '同名玩家'});
  if (started) await ready(service, room, users);
  return {room, users};
}
async function kick(service, room, host, slot) {
  const snapshot = (await service.call(room, host)).body;
  return service.call(room + '/kick', host, {slot, expectedRevision: snapshot.stateRevision});
}

test('identity is required and never exposed; token alone cannot impersonate a browser', async t => {
  const service = await launch(); t.after(service.close);
  const a = token();
  assert.equal((await service.call('/v1/rooms', a, {name:'A'}, null)).body.error, 'INVALID_DEVICE_ID');
  assert.equal((await service.call('/v1/rooms', a, {name:'A', deviceId: token()})).body.error, 'IDENTITY_MISMATCH');
  const created = await service.call('/v1/rooms', a, {name:'A'});
  assert.equal(created.body.ownerSlot, created.body.selfSlot);
  assert.equal(created.body.roomRulesVersion, 2);
  const room = '/v1/rooms/' + created.body.roomCode;
  assert.equal((await service.call(room, a, undefined, token())).body.error, 'IDENTITY_MISMATCH');
  assert.equal((await service.call(room+'/join', a, {name:'A'}, token())).body.error, 'IDENTITY_MISMATCH');
  assert.ok(!JSON.stringify(created.body).includes(device(a)));
  const options = await fetch(service.url + room, {method:'OPTIONS'});
  assert.match(options.headers.get('access-control-allow-headers'), /X-Player-Device/);
});

test('simultaneous selection is atomic; offline roles remain reserved and cannot be started', async t => {
  let time = Date.now();
  const service = await launch({now: () => time}); t.after(service.close);
  const {room, users} = await fullRoom(service);
  assert.equal((await service.call(room+'/publish', users[0], {cardId:'Phen04'})).body.error, 'GAME_NOT_READY');
  const results = await Promise.all(users.slice(0,2).map(user => service.call(room+'/role', user, {role:'托勒密'})));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.body.error === 'ROLE_TAKEN').length, 1);
  // Release the winner's choice by selecting a different role, then assign deterministically.
  const winner = results[0].status === 200 ? 0 : 1;
  await service.call(room+'/role', users[winner], {role:'哥白尼'});
  for (let i=0;i<4;i++) await service.call(room+'/role', users[i], {role:[...ROLES][i]});
  // Last assignment can conflict with the temporary role; move winner then retry each.
  for (let i=0;i<4;i++) await service.call(room+'/role', users[i], {role:[...ROLES][i]});
  time += 16000;
  const poll = (await service.call(room, users[0])).body;
  assert.equal(poll.players[1].online, false);
  assert.equal((await service.call(room+'/role', users[0], {role:'柏拉圖'})).body.error, 'ROLE_TAKEN');
  assert.equal((await service.call(room+'/start', users[0], {})).body.error, 'PLAYERS_OFFLINE');
});

test('same browser reclaims only its offline seat, role and host status; old token is revoked', async t => {
  let time = Date.now();
  const service = await launch({now: () => time}); t.after(service.close);
  const {room, users} = await fullRoom(service, true);
  const returning = token();
  const original = device(users[0]);
  assert.equal((await service.call(room+'/join', returning, {name:'房主回來'}, original)).body.error, 'DEVICE_ALREADY_ONLINE');
  time += 15001;
  const joined = await service.call(room+'/join', returning, {name:'房主回來'}, original);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.selfSlot, 1);
  assert.equal(joined.body.ownerSlot, 1);
  assert.equal(joined.body.players[0].role, '托勒密');
  assert.equal(joined.body.gameStarted, true);
  assert.equal((await service.call(room, users[0])).body.error, 'NOT_A_MEMBER');
  assert.equal((await service.call(room+'/join', token(), {name:'同名玩家'})).body.error, 'ROOM_FULL');
  assert.equal((await service.call(room, returning, undefined, original)).status, 200);
});

test('kick bans token and device, releases role, permits replacement after start, forbids slot races', async t => {
  const service = await launch(); t.after(service.close);
  const {room, users} = await fullRoom(service, true);
  const stale = (await service.call(room, users[0])).body.stateRevision;
  assert.equal((await service.call(room+'/kick', users[1], {slot:3, expectedRevision:stale})).body.error, 'NOT_OWNER');
  assert.equal((await kick(service, room, users[0], 1)).body.error, 'CANNOT_KICK_OWNER');
  assert.equal((await kick(service, room, users[0], 2)).status, 200);
  assert.equal((await service.call(room, users[1])).body.error, 'ROOM_KICKED');
  assert.equal((await service.call(room+'/join', users[1], {name:'換名'})).body.error, 'ROOM_KICKED');
  assert.equal((await service.call(room+'/join', token(), {name:'換token'}, device(users[1]))).body.error, 'ROOM_KICKED');
  assert.equal((await service.call(room+'/join', users[1], {name:'換device'}, token())).body.error, 'ROOM_KICKED');
  assert.equal((await service.call(room+'/join', token(), {name:'省略身分'}, null)).body.error, 'INVALID_DEVICE_ID');
  const replacement = token();
  const joined = await service.call(room+'/join', replacement, {name:'替補'});
  assert.equal(joined.body.selfSlot, 2);
  assert.equal(joined.body.players.find(p => p.slot === 2).role, null);
  assert.equal((await service.call(room+'/publish', replacement, {cardId:'Phen04'})).body.error, 'GAME_NOT_READY');
  assert.equal((await service.call(room+'/role', replacement, {role:'柏拉圖'})).status, 200);
  assert.equal((await service.call(room+'/role', replacement, {role:'哥白尼'})).body.error, 'GAME_ALREADY_STARTED');
  assert.equal((await service.call(room+'/kick', users[0], {slot:2, expectedRevision:stale})).body.error, 'ROOM_CHANGED');
  assert.equal((await service.call(room+'/publish', replacement, {cardId:'Phen04'})).status, 200);
  // A ban is scoped to this room, not the whole service.
  assert.equal((await service.call('/v1/rooms', users[1], {name:'新房主'})).status, 201);
});

test('start is host-only and idempotent; all players see the same start without losing membership', async t => {
  const service = await launch(); t.after(service.close);
  const {room, users} = await fullRoom(service);
  assert.equal((await service.call(room+'/start', users[0], {})).body.error, 'FOUR_UNIQUE_ROLES_REQUIRED');
  await ready(service, room, users);
  const first = (await service.call(room, users[0])).body;
  assert.equal((await service.call(room+'/start', users[0], {})).body.stateRevision, first.stateRevision);
  for (const user of users) {
    const poll = (await service.call(room, user)).body;
    assert.equal(poll.gameStarted, true);
    assert.equal(poll.ownerSlot, 1);
    assert.equal(poll.players.length, 4);
  }
});

test('voluntary leave frees a seat, host leave ends room, bans survive server restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'reconstruction-identity-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const dataFile = join(dir, 'rooms.json');
  let service = await launch({dataFile});
  const {room, users} = await fullRoom(service, true);
  await kick(service, room, users[0], 2);
  await service.close();
  service = await launch({dataFile}); t.after(service.close);
  assert.equal((await service.call(room+'/join', token(), {name:'被踢重試'}, device(users[1]))).body.error, 'ROOM_KICKED');
  assert.equal((await service.call(room+'/leave', users[2], {})).body.left, true);
  assert.equal((await service.call(room+'/join', users[2], {name:'主動離開可回來'})).status, 200);
  assert.equal((await service.call(room+'/leave', users[0], {})).body.roomClosed, true);
  assert.equal((await service.call(room, users[3])).body.error, 'ROOM_NOT_FOUND');
});

const token = () => randomUUID().replaceAll('-', '');
const devices = new Map();
function device(auth) {
  if (!devices.has(auth)) devices.set(auth, token());
  return devices.get(auth);
}
async function launch(options = {}) {
  const server = createSyncServer({ dataFile: null, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    server, url,
    async call(path, auth, data, deviceId = device(auth)) {
      if (data && (path === '/v1/rooms' || path.endsWith('/join'))) data = { deviceId, ...data };
      const response = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json',
          ...(deviceId == null ? {} : { 'X-Player-Device': deviceId }) },
        body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
async function ready(service, room, users) {
  for (const [i, user] of users.entries())
    assert.equal((await service.call(room + '/role', user, {role: [...ROLES][i]})).status, 200);
  assert.equal((await service.call(room + '/start', users[0], {})).status, 200);
}
test('four players receive all 48 cards; replay is idempotent; fifth is rejected', async t => {
  const service = await launch(); t.after(service.close);
  const users = Array.from({ length: 5 }, token);
  const created = await service.call('/v1/rooms', users[0], { name: 'A 組' });
  assert.equal(created.status, 201);
  const room = '/v1/rooms/' + created.body.roomCode;
  const retryCreate = await service.call('/v1/rooms', users[0], { name: 'A 組' });
  assert.equal(retryCreate.body.roomCode, created.body.roomCode);
  for (let i = 1; i < 4; i++) assert.equal((await service.call(room + '/join', users[i], { name: '玩家' + i })).status, 200);
  assert.equal((await service.call(room + '/join', users[4], { name: '第五人' })).status, 409);
  assert.equal((await service.call(room + '/join', users[1], { name: '恢復' })).body.players.length, 4);
  await ready(service, room, users.slice(0, 4));
  for (const [index, cardId] of [...CARDS].entries()) {
    assert.equal((await service.call(room + '/publish', users[index % 4], { cardId })).status, 200);
  }
  const duplicates = await Promise.all(users.slice(0, 4).map(user => service.call(room + '/publish', user, { cardId: 'Con03' })));
  for (const result of duplicates) assert.equal(result.body.revision, 48);
  const snapshots = await Promise.all(users.slice(0, 4).map(user => service.call(room, user)));
  for (const result of snapshots) {
    assert.equal(result.body.publications.length, 48);
    assert.deepEqual(result.body.publications, snapshots[0].body.publications);
    assert.equal(result.body.players.length, 4);
    assert.ok(!JSON.stringify(result.body).includes(users[0]));
  }
});
test('rejoin, lost-response retry, concurrent first publication and room isolation', async t => {
  const service = await launch(); t.after(service.close);
  const a = token(), b = token(), c = token();
  const roomA = '/v1/rooms/' + (await service.call('/v1/rooms', a, { name: 'A' })).body.roomCode;
  const members = [a, b, token(), token()];
  for (const user of members.slice(1)) await service.call(roomA + '/join', user, {name: '玩家'});
  await ready(service, roomA, members);
  await service.call(roomA + '/publish', a, { cardId: 'Phen04' });
  const late = await service.call(roomA + '/join', b, { name: 'B' });
  assert.deepEqual(late.body.publications.map(p => p.cardId), ['Phen04']);
  await Promise.all([a, b].map(auth => service.call(roomA + '/publish', auth, { cardId: 'Theo02' })));
  const replay = await service.call(roomA + '/publish', a, { cardId: 'Phen04' });
  assert.equal(replay.body.revision, 2);
  const roomC = '/v1/rooms/' + (await service.call('/v1/rooms', c, { name: 'C' })).body.roomCode;
  assert.equal((await service.call(roomC, c)).body.revision, 0);
  assert.equal((await service.call(roomA, c)).status, 403);
  assert.equal((await service.call(roomA + '/publish', c, { cardId: 'Con03' })).status, 403);
});
test('validation rejects invalid cards, malformed JSON, oversized bodies and unauthorized requests', async t => {
  const service = await launch(); t.after(service.close);
  const a = token();
  const room = '/v1/rooms/' + (await service.call('/v1/rooms', a, { name: 'A' })).body.roomCode;
  for (const cardId of ['Phen06', 'Con01', 'Theo99', 'Con3', '__proto__', 3, null])
    assert.equal((await service.call(room + '/publish', a, { cardId })).status, 400);
  assert.equal((await service.call(room, 'invalid')).status, 401);
  assert.equal((await service.call('/v1/rooms', token(), { name: '' })).status, 400);
  for (const [body, expected] of [['{', 400], ['x'.repeat(5000), 413], ['null', 400]]) {
    const result = await fetch(service.url + room + '/publish', { method: 'POST',
      headers: { Authorization: 'Bearer ' + a, 'X-Player-Device': device(a) }, body });
    assert.equal(result.status, expected);
  }
  assert.equal((await service.call(room, a)).body.revision, 0);
});
test('server restart preserves membership and public cards, room expires after 24 hours', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'reconstruction-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataFile = join(dir, 'rooms.json');
  let time = Date.now();
  let service = await launch({ dataFile, now: () => time });
  const a = token(), b = token();
  const code = (await service.call('/v1/rooms', a, { name: 'A' })).body.roomCode;
  const room = '/v1/rooms/' + code;
  await service.call(room + '/join', b, { name: 'B' });
  await service.call(room + '/role', b, { role: '柏拉圖' });
  const members = [a, b, token(), token()];
  for (const user of members.slice(2)) await service.call(room + '/join', user, {name: '玩家'});
  await ready(service, room, members);
  await service.call(room + '/publish', a, { cardId: 'Theo06' });
  await service.close();
  service = await launch({ dataFile, now: () => time });
  t.after(service.close);
  const recovered = await service.call(room, b);
  assert.equal(recovered.body.revision, 1);
  assert.equal(recovered.body.players.length, 4);
  assert.equal(recovered.body.players[1].role, '柏拉圖');
  assert.equal(recovered.body.selfSlot, 2);
  assert.equal(recovered.body.publications[0].cardId, 'Theo06');
  time += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await service.call(room, b)).status, 404);
});

test('confirmed roles appear in POST and polling snapshots and remain unique', async t => {
  const service = await launch(); t.after(service.close);
  const users = Array.from({length:4}, token);
  const created = await service.call('/v1/rooms', users[0], {name:'同名玩家'});
  const room = '/v1/rooms/' + created.body.roomCode;
  assert.equal(created.body.rolesSupported, true);
  assert.equal(created.body.players[0].role, null);
  for (let i=1;i<4;i++) await service.call(room+'/join',users[i],{name:'同名玩家'});
  let revision = (await service.call(room,users[0])).body.stateRevision;
  const roles = [...ROLES];
  for (let i=0;i<4;i++) {
    const selected = await service.call(room+'/role',users[i],{role:roles[i]});
    assert.equal(selected.status,200);
    assert.equal(selected.body.selfSlot,i+1);
    assert.equal(selected.body.players[i].role,roles[i]);
    assert.ok(selected.body.stateRevision>revision);
    revision=selected.body.stateRevision;
    assert.equal(selected.body.revision,0,'card revision does not change when choosing a role');
  }
  const occupied = await service.call(room+'/role',users[1],{role:roles[0]});
  assert.equal(occupied.body.error,'ROLE_TAKEN');
  assert.equal((await service.call(room+'/role',users[1],{role:'未知角色'})).body.error,'INVALID_ROLE');
  for(let i=0;i<4;i++) {
    const poll=await service.call(room,users[i]);
    assert.deepEqual(poll.body.players.map(p=>p.role),roles);
    assert.equal(poll.body.selfSlot,i+1);
    for(const secret of users) assert.ok(!JSON.stringify(poll.body).includes(secret));
  }
  assert.equal((await service.call(room+'/start',users[1],{})).body.error,'NOT_OWNER');
  const started=await service.call(room+'/start',users[0],{});
  assert.equal(started.status,200);
  assert.equal(started.body.gameStarted,true);
  assert.equal((await service.call(room+'/role',users[0],{role:roles[0]})).body.error,'GAME_ALREADY_STARTED');
});
