// Watchlist ("quero ver"): jogos que a pessoa marcou para assistir depois.
// Aceita jogos que ainda não aconteceram. Quando a pessoa registra o jogo, ele sai da lista.

import { HttpError } from './http.js';

const GAME_RE = /^\d{10}$/;
const MAX_ITEMS = 500;
// Quantos jogos ainda sem resultado atualizar pela API da NHL a cada visita à watchlist.
const REFRESH_PER_VIEW = 25;

export function createWatchlist({ db, nhl, route, currentUser, requireUser, snapshotGame, userByName }) {
  const q = {
    add: db.prepare('INSERT OR IGNORE INTO watchlist (user_id, game_id) VALUES (?, ?)'),
    remove: db.prepare('DELETE FROM watchlist WHERE user_id = ? AND game_id = ?'),
    has: db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND game_id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?'),
    ids: db.prepare('SELECT game_id FROM watchlist WHERE user_id = ?'),
    // Jogos que já começaram mas ainda não têm resultado final no retrato.
    stale: db.prepare(
      `SELECT g.id FROM watchlist w JOIN games g ON g.id = w.game_id
       WHERE w.user_id = ? AND g.last_period IS NULL AND (g.start_utc IS NULL OR g.start_utc <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       LIMIT ${REFRESH_PER_VIEW}`,
    ),
    // Resumo para o perfil: o próximo jogo marcado e quantos já dá para assistir.
    next: db.prepare(
      `SELECT g.id AS game_id, g.game_date, g.start_utc, g.away_abbrev, g.home_abbrev
       FROM watchlist w JOIN games g ON g.id = w.game_id
       WHERE w.user_id = ? AND g.last_period IS NULL AND g.start_utc > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       ORDER BY g.start_utc LIMIT 1`,
    ),
    readyCount: db.prepare(
      `SELECT COUNT(*) AS n FROM watchlist w JOIN games g ON g.id = w.game_id
       WHERE w.user_id = ? AND (g.last_period IS NOT NULL OR g.start_utc IS NULL OR g.start_utc <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
    ),
    list: db.prepare(
      `SELECT g.id AS game_id, g.game_date, g.start_utc, g.away_abbrev, g.home_abbrev, g.last_period, g.venue, w.created_at
       FROM watchlist w JOIN games g ON g.id = w.game_id
       WHERE w.user_id = ? ORDER BY COALESCE(g.start_utc, g.game_date), g.id`,
    ),
  };

  const count = (userId) => q.count.get(userId).n;
  const idsOf = (userId) => new Set(userId ? q.ids.all(userId).map((r) => r.game_id) : []);
  const has = (userId, gameId) => Boolean(userId && q.has.get(userId, gameId));
  const removeGame = (userId, gameId) => q.remove.run(userId, gameId);

  route('POST', /^\/api\/watchlist\/(\d+)$/, async (req, _res, [id]) => {
    const me = requireUser(req);
    if (!GAME_RE.test(id)) throw new HttpError(400, 'Jogo inválido');
    if (count(me.id) >= MAX_ITEMS) throw new HttpError(400, `A watchlist aceita até ${MAX_ITEMS} jogos`);
    snapshotGame(await nhl.game(Number(id))); // valida o jogo e guarda data, horário e times
    q.add.run(me.id, Number(id));
    return { inWatchlist: true, count: count(me.id) };
  });

  route('DELETE', /^\/api\/watchlist\/(\d+)$/, (req, _res, [id]) => {
    const me = requireUser(req);
    q.remove.run(me.id, Number(id));
    return { inWatchlist: false, count: count(me.id) };
  });

  // Pública, como no Letterboxd. Placar nunca vem aqui: são jogos que a pessoa ainda não viu.
  route('GET', /^\/api\/users\/([A-Za-z0-9_]+)\/watchlist$/, async (req, _res, [username]) => {
    const user = userByName.get(username);
    if (!user) throw new HttpError(404, 'Usuário não encontrado');
    // Atualiza os jogos que já começaram, para saber se já terminaram (e se foram adiados).
    await Promise.all(q.stale.all(user.id).map(async ({ id }) => {
      try { snapshotGame(await nhl.game(id)); } catch { /* API fora do ar: fica o retrato antigo */ }
    }));
    const viewer = currentUser(req);
    return {
      username: user.username,
      isMine: viewer?.id === user.id,
      items: q.list.all(user.id).map((g) => ({ ...g, finished: g.last_period !== null })),
    };
  });

  const preview = (userId) => ({ count: count(userId), next: q.next.get(userId) ?? null, ready: q.readyCount.get(userId).n });

  return { count, idsOf, has, removeGame, preview };
}
