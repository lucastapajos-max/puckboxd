import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../src/db.js';
import { createNhl } from '../src/nhl.js';
import { createApp } from '../src/app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mock = createNhl({ mock: true });
// Jogos marcados aqui aparecem como "ainda não começou", com o horário de início guardado no mapa.
const future = new Map();
const nhl = {
  ...mock,
  async game(id) {
    const g = await mock.game(id);
    if (!future.has(id)) return g;
    return { ...g, state: 'future', lastPeriod: null, startTimeUTC: future.get(id), away: { ...g.away, score: null }, home: { ...g.home, score: null } };
  },
};
let server, base;

before(async () => {
  server = createApp({ db: openDb(':memory:'), nhl, publicDir: join(root, 'public') });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

test('watchlist: adicionar, marcar nos jogos, ver sem placar e sair ao registrar', async () => {
  const eu = client();
  await eu('POST', '/api/signup', { username: 'quer_ver', password: 'senha-forte' });
  const games = (await eu('GET', '/api/schedule/2025-11-14')).body.games;
  const [jogado, outro, vaiAcontecer] = games;
  // começa daqui a 1,5 s (formato da API: sem milissegundos)
  const start = new Date(Date.now() + 1500).toISOString().replace(/\.\d+Z$/, 'Z');
  future.set(vaiAcontecer.id, start);

  assert.equal((await client()('POST', `/api/watchlist/${jogado.id}`)).status, 401);
  assert.equal((await eu('POST', '/api/watchlist/123')).status, 400);
  assert.equal((await eu('POST', '/api/watchlist/2025029999')).status, 404);

  for (const g of [jogado, outro, vaiAcontecer]) assert.equal((await eu('POST', `/api/watchlist/${g.id}`)).status, 200);
  assert.equal((await eu('POST', `/api/watchlist/${jogado.id}`)).body.count, 3, 'adicionar de novo não duplica');

  // marcações na agenda e na página do jogo
  const day = (await eu('GET', '/api/schedule/2025-11-14')).body.games;
  assert.deepEqual(day.filter((g) => g.inWatchlist).map((g) => g.id).sort(), [jogado.id, outro.id, vaiAcontecer.id].sort());
  assert.equal((await eu('GET', `/api/games/${outro.id}`)).body.inWatchlist, true);
  assert.equal((await client()('GET', `/api/games/${outro.id}`)).body.inWatchlist, false, 'visitante não tem watchlist');

  // lista pública, sem placar, com o jogo futuro separado
  const pub = (await client()('GET', '/api/users/quer_ver/watchlist')).body;
  assert.equal(pub.isMine, false);
  assert.equal(pub.items.length, 3);
  assert.ok(pub.items.every((i) => !('away_score' in i) && !('home_score' in i)), 'watchlist não mostra placar');
  assert.equal(pub.items.find((i) => i.game_id === vaiAcontecer.id).finished, false);
  assert.equal(pub.items.find((i) => i.game_id === vaiAcontecer.id).start_utc, start);
  const preview = (await eu('GET', '/api/users/quer_ver')).body.watchlist;
  assert.equal(preview.count, 3);
  assert.equal(preview.ready, 2);
  assert.equal(preview.next.game_id, vaiAcontecer.id, 'o próximo é o jogo que ainda vai acontecer');

  // jogo futuro não pode ser registrado, mas pode ficar na watchlist; quando acontece, a lista atualiza
  assert.equal((await eu('POST', '/api/logs', { gameId: vaiAcontecer.id })).status, 400);
  // o jogo acontece
  await new Promise((r) => setTimeout(r, 2100));
  future.delete(vaiAcontecer.id);
  const later = (await eu('GET', '/api/users/quer_ver/watchlist')).body;
  assert.equal(later.isMine, true);
  assert.equal(later.items.find((i) => i.game_id === vaiAcontecer.id).finished, true, 'retrato atualizado depois do jogo');

  // registrar tira da watchlist
  await eu('POST', '/api/logs', { gameId: jogado.id, rating: 8 });
  const after = (await eu('GET', '/api/users/quer_ver/watchlist')).body.items.map((i) => i.game_id);
  assert.ok(!after.includes(jogado.id));
  assert.equal(after.length, 2);

  assert.equal((await eu('DELETE', `/api/watchlist/${outro.id}`)).body.count, 1);
  assert.equal((await eu('GET', `/api/games/${outro.id}`)).body.inWatchlist, false);
});
