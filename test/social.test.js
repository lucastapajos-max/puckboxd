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

async function user(name) {
  const c = client();
  const r = await c('POST', '/api/signup', { username: name, password: 'senha-forte' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

async function gamesOn(date) {
  return (await client()('GET', `/api/schedule/${date}`)).body.games;
}

test('seguir, deixar de seguir e feed de quem você segue', async () => {
  const ana = await user('ana');
  const beto = await user('beto');
  const [g] = await gamesOn('2025-11-05');
  await beto('POST', '/api/logs', { gameId: g.id, rating: 7, review: 'bom jogo' });

  const before = await ana('GET', '/api/following');
  assert.equal(before.body.following, 0);
  assert.deepEqual(before.body.activity, []);
  assert.ok(before.body.suggestions.some((s) => s.username === 'beto'));

  assert.equal((await ana('POST', '/api/users/ana/follow')).status, 400);
  assert.equal((await ana('POST', '/api/users/ninguem/follow')).status, 404);
  const f = await ana('POST', '/api/users/beto/follow');
  assert.equal(f.body.followers, 1);
  assert.equal(f.body.is_following, true);
  assert.equal((await ana('POST', '/api/users/beto/follow')).body.followers, 1, 'seguir duas vezes não duplica');

  const feed = await ana('GET', '/api/following');
  assert.equal(feed.body.activity.length, 1);
  assert.equal(feed.body.activity[0].username, 'beto');
  assert.ok(!feed.body.suggestions.some((s) => s.username === 'beto'));

  const profile = await ana('GET', '/api/users/beto');
  assert.equal(profile.body.user.is_following, true);
  assert.equal((await beto('GET', '/api/users/ana')).body.user.follows_you, true);
  assert.deepEqual((await client()('GET', '/api/users/beto/network')).body.followers.map((u) => u.username), ['ana']);

  await ana('DELETE', '/api/users/beto/follow');
  assert.equal((await ana('GET', '/api/following')).body.activity.length, 0);
  assert.equal((await client()('GET', '/api/following')).status, 401);
});

test('curtir e comentar reviews', async () => {
  const autor = await user('autor');
  const leitor = await user('leitor');
  const [g] = await gamesOn('2025-11-06');
  const { body } = await autor('POST', '/api/logs', { gameId: g.id, rating: 9, review: 'que jogo' });
  const logId = body.log.id;

  assert.equal((await autor('POST', `/api/logs/${logId}/like`)).status, 400, 'não curte a própria');
  assert.equal((await leitor('POST', `/api/logs/${logId}/like`)).body.like_count, 1);
  assert.equal((await leitor('POST', `/api/logs/${logId}/like`)).body.like_count, 1, 'curtir duas vezes não duplica');
  assert.equal((await client()('POST', `/api/logs/${logId}/like`)).status, 401);

  assert.equal((await leitor('POST', `/api/logs/${logId}/comments`, { body: '   ' })).status, 400);
  const c1 = await leitor('POST', `/api/logs/${logId}/comments`, { body: 'concordo demais' });
  assert.equal(c1.body.comments.length, 1);
  await autor('POST', `/api/logs/${logId}/comments`, { body: 'valeu!' });

  const page = await leitor('GET', `/api/logs/${logId}`);
  assert.equal(page.body.log.like_count, 1);
  assert.equal(page.body.log.liked_by_me, true);
  assert.equal(page.body.log.comment_count, 2);
  assert.deepEqual(page.body.comments.map((c) => c.username), ['leitor', 'autor']);

  const game = await leitor('GET', `/api/games/${g.id}`);
  assert.equal(game.body.community.reviews[0].like_count, 1);
  assert.equal(game.body.community.reviews[0].comment_count, 2);

  // o dono da review pode apagar comentário de outra pessoa; terceiros não
  const intruso = await user('intruso2');
  const leitorComment = c1.body.comments[0].id;
  assert.equal((await intruso('DELETE', `/api/comments/${leitorComment}`)).status, 403);
  assert.equal((await autor('DELETE', `/api/comments/${leitorComment}`)).body.comments.length, 1);

  await leitor('DELETE', `/api/logs/${logId}/like`);
  assert.equal((await leitor('GET', `/api/logs/${logId}`)).body.log.like_count, 0);

  // apagar a review leva junto curtidas e comentários
  await autor('DELETE', `/api/logs/${logId}`);
  assert.equal((await leitor('GET', `/api/logs/${logId}`)).status, 404);
});

test('listas: criar, adicionar, reordenar, permissões e apagar', async () => {
  const dona = await user('dona');
  const outra = await user('outra');
  const games = await gamesOn('2025-11-07');

  assert.equal((await dona('POST', '/api/lists', { title: '  ' })).status, 400);
  const created = await dona('POST', '/api/lists', { title: 'Melhores de novembro', description: 'só pancadaria', ranked: true, gameId: games[0].id });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.list.id;

  assert.equal((await dona('POST', `/api/lists/${id}/items`, { gameId: games[1].id, note: 'virada' })).status, 200);
  assert.equal((await dona('POST', `/api/lists/${id}/items`, { gameId: games[1].id })).status, 409);
  assert.equal((await outra('POST', `/api/lists/${id}/items`, { gameId: games[2].id })).status, 403);
  assert.equal((await dona('POST', `/api/lists/${id}/items`, { gameId: '2025029999' })).status, 404, 'jogo inexistente não entra');

  let list = (await client()('GET', `/api/lists/${id}`)).body;
  assert.equal(list.list.username, 'dona');
  assert.equal(list.list.ranked, 1);
  assert.deepEqual(list.items.map((i) => i.game_id), [games[0].id, games[1].id]);
  assert.equal(list.items[1].note, 'virada');

  // reordena, troca nota, adiciona um novo e salva tudo de uma vez
  const saved = await dona('PUT', `/api/lists/${id}`, {
    title: 'Melhores de novembro (revisada)',
    ranked: true,
    items: [{ gameId: games[2].id }, { gameId: games[1].id, note: 'virada histórica' }, { gameId: games[0].id }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.items.map((i) => [i.game_id, i.position]), [[games[2].id, 1], [games[1].id, 2], [games[0].id, 3]]);
  assert.equal(saved.body.list.description, null);

  assert.equal((await dona('PUT', `/api/lists/${id}`, { title: 'x', items: [{ gameId: games[0].id }, { gameId: games[0].id }] })).status, 400);
  assert.equal((await outra('PUT', `/api/lists/${id}`, { title: 'hack', items: [] })).status, 403);

  const mine = (await dona('GET', `/api/me/lists?game=${games[1].id}`)).body.lists;
  assert.equal(mine[0].has_game, true);
  assert.equal(mine[0].items, 3);
  assert.equal(mine[0].preview.length, 3);

  assert.equal((await client()('GET', `/api/games/${games[1].id}`)).body.community.lists[0].id, id);
  assert.equal((await client()('GET', '/api/users/dona')).body.lists[0].id, id);
  assert.ok((await client()('GET', '/api/feed')).body.recentLists.some((l) => l.id === id));

  assert.equal((await outra('DELETE', `/api/lists/${id}`)).status, 403);
  assert.equal((await dona('DELETE', `/api/lists/${id}`)).status, 200);
  assert.equal((await client()('GET', `/api/lists/${id}`)).status, 404);
});

test('jogo que ainda não começou não entra em lista', async () => {
  const mock = createNhl({ mock: true });
  const nhl = { ...mock, game: async (id) => ({ ...(await mock.game(id)), state: 'future' }) };
  const app = createApp({ db: openDb(':memory:'), nhl, publicDir: join(root, 'public') });
  await new Promise((r) => app.listen(0, r));
  const url = `http://localhost:${app.address().port}`;
  const signup = await fetch(`${url}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"username":"futuro","password":"senha-forte"}' });
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${url}/api/lists`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Quero ver', gameId: 2025020001 }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /já começaram/);
  app.close();
});
