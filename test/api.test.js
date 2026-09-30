import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../src/db.js';
import { createNhl } from '../src/nhl.js';
import { createApp } from '../src/app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let server, base;

before(async () => {
  server = createApp({ db: openDb(':memory:'), nhl: createNhl({ mock: true }), publicDir: join(root, 'public') });
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

const PAST_DAY = '2025-11-02';

test('agenda do dia traz jogos normalizados', async () => {
  const { status, body } = await client()('GET', `/api/schedule/${PAST_DAY}`);
  assert.equal(status, 200);
  assert.ok(body.games.length > 0);
  const g = body.games[0];
  assert.match(String(g.id), /^\d{10}$/);
  assert.equal(g.state, 'final');
  assert.equal(typeof g.away.abbrev, 'string');
  assert.equal(g.loggedByMe, false);
});

test('fluxo completo: cadastro, registro, review, perfil e feed', async () => {
  const api = client();
  assert.equal((await api('POST', '/api/logs', { gameId: '2025020001' })).status, 401);

  const signup = await api('POST', '/api/signup', { username: 'lucas', password: 'senha-forte' });
  assert.equal(signup.status, 200);
  assert.equal((await api('GET', '/api/me')).body.user.username, 'lucas');

  const { body: day } = await api('GET', `/api/schedule/${PAST_DAY}`);
  const game = day.games[0];

  const log = await api('POST', '/api/logs', {
    gameId: game.id, rating: 9, liked: true, review: 'Jogaço, prorrogação tensa', watchedOn: PAST_DAY, how: 'live',
  });
  assert.equal(log.status, 200, JSON.stringify(log.body));

  const { body: page } = await api('GET', `/api/games/${game.id}`);
  assert.equal(page.community.watchers, 1);
  assert.equal(page.community.histogram[9], 1);
  assert.equal(page.community.reviews[0].username, 'lucas');
  assert.equal(page.myLogs.length, 1);

  const { body: after } = await api('GET', `/api/schedule/${PAST_DAY}`);
  assert.equal(after.games.find((g) => g.id === game.id).loggedByMe, true);

  const { body: profile } = await api('GET', '/api/users/LUCAS');
  assert.equal(profile.stats.games, 1);
  assert.equal(profile.diary[0].away_abbrev, game.away.abbrev);

  const { body: feed } = await client()('GET', '/api/feed');
  assert.equal(feed.recent[0].username, 'lucas');
  assert.equal(feed.popular[0].game_id, game.id);

  const other = client();
  await other('POST', '/api/signup', { username: 'intruso', password: 'outra-senha' });
  assert.equal((await other('DELETE', `/api/logs/${log.body.log.id}`)).status, 404);
  assert.equal((await api('DELETE', `/api/logs/${log.body.log.id}`)).status, 200);
});

test('validações', async () => {
  const api = client();
  assert.equal((await api('POST', '/api/signup', { username: 'x', password: '12345678' })).status, 400);
  assert.equal((await api('POST', '/api/signup', { username: 'curta', password: '123' })).status, 400);
  await api('POST', '/api/signup', { username: 'valida', password: '12345678' });
  assert.equal((await client()('POST', '/api/signup', { username: 'VALIDA', password: '12345678' })).status, 409);
  assert.equal((await client()('POST', '/api/login', { username: 'valida', password: 'errada00' })).status, 401);

  const { body: day } = await api('GET', `/api/schedule/${PAST_DAY}`);
  const id = day.games[0].id;
  assert.equal((await api('POST', '/api/logs', { gameId: id, rating: 11 })).status, 400);
  assert.equal((await api('POST', '/api/logs', { gameId: id, rating: 2.5 })).status, 400);
  assert.equal((await api('POST', '/api/logs', { gameId: id, watchedOn: '2020-01-01' })).status, 400);
  assert.equal((await api('POST', '/api/logs', { gameId: id, how: 'sonho' })).status, 400);

  const { body: future } = await api('GET', '/api/schedule/2026-04-10');
  if (future.games[0]?.state === 'future') {
    assert.equal((await api('POST', '/api/logs', { gameId: future.games[0].id })).status, 400);
  }
});

test('escrita sem JSON é recusada (CSRF)', async () => {
  const res = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(res.status, 415);
});

test('time e estáticos', async () => {
  const api = client();
  const { body } = await api('GET', '/api/teams/TOR');
  assert.ok(body.games.every((g) => g.away.abbrev === 'TOR' || g.home.abbrev === 'TOR'));
  assert.equal((await api('GET', '/api/teams/XXX')).status, 404);
  const res = await fetch(`${base}/../../etc/passwd`);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('escolha do espectador: voto, validação e rankings', async () => {
  const a = client();
  const b = client();
  await a('POST', '/api/signup', { username: 'fan_a', password: 'senha-forte' });
  await b('POST', '/api/signup', { username: 'fan_b', password: 'senha-forte' });

  const { body: day } = await a('GET', '/api/schedule/2025-11-10');
  const [g1, g2] = day.games;
  const { body: roster } = await a('GET', `/api/games/${g1.id}/players`);
  assert.equal(roster.away.abbrev, g1.away.abbrev);
  assert.ok(roster.home.players.length > 5);
  assert.ok(!roster.home.players.some((p) => p.position === 'G' && p.number === 16), 'goleiro que não entrou fica de fora');
  const star = roster.home.players[0];

  // jogador de outro jogo é recusado
  const { body: other } = await a('GET', `/api/games/${g2.id}/players`);
  const outsider = [...other.away.players, ...other.home.players].find(
    (p) => ![...roster.away.players, ...roster.home.players].some((q) => q.id === p.id),
  );
  assert.equal((await a('POST', '/api/logs', { gameId: g1.id, mvpPlayerId: outsider.id })).status, 400);

  assert.equal((await a('POST', '/api/logs', { gameId: g1.id, rating: 8, mvpPlayerId: star.id, review: 'monstro' })).status, 200);
  // registrar de novo não conta voto duplo
  assert.equal((await a('POST', '/api/logs', { gameId: g1.id, rewatch: true, mvpPlayerId: star.id })).status, 200);
  assert.equal((await b('POST', '/api/logs', { gameId: g1.id, mvpPlayerId: star.id })).status, 200);
  assert.equal((await a('POST', '/api/logs', { gameId: g2.id, mvpPlayerId: other.away.players[0].id })).status, 200);

  const { body: page } = await a('GET', `/api/games/${g1.id}`);
  assert.deepEqual(page.community.mvpVotes.map((v) => [v.id, v.votes]), [[star.id, 2]]);
  assert.equal(page.community.reviews[0].mvp_name, star.name);

  const { body: prof } = await a('GET', '/api/users/fan_a');
  assert.equal(prof.stats.mvps.length, 2);
  assert.equal(prof.stats.mvps.find((m) => m.id === star.id).games, 1);

  const { body: feed } = await a('GET', '/api/feed');
  assert.equal(feed.topMvps[0].id, star.id);
  assert.equal(feed.topMvps[0].votes, 2);
});
