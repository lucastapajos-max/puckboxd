// Servidor HTTP sem dependências: estáticos + API própria + proxy da NHL.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { NhlError } from './nhl.js';
import { isTeam } from './teams.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new HttpError(413, 'Corpo da requisição grande demais');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

export function createApp({ db, nhl, publicDir, secureCookies = false }) {
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, fav_team, bio, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (username, pass_hash, salt) VALUES (?, ?, ?)'),
    updateProfile: db.prepare('UPDATE users SET fav_team = ?, bio = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)'),
    sessionUser: db.prepare(
      `SELECT u.id, u.username, u.fav_team, u.bio FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', '-${SESSION_DAYS} days')`,
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    upsertGame: db.prepare(
      `INSERT INTO games (id, game_date, season, game_type, away_abbrev, home_abbrev, away_score, home_score, last_period, venue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET away_score = excluded.away_score, home_score = excluded.home_score,
         last_period = excluded.last_period, updated_at = datetime('now')`,
    ),
    insertLog: db.prepare(
      `INSERT INTO logs (user_id, game_id, watched_on, rating, review, liked, spoilers, rewatch, how)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    logById: db.prepare('SELECT * FROM logs WHERE id = ?'),
    deleteLog: db.prepare('DELETE FROM logs WHERE id = ? AND user_id = ?'),
    gameStats: db.prepare(
      `SELECT COUNT(*) AS logs, COUNT(DISTINCT user_id) AS watchers, SUM(liked) AS likes,
              AVG(rating) AS avg, COUNT(rating) AS rated
       FROM logs WHERE game_id = ?`,
    ),
    gameHistogram: db.prepare('SELECT rating, COUNT(*) AS n FROM logs WHERE game_id = ? AND rating IS NOT NULL GROUP BY rating'),
    gameReviews: db.prepare(
      `SELECT l.id, l.watched_on, l.rating, l.review, l.liked, l.spoilers, l.rewatch, l.how, l.created_at, u.username
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
      `SELECT l.id, l.game_id, l.watched_on, l.rating, l.review, l.liked, l.spoilers, l.rewatch, l.created_at, u.username,
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

  // ---------- rotas ----------

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/me$/, (req) => ({ user: currentUser(req) }));

  route('POST', /^\/api\/signup$/, async (req, res) => {
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

  // --- NHL ---

  route('GET', /^\/api\/schedule\/(\d{4}-\d{2}-\d{2})$/, async (req, _res, [date]) => {
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'Data inválida');
    const data = await nhl.schedule(date);
    const user = currentUser(req);
    const logged = user ? new Set(q.loggedGameIds.all(user.id).map((r) => r.game_id)) : new Set();
    return { ...data, games: withCommunity(data.games).map((g) => ({ ...g, loggedByMe: logged.has(g.id) })) };
  });

  route('GET', /^\/api\/teams\/([A-Z]{3})$/, async (req, _res, [abbrev]) => {
    if (!isTeam(abbrev)) throw new HttpError(404, 'Time não encontrado');
    const data = await nhl.teamSeason(abbrev);
    const user = currentUser(req);
    const logged = user ? new Set(q.loggedGameIds.all(user.id).map((r) => r.game_id)) : new Set();
    return { ...data, games: withCommunity(data.games).map((g) => ({ ...g, loggedByMe: logged.has(g.id) })) };
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
        reviews: q.gameReviews.all(game.id),
      },
      myLogs: user ? q.myLogsForGame.all(game.id, user.id) : [],
    };
  });

  // --- diário ---

  route('POST', /^\/api\/logs$/, async (req) => {
    const user = requireUser(req);
    const body = await readJson(req);
    const gameId = String(body.gameId ?? '');
    if (!GAME_RE.test(gameId)) throw new HttpError(400, 'Jogo inválido');

    const rating = body.rating == null ? null : Number(body.rating);
    if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 10)) {
      throw new HttpError(400, 'Nota deve ir de 1 a 10 (meias estrelas)');
    }
    const watchedOn = body.watchedOn ?? new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(watchedOn)) throw new HttpError(400, 'Data em que assistiu é inválida');
    const how = body.how ?? null;
    if (how !== null && !['live', 'tv', 'replay', 'arena'].includes(how)) throw new HttpError(400, 'Forma de assistir inválida');
    const review = typeof body.review === 'string' ? body.review.trim().slice(0, 5000) : '';

    // O retrato do jogo vem da API, nunca do cliente.
    const game = await nhl.game(Number(gameId));
    if (game.state === 'future') throw new HttpError(400, 'Esse jogo ainda não começou');
    if (watchedOn < game.date) throw new HttpError(400, 'A data em que assistiu não pode ser antes do jogo');

    q.upsertGame.run(
      game.id, game.date, game.season, game.gameType, game.away.abbrev, game.home.abbrev,
      game.away.score, game.home.score, game.state === 'final' ? game.lastPeriod : null, game.venue,
    );
    const { lastInsertRowid } = q.insertLog.run(
      user.id, game.id, watchedOn, rating, review || null,
      body.liked ? 1 : 0, body.spoilers ? 1 : 0, body.rewatch ? 1 : 0, how,
    );
    return { log: q.logById.get(lastInsertRowid) };
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
      user: q.userById.get(user.id),
      stats: {
        ...q.userStats.get(user.id),
        histogram: Object.fromEntries(q.userRatingHistogram.all(user.id).map((r) => [r.rating, r.n])),
        topTeams: q.userTopTeams.all(user.id),
      },
      diary: q.diary.all(user.id, 50, page * 50),
    };
  });

  route('GET', /^\/api\/feed$/, () => ({
    recent: q.feed.all(),
    popular: q.popular.all('-7 days'),
    topRated: q.topRated.all(2),
  }));

  // ---------- servidor ----------

  async function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = normalize(join(publicDir, rel));
    if (!file.startsWith(publicDir)) throw new HttpError(403, 'Proibido');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      // SPA: qualquer rota desconhecida cai no index
      const body = await readFile(join(publicDir, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(body);
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
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
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(data));
            return;
          }
        }
        throw new HttpError(404, 'Rota não encontrada');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido');
      await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof NhlError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Erro interno' : err.message }));
    }
  });
}
