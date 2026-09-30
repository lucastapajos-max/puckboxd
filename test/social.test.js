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

test('notificações: seguir, curtir, comentar, responder, ler e desfazer', async () => {
  const dono = await user('dono_n');
  const fa = await user('fa_n');
  const outro = await user('outro_n');
  const [g] = await gamesOn('2025-11-08');
  const logId = (await dono('POST', '/api/logs', { gameId: g.id, rating: 8, review: 'jogão' })).body.log.id;
  const count = async (c) => (await c('GET', '/api/notifications/count')).body.unread;

  assert.equal(await count(client()), 0, 'visitante sem login recebe 0');
  assert.equal((await client()('GET', '/api/notifications')).status, 401);

  // seguir, desseguir e seguir de novo gera um aviso só
  await fa('POST', '/api/users/dono_n/follow');
  await fa('DELETE', '/api/users/dono_n/follow');
  assert.equal(await count(dono), 0, 'desseguir apaga o aviso');
  await fa('POST', '/api/users/dono_n/follow');
  await fa('POST', '/api/users/dono_n/follow');
  assert.equal(await count(dono), 1);

  await fa('POST', `/api/logs/${logId}/like`);
  await fa('POST', `/api/logs/${logId}/like`);
  assert.equal(await count(dono), 2, 'curtir de novo não duplica');

  await fa('POST', `/api/logs/${logId}/comments`, { body: 'concordo' });
  assert.equal(await count(dono), 3);
  // dono responde: quem comentou recebe "reply"; o dono não recebe aviso de si mesmo
  await dono('POST', `/api/logs/${logId}/comments`, { body: 'valeu' });
  assert.equal(await count(dono), 3);
  // um terceiro comenta: dono recebe "comment" e o fã recebe "reply"
  await outro('POST', `/api/logs/${logId}/comments`, { body: 'discordo' });
  assert.equal(await count(dono), 4);

  const faList = (await fa('GET', '/api/notifications')).body.items;
  assert.deepEqual(faList.map((n) => [n.type, n.actor]), [['reply', 'outro_n'], ['reply', 'dono_n']]);
  assert.equal(faList[0].log_owner, 'dono_n');
  assert.equal(faList[0].comment, 'discordo');

  const { items } = (await dono('GET', '/api/notifications')).body;
  assert.deepEqual(items.map((n) => n.type), ['comment', 'comment', 'like', 'follow']);
  assert.equal(items[2].game_id, g.id);

  // descurtir apaga o aviso de curtida; apagar comentário apaga o aviso dele
  await fa('DELETE', `/api/logs/${logId}/like`);
  const outroComment = (await dono('GET', `/api/logs/${logId}`)).body.comments.find((c) => c.username === 'outro_n');
  await outro('DELETE', `/api/comments/${outroComment.id}`);
  assert.deepEqual((await dono('GET', '/api/notifications')).body.items.map((n) => n.type), ['comment', 'follow']);

  await dono('POST', '/api/notifications/read');
  assert.equal(await count(dono), 0);
  assert.equal((await dono('GET', '/api/notifications')).body.items.length, 2, 'lidas continuam na lista');
});

test('editar o próprio comentário', async () => {
  const autora = await user('autora_e');
  const comentarista = await user('coment_e');
  const [g] = await gamesOn('2025-11-09');
  const logId = (await autora('POST', '/api/logs', { gameId: g.id, review: 'ok' })).body.log.id;
  const { comments } = (await comentarista('POST', `/api/logs/${logId}/comments`, { body: 'jgo bom' })).body;
  const id = comments[0].id;
  assert.equal(comments[0].edited_at, null);

  assert.equal((await autora('PUT', `/api/comments/${id}`, { body: 'hackeado' })).status, 403, 'dono da review não reescreve');
  assert.equal((await client()('PUT', `/api/comments/${id}`, { body: 'x' })).status, 401);
  assert.equal((await comentarista('PUT', `/api/comments/${id}`, { body: '  ' })).status, 400);
  assert.equal((await comentarista('PUT', '/api/comments/999999', { body: 'x' })).status, 404);

  const edited = await comentarista('PUT', `/api/comments/${id}`, { body: 'jogo bom, e o goleiro fechou tudo' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.comments[0].body, 'jogo bom, e o goleiro fechou tudo');
  assert.ok(edited.body.comments[0].edited_at);

  // o aviso da autora mostra o texto novo
  const n = (await autora('GET', '/api/notifications')).body.items.find((x) => x.type === 'comment');
  assert.equal(n.comment, 'jogo bom, e o goleiro fechou tudo');
});

test('editar o próprio registro mantém curtidas e comentários', async () => {
  const dona = await user('dona_r');
  const fa = await user('fa_r');
  const [g] = await gamesOn('2025-11-10');
  const log = (await dona('POST', '/api/logs', { gameId: g.id, rating: 5, review: 'jgo ok', watchedOn: '2025-11-10' })).body.log;
  await fa('POST', `/api/logs/${log.id}/like`);
  await fa('POST', `/api/logs/${log.id}/comments`, { body: 'discordo' });
  const { away } = (await dona('GET', `/api/games/${g.id}/players`)).body;

  assert.equal((await fa('PUT', `/api/logs/${log.id}`, { rating: 1 })).status, 404, 'só a dona edita');
  assert.equal((await dona('PUT', `/api/logs/${log.id}`, { rating: 11 })).status, 400);
  assert.equal((await dona('PUT', `/api/logs/${log.id}`, { watchedOn: '2020-01-01' })).status, 400);

  const res = await dona('PUT', `/api/logs/${log.id}`, {
    rating: 9, review: 'Jogo ótimo, revi e mudei de ideia', liked: true, how: 'replay', watchedOn: '2025-11-11', mvpPlayerId: away.players[0].id,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.log.rating, 9);
  assert.equal(res.body.log.game_id, g.id);
  assert.equal(res.body.log.mvp_player_id, away.players[0].id);
  assert.ok(res.body.log.edited_at);

  const page = (await fa('GET', `/api/logs/${log.id}`)).body;
  assert.equal(page.log.review, 'Jogo ótimo, revi e mudei de ideia');
  assert.equal(page.log.like_count, 1);
  assert.equal(page.log.comment_count, 1);
  assert.ok(page.log.edited_at);

  // tirar a escolha do espectador também funciona
  const cleared = await dona('PUT', `/api/logs/${log.id}`, { rating: 9, mvpPlayerId: null });
  assert.equal(cleared.body.log.mvp_player_id, null);
  assert.equal(cleared.body.log.review, null, 'campos não enviados voltam ao padrão, igual ao formulário');
});
