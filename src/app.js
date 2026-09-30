// Servidor HTTP sem dependências: estáticos + API própria + proxy da NHL.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { NhlError } from './nhl.js';
import { isTeam } from './teams.js';
import { HttpError, readJson } from './http.js';
import { createSocial } from './social.js';
import { createWatchlist } from './watchlist.js';
import { createSearch } from './search.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GAME_RE = /^\d{10}$/;
const USER_RE = /^[a-z0-9_]{3,20}$/i;
const SESSION_DAYS = 30;

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}


const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: https://assets.nhle.com",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

// Limite simples em memória: `max` requisições por janela, por IP e por rota.
function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

export function createApp({ db, nhl, publicDir, secureCookies = false, trustProxy = false, authLimit = { max: 20, windowMs: 15 * 60e3 } }) {
  const authAllowed = rateLimiter(authLimit);
  // Atrás do proxy do Railway, o IP real vem no primeiro item do X-Forwarded-For.
  const clientIp = (req) =>
    (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress;
  const guardAuth = (req) => {
    if (!authAllowed(`${clientIp(req)} ${req.url}`)) throw new HttpError(429, 'Muitas tentativas. Espere alguns minutos e tente de novo.');
  };

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, fav_team, bio, avatar_at, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (username, pass_hash, salt) VALUES (?, ?, ?)'),
    updateProfile: db.prepare('UPDATE users SET fav_team = ?, bio = ? WHERE id = ?'),
    saveAvatar: db.prepare('INSERT INTO avatars (user_id, mime, data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data'),
    touchAvatar: db.prepare("UPDATE users SET avatar_at = strftime('%Y%m%d%H%M%f', 'now') WHERE id = ?"),
    deleteAvatar: db.prepare('DELETE FROM avatars WHERE user_id = ?'),
    clearAvatar: db.prepare('UPDATE users SET avatar_at = NULL WHERE id = ?'),
    avatarOf: db.prepare('SELECT mime, data FROM avatars WHERE user_id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
    sessionUser: db.prepare(
      `SELECT u.id, u.username, u.fav_team, u.bio, u.avatar_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', '-${SESSION_DAYS} days')`,
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    upsertGame: db.prepare(
      `INSERT INTO games (id, game_date, season, game_type, away_abbrev, home_abbrev, away_score, home_score, last_period, venue, start_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET game_date = excluded.game_date, away_score = excluded.away_score, home_score = excluded.home_score,
         last_period = excluded.last_period, start_utc = COALESCE(excluded.start_utc, start_utc), updated_at = datetime('now')`,
    ),
    insertLog: db.prepare(
      `INSERT INTO logs (user_id, game_id, watched_on, rating, review, liked, spoilers, rewatch, how,
                         mvp_player_id, mvp_name, mvp_team, mvp_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    logById: db.prepare('SELECT * FROM logs WHERE id = ?'),
    updateLog: db.prepare(
      `UPDATE logs SET watched_on = ?, rating = ?, review = ?, liked = ?, spoilers = ?, rewatch = ?, how = ?,
                       mvp_player_id = ?, mvp_name = ?, mvp_team = ?, mvp_position = ?, edited_at = datetime('now')
       WHERE id = ?`,
    ),
    deleteLog: db.prepare('DELETE FROM logs WHERE id = ? AND user_id = ?'),
    gameStats: db.prepare(
      `SELECT COUNT(*) AS logs, COUNT(DISTINCT user_id) AS watchers, SUM(liked) AS likes,
              AVG(rating) AS avg, COUNT(rating) AS rated
       FROM logs WHERE game_id = ?`,
    ),
    gameHistogram: db.prepare('SELECT rating, COUNT(*) AS n FROM logs WHERE game_id = ? AND rating IS NOT NULL GROUP BY rating'),
    gameReviews: db.prepare(
      `SELECT l.id, l.watched_on, l.rating, l.review, l.liked, l.spoilers, l.rewatch, l.how, l.created_at, l.edited_at, l.mvp_name, l.mvp_team, u.username, u.fav_team, u.avatar_at
       FROM logs l JOIN users u ON u.id = l.user_id
       WHERE l.game_id = ? AND l.review IS NOT NULL AND l.review <> ''
       ORDER BY l.created_at DESC LIMIT 50`,
    ),
    myLogsForGame: db.prepare('SELECT * FROM logs WHERE game_id = ? AND user_id = ? ORDER BY watched_on DESC, id DESC'),
    loggedGameIds: db.prepare('SELECT DISTINCT game_id FROM logs WHERE user_id = ?'),
    diary: db.prepare(
      `SELECT l.*, g.game_date, g.away_abbrev, g.home_abbrev, g.away_score, g.home_score, g.last_period
       FROM logs l JOIN games g ON g.id = l.game_id
       WHERE l.user_id = ? ORDER BY l.watched_on DESC, l.id DESC LIMIT ? OFFSET ?`,
    ),
    userStats: db.prepare(
      `SELECT COUNT(*) AS logs, COUNT(DISTINCT game_id) AS games, AVG(rating) AS avg,
              SUM(review IS NOT NULL AND review <> '') AS reviews, SUM(liked) AS likes,
              SUM(watched_on >= strftime('%Y-01-01', 'now')) AS this_year
       FROM logs WHERE user_id = ?`,
    ),
    userRatingHistogram: db.prepare('SELECT rating, COUNT(*) AS n FROM logs WHERE user_id = ? AND rating IS NOT NULL GROUP BY rating'),
    userTopTeams: db.prepare(
      `SELECT team, COUNT(*) AS n FROM (
         SELECT g.away_abbrev AS team FROM logs l JOIN games g ON g.id = l.game_id WHERE l.user_id = ?1
         UNION ALL
         SELECT g.home_abbrev FROM logs l JOIN games g ON g.id = l.game_id WHERE l.user_id = ?1
       ) GROUP BY team ORDER BY n DESC LIMIT 5`,
    ),
    feed: db.prepare(
      `SELECT l.id, l.game_id, l.watched_on, l.rating, l.review, l.liked, l.spoilers, l.rewatch, l.created_at, l.edited_at, l.mvp_name, l.mvp_team, u.username, u.fav_team, u.avatar_at,
              g.game_date, g.away_abbrev, g.home_abbrev, g.away_score, g.home_score, g.last_period
       FROM logs l JOIN users u ON u.id = l.user_id JOIN games g ON g.id = l.game_id
       ORDER BY l.created_at DESC, l.id DESC LIMIT 30`,
    ),
    popular: db.prepare(
      `SELECT g.id AS game_id, g.game_date, g.away_abbrev, g.home_abbrev, g.away_score, g.home_score, g.last_period,
              COUNT(*) AS logs, AVG(l.rating) AS avg, SUM(l.liked) AS likes
       FROM logs l JOIN games g ON g.id = l.game_id
       WHERE l.created_at >= datetime('now', ?)
       GROUP BY g.id ORDER BY logs DESC, avg DESC LIMIT 12`,
    ),
    topRated: db.prepare(
      `SELECT g.id AS game_id, g.game_date, g.away_abbrev, g.home_abbrev, g.away_score, g.home_score, g.last_period,
              COUNT(l.rating) AS rated, AVG(l.rating) AS avg
       FROM logs l JOIN games g ON g.id = l.game_id
       GROUP BY g.id HAVING rated >= ? ORDER BY avg DESC, rated DESC LIMIT 12`,
    ),
    // Escolha do espectador. Cada pessoa vale um voto por jogo, mesmo que tenha registrado o jogo mais de uma vez.
    gameMvpVotes: db.prepare(
      `SELECT mvp_player_id AS id, MAX(mvp_name) AS name, MAX(mvp_team) AS team, MAX(mvp_position) AS position,
              COUNT(DISTINCT user_id) AS votes
       FROM logs WHERE game_id = ? AND mvp_player_id IS NOT NULL
       GROUP BY mvp_player_id ORDER BY votes DESC, name LIMIT 10`,
    ),
    userMvps: db.prepare(
      `SELECT mvp_player_id AS id, MAX(mvp_name) AS name, MAX(mvp_team) AS team, MAX(mvp_position) AS position,
              COUNT(DISTINCT game_id) AS games
       FROM logs WHERE user_id = ? AND mvp_player_id IS NOT NULL
       GROUP BY mvp_player_id ORDER BY games DESC, name LIMIT 10`,
    ),
    topMvps: db.prepare(
      `SELECT mvp_player_id AS id, MAX(mvp_name) AS name, MAX(mvp_team) AS team, MAX(mvp_position) AS position,
              COUNT(DISTINCT user_id || '-' || game_id) AS votes, COUNT(DISTINCT user_id) AS voters
       FROM logs WHERE mvp_player_id IS NOT NULL
       GROUP BY mvp_player_id ORDER BY votes DESC, voters DESC LIMIT 10`,
    ),
    gameAverages: (ids) =>
      db
        .prepare(`SELECT game_id, AVG(rating) AS avg, COUNT(*) AS logs FROM logs WHERE game_id IN (${ids.map(() => '?').join(',')}) GROUP BY game_id`)
        .all(...ids),
  };

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie).session;
    return token ? q.sessionUser.get(token) ?? null : null;
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Faça login para continuar');
    return user;
  }

  function startSession(res, userId) {
    const token = randomBytes(32).toString('hex');
    q.insertSession.run(token, userId);
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secureCookies ? '; Secure' : ''}`;
    res.setHeader('set-cookie', `session=${token}; ${flags}`);
  }

  // Adiciona média da comunidade a uma lista de jogos normalizados.
  function withCommunity(games) {
    if (!games.length) return games;
    const byId = new Map(q.gameAverages(games.map((g) => g.id)).map((r) => [r.game_id, r]));
    return games.map((g) => ({ ...g, community: byId.get(g.id) ?? { avg: null, logs: 0 } }));
  }

  // Guarda o retrato do jogo (times, placar, data). Diário, listas e feed leem daqui.
  function snapshotGame(game) {
    q.upsertGame.run(
      game.id, game.date, game.season, game.gameType, game.away.abbrev, game.home.abbrev,
      game.away.score, game.home.score, game.state === 'final' ? game.lastPeriod : null, game.venue, game.startTimeUTC,
    );
  }

  // ---------- rotas ----------

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const social = createSocial({ db, nhl, route, currentUser, requireUser, snapshotGame, userByName: q.userByName });
  const watchlist = createWatchlist({ db, nhl, route, currentUser, requireUser, snapshotGame, userByName: q.userByName });

  // Média da comunidade e marcações de quem está vendo (assistido, watchlist) numa lista de jogos.
  function decorateGames(games, user) {
    const logged = user ? new Set(q.loggedGameIds.all(user.id).map((r) => r.game_id)) : new Set();
    const watching = watchlist.idsOf(user?.id);
    return withCommunity(games).map((g) => ({ ...g, loggedByMe: logged.has(g.id), inWatchlist: watching.has(g.id) }));
  }
  createSearch({ db, nhl, route, currentUser, decorateGames });

  route('GET', /^\/api\/me$/, (req) => ({ user: currentUser(req) }));

  route('POST', /^\/api\/signup$/, async (req, res) => {
    guardAuth(req);
    const { username = '', password = '' } = await readJson(req);
    if (!USER_RE.test(username)) throw new HttpError(400, 'Usuário deve ter 3 a 20 caracteres: letras, números ou _');
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Senha precisa de pelo menos 8 caracteres');
    if (q.userByName.get(username)) throw new HttpError(409, 'Esse nome de usuário já existe');
    const salt = randomBytes(16).toString('hex');
    const { lastInsertRowid } = q.insertUser.run(username, hashPassword(password, salt), salt);
    startSession(res, Number(lastInsertRowid));
    return { user: q.userById.get(lastInsertRowid) };
  });

  route('POST', /^\/api\/login$/, async (req, res) => {
    guardAuth(req);
    const { username = '', password = '' } = await readJson(req);
    const user = typeof username === 'string' ? q.userByName.get(username) : null;
    const ok =
      user &&
      typeof password === 'string' &&
      timingSafeEqual(Buffer.from(hashPassword(password, user.salt), 'hex'), Buffer.from(user.pass_hash, 'hex'));
    if (!ok) throw new HttpError(401, 'Usuário ou senha incorretos');
    startSession(res, user.id);
    return { user: q.userById.get(user.id) };
  });

  route('POST', /^\/api\/logout$/, (req, res) => {
    const token = parseCookies(req.headers.cookie).session;
    if (token) q.deleteSession.run(token);
    res.setHeader('set-cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  route('PUT', /^\/api\/me$/, async (req) => {
    const user = requireUser(req);
    const { favTeam = null, bio = '' } = await readJson(req);
    if (favTeam !== null && !isTeam(favTeam)) throw new HttpError(400, 'Time inválido');
    q.updateProfile.run(favTeam, String(bio).slice(0, 280) || null, user.id);
    return { user: q.userById.get(user.id) };
  });

  // --- foto de perfil ---

  // O navegador já manda a foto reduzida (256×256), então 300 KB sobra.
  const AVATAR_MAX = 300 * 1024;
  // Tipo real pelo começo do arquivo, sem confiar no que o cliente diz. SVG fica de fora (pode ter script).
  function sniffImage(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  }

  route('PUT', /^\/api\/me\/avatar$/, async (req) => {
    const user = requireUser(req);
    const { image } = await readJson(req, 450 * 1024);
    const m = typeof image === 'string' && image.match(/^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new HttpError(400, 'Imagem inválida');
    const data = Buffer.from(m[1], 'base64');
    if (data.length > AVATAR_MAX) throw new HttpError(413, 'Imagem grande demais');
    const mime = sniffImage(data);
    if (!mime) throw new HttpError(400, 'Use uma imagem JPG, PNG ou WebP');
    q.saveAvatar.run(user.id, mime, data);
    q.touchAvatar.run(user.id);
    return { user: q.userById.get(user.id) };
  });

  route('DELETE', /^\/api\/me\/avatar$/, (req) => {
    const user = requireUser(req);
    q.deleteAvatar.run(user.id);
    q.clearAvatar.run(user.id);
    return { user: q.userById.get(user.id) };
  });

  route('GET', /^\/api\/users\/([A-Za-z0-9_]+)\/avatar$/, (_req, res, [username]) => {
    const user = q.userByName.get(username);
    const avatar = user && q.avatarOf.get(user.id);
    if (!avatar) throw new HttpError(404, 'Sem foto');
    // A URL leva ?v=<avatar_at>; foto nova muda a URL, então dá para guardar em cache à vontade.
    res.writeHead(200, {
      'content-type': avatar.mime,
      'content-length': avatar.data.length,
      'cache-control': 'public, max-age=31536000, immutable',
    });
    res.end(Buffer.from(avatar.data));
  });

  // --- NHL ---

  route('GET', /^\/api\/schedule\/(\d{4}-\d{2}-\d{2})$/, async (req, _res, [date]) => {
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'Data inválida');
    const data = await nhl.schedule(date);
    const user = currentUser(req);
    return { ...data, games: decorateGames(data.games, user) };
  });

  route('GET', /^\/api\/teams\/([A-Z]{3})$/, async (req, _res, [abbrev]) => {
    if (!isTeam(abbrev)) throw new HttpError(404, 'Time não encontrado');
    const data = await nhl.teamSeason(abbrev);
    const user = currentUser(req);
    return { ...data, games: decorateGames(data.games, user) };
  });

  route('GET', /^\/api\/games\/(\d{10})$/, async (req, _res, [id]) => {
    const game = await nhl.game(Number(id));
    const user = currentUser(req);
    const stats = q.gameStats.get(game.id);
    return {
      game,
      community: {
        ...stats,
        histogram: Object.fromEntries(q.gameHistogram.all(game.id).map((r) => [r.rating, r.n])),
        reviews: social.decorateLogs(q.gameReviews.all(game.id), user?.id),
        lists: social.listsWithGame(game.id),
        mvpVotes: q.gameMvpVotes.all(game.id),
      },
      myLogs: user ? q.myLogsForGame.all(game.id, user.id) : [],
      inWatchlist: watchlist.has(user?.id, game.id),
    };
  });

  route('GET', /^\/api\/games\/(\d{10})\/players$/, async (_req, _res, [id]) => nhl.players(Number(id)));

  // --- diário ---

  // Valida os campos de um registro (usado ao criar e ao editar). O jogo vem da API, nunca do cliente.
  async function readLogFields(body, gameId) {
    const rating = body.rating == null ? null : Number(body.rating);
    if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 10)) {
      throw new HttpError(400, 'Nota deve ir de 1 a 10 (meias estrelas)');
    }
    const watchedOn = body.watchedOn ?? new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(watchedOn)) throw new HttpError(400, 'Data em que assistiu é inválida');
    const how = body.how ?? null;
    if (how !== null && !['live', 'tv', 'replay', 'arena'].includes(how)) throw new HttpError(400, 'Forma de assistir inválida');
    const review = typeof body.review === 'string' ? body.review.trim().slice(0, 5000) : '';

    const game = await nhl.game(Number(gameId));
    if (game.state === 'future') throw new HttpError(400, 'Esse jogo ainda não começou');
    if (watchedOn < game.date) throw new HttpError(400, 'A data em que assistiu não pode ser antes do jogo');

    // Escolha do espectador: tem que ser alguém que jogou a partida.
    let mvp = null;
    if (body.mvpPlayerId != null && body.mvpPlayerId !== '') {
      const { away, home } = await nhl.players(game.id);
      mvp = [...away.players, ...home.players].find((p) => p.id === Number(body.mvpPlayerId));
      if (!mvp) throw new HttpError(400, 'Esse jogador não participou do jogo');
    }
    const fields = [
      watchedOn, rating, review || null,
      body.liked ? 1 : 0, body.spoilers ? 1 : 0, body.rewatch ? 1 : 0, how,
      mvp?.id ?? null, mvp?.name ?? null, mvp?.team ?? null, mvp?.position ?? null,
    ];
    return { game, fields };
  }

  route('POST', /^\/api\/logs$/, async (req) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const gameId = String(body.gameId ?? '');
    if (!GAME_RE.test(gameId)) throw new HttpError(400, 'Jogo inválido');
    const { game, fields } = await readLogFields(body, gameId);
    snapshotGame(game);
    const { lastInsertRowid } = q.insertLog.run(user.id, game.id, ...fields);
    watchlist.removeGame(user.id, game.id); // viu o jogo: sai do "quero ver"

    return { log: q.logById.get(lastInsertRowid) };
  });

  // Edita um registro seu. O jogo não muda; curtidas e comentários ficam.
  route('PUT', /^\/api\/logs\/(\d+)$/, async (req, _res, [id]) => {
    const user = requireUser(req);
    const log = q.logById.get(Number(id));
    if (!log || log.user_id !== user.id) throw new HttpError(404, 'Registro não encontrado');
    const { fields } = await readLogFields(await readJson(req), log.game_id);
    q.updateLog.run(...fields, log.id);
    return { log: q.logById.get(log.id) };
  });

  route('DELETE', /^\/api\/logs\/(\d+)$/, (req, _res, [id]) => {
    const user = requireUser(req);
    const { changes } = q.deleteLog.run(Number(id), user.id);
    if (!changes) throw new HttpError(404, 'Registro não encontrado');
    return { ok: true };
  });

  route('GET', /^\/api\/users\/([A-Za-z0-9_]+)$/, (req, _res, [username], url) => {
    const user = q.userByName.get(username);
    if (!user) throw new HttpError(404, 'Usuário não encontrado');
    const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
    return {
      user: { ...q.userById.get(user.id), ...social.followInfo(user.id, currentUser(req)?.id) },
      lists: social.userLists(user.id),
      watchlist: watchlist.preview(user.id),
      stats: {
        ...q.userStats.get(user.id),
        histogram: Object.fromEntries(q.userRatingHistogram.all(user.id).map((r) => [r.rating, r.n])),
        topTeams: q.userTopTeams.all(user.id),
        mvps: q.userMvps.all(user.id),
      },
      diary: q.diary.all(user.id, 50, page * 50),
    };
  });

  route('GET', /^\/api\/feed$/, (req) => ({
    recent: social.decorateLogs(q.feed.all(), currentUser(req)?.id),
    recentLists: social.recentLists(),
    popular: q.popular.all('-7 days'),
    topRated: q.topRated.all(2),
    topMvps: q.topMvps.all(),
  }));

  // ---------- servidor ----------

  // `no-cache` + ETag: o navegador pode guardar o arquivo, mas confere a cada visita se mudou.
  // Sem isso, depois de um deploy ele continua rodando o app.js antigo.
  function sendFile(req, res, file, body) {
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  }

  async function serveStatic(req, pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(publicDir)) throw new HttpError(403, 'Proibido');
    let body;
    try {
      body = await readFile(file);
    } catch {
      // SPA: qualquer rota desconhecida cai no index
      return sendFile(req, res, 'index.html', await readFile(join(publicDir, 'index.html')));
    }
    sendFile(req, res, file, body);
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      if (url.pathname.startsWith('/api/')) {
        // CSRF: escrita só com JSON (formulários de outro site não conseguem mandar esse content-type sem preflight)
        if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          throw new HttpError(415, 'Use application/json');
        }
        for (const r of routes) {
          const m = r.method === req.method && url.pathname.match(r.pattern);
          if (m) {
            const data = await r.handler(req, res, m.slice(1), url);
            if (res.writableEnded) return; // a rota já respondeu (ex.: imagem)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(data));
            return;
          }
        }
        throw new HttpError(404, 'Rota não encontrada');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido');
      await serveStatic(req, url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof NhlError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Erro interno' : err.message }));
    }
  });
}
