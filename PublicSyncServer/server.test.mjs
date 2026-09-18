import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncServer, CARDS } from './server.mjs';

const token = () => randomUUID().replaceAll('-', '');
async function launch(options = {}) {
  const server = createSyncServer({ dataFile: null, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    server, url,
    async call(path, auth, data) {
      const response = await fetch(url + path, { method: data === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
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
test('late join, lost-response retry, concurrent first publication and room isolation', async t => {
  const service = await launch(); t.after(service.close);
  const a = token(), b = token(), c = token();
  const roomA = '/v1/rooms/' + (await service.call('/v1/rooms', a, { name: 'A' })).body.roomCode;
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
    const result = await fetch(service.url + room + '/publish', { method: 'POST', headers: { Authorization: 'Bearer ' + a }, body });
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
  await service.call(room + '/publish', a, { cardId: 'Theo06' });
  await service.close();
  service = await launch({ dataFile, now: () => time });
  t.after(service.close);
  const recovered = await service.call(room, b);
  assert.equal(recovered.body.revision, 1);
  assert.equal(recovered.body.players.length, 2);
  assert.equal(recovered.body.publications[0].cardId, 'Theo06');
  time += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await service.call(room, b)).status, 404);
});
