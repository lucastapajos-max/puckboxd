// Parte social: listas de jogos, seguir pessoas, curtir e comentar reviews.

import { HttpError, readJson, cleanText } from './http.js';

const GAME_RE = /^\d{10}$/;
const MAX_LIST_ITEMS = 200;

// Campos de jogo que o front usa em linhas compactas (feed, diário, listas).
const GAME_COLS = 'g.game_date, g.away_abbrev, g.home_abbrev, g.away_score, g.home_score, g.last_period';

export function createSocial({ db, nhl, route, currentUser, requireUser, snapshotGame, userByName }) {
  const inList = (ids) => ids.map(() => '?').join(',');

  const q = {
    // seguir
    follow: db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)'),
    unfollow: db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?'),
    isFollowing: db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?'),
    followCounts: db.prepare(
      `SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = ?1) AS followers,
              (SELECT COUNT(*) FROM follows WHERE follower_id = ?1) AS following`,
    ),
    followers: db.prepare(
      `SELECT u.username, u.fav_team, u.avatar_at FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = ? ORDER BY f.created_at DESC LIMIT 200`,
    ),
    following: db.prepare(
      `SELECT u.username, u.fav_team, u.avatar_at FROM follows f JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 200`,
    ),
    followingFeed: db.prepare(
      `SELECT l.id, l.game_id, l.watched_on, l.rating, l.review, l.liked, l.spoilers, l.rewatch, l.created_at, l.edited_at,
              l.mvp_name, l.mvp_team, u.username, u.fav_team, u.avatar_at, ${GAME_COLS}
       FROM logs l JOIN follows f ON f.followee_id = l.user_id AND f.follower_id = ?
       JOIN users u ON u.id = l.user_id JOIN games g ON g.id = l.game_id
       ORDER BY l.created_at DESC, l.id DESC LIMIT 50`,
    ),
    // Quem mais registra jogos e ainda não é seguido.
    suggestions: db.prepare(
      `SELECT u.username, u.fav_team, u.avatar_at, COUNT(l.id) AS logs
       FROM users u JOIN logs l ON l.user_id = u.id
       WHERE u.id <> ?1 AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?1)
       GROUP BY u.id ORDER BY logs DESC LIMIT 6`,
    ),

    // reviews
    logFull: db.prepare(
      `SELECT l.id, l.user_id, l.game_id, l.watched_on, l.rating, l.review, l.liked, l.spoilers, l.rewatch, l.how,
              l.created_at, l.edited_at, l.mvp_player_id, l.mvp_name, l.mvp_team, u.username, u.fav_team, u.avatar_at, ${GAME_COLS}
       FROM logs l JOIN users u ON u.id = l.user_id JOIN games g ON g.id = l.game_id WHERE l.id = ?`,
    ),
    logOwner: db.prepare('SELECT user_id FROM logs WHERE id = ?'),
    like: db.prepare('INSERT OR IGNORE INTO review_likes (user_id, log_id) VALUES (?, ?)'),
    unlike: db.prepare('DELETE FROM review_likes WHERE user_id = ? AND log_id = ?'),
    likeCount: db.prepare('SELECT COUNT(*) AS n FROM review_likes WHERE log_id = ?'),
    comments: db.prepare(
      `SELECT c.id, c.body, c.created_at, c.edited_at, c.user_id, u.username, u.fav_team, u.avatar_at FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.log_id = ? ORDER BY c.id LIMIT 500`,
    ),
    addComment: db.prepare('INSERT INTO comments (log_id, user_id, body) VALUES (?, ?, ?)'),
    commentById: db.prepare(
      'SELECT c.*, l.user_id AS log_owner FROM comments c JOIN logs l ON l.id = c.log_id WHERE c.id = ?',
    ),
    deleteComment: db.prepare('DELETE FROM comments WHERE id = ?'),
    editComment: db.prepare("UPDATE comments SET body = ?, edited_at = datetime('now') WHERE id = ?"),

    // notificações
    notify: db.prepare('INSERT INTO notifications (user_id, actor_id, type, log_id, comment_id) VALUES (?, ?, ?, ?, ?)'),
    unnotify: db.prepare('DELETE FROM notifications WHERE user_id = ? AND actor_id = ? AND type = ? AND log_id IS ?'),
    threadCommenters: db.prepare('SELECT DISTINCT user_id FROM comments WHERE log_id = ? AND user_id NOT IN (?, ?)'),
    notifications: db.prepare(
      `SELECT n.id, n.type, n.created_at, n.read_at, n.log_id, a.username AS actor, c.body AS comment,
              ow.username AS log_owner, l.game_id, ${GAME_COLS}
       FROM notifications n
       JOIN users a ON a.id = n.actor_id
       LEFT JOIN comments c ON c.id = n.comment_id
       LEFT JOIN logs l ON l.id = n.log_id
       LEFT JOIN users ow ON ow.id = l.user_id
       LEFT JOIN games g ON g.id = l.game_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`,
    ),
    unreadCount: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
    markRead: db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL"),

    // listas
    createList: db.prepare('INSERT INTO lists (user_id, title, description, ranked) VALUES (?, ?, ?, ?)'),
    updateList: db.prepare("UPDATE lists SET title = ?, description = ?, ranked = ?, updated_at = datetime('now') WHERE id = ?"),
    touchList: db.prepare("UPDATE lists SET updated_at = datetime('now') WHERE id = ?"),
    deleteList: db.prepare('DELETE FROM lists WHERE id = ?'),
    listById: db.prepare(
      `SELECT l.*, u.username FROM lists l JOIN users u ON u.id = l.user_id WHERE l.id = ?`,
    ),
    listItems: db.prepare(
      `SELECT i.game_id, i.position, i.note, ${GAME_COLS}
       FROM list_items i JOIN games g ON g.id = i.game_id WHERE i.list_id = ? ORDER BY i.position`,
    ),
    clearItems: db.prepare('DELETE FROM list_items WHERE list_id = ?'),
    insertItem: db.prepare('INSERT INTO list_items (list_id, game_id, position, note) VALUES (?, ?, ?, ?)'),
    hasItem: db.prepare('SELECT 1 FROM list_items WHERE list_id = ? AND game_id = ?'),
    itemCount: db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS last FROM list_items WHERE list_id = ?'),
    knownGame: db.prepare('SELECT 1 FROM games WHERE id = ?'),
    listsSummary: (where, params, limit) =>
      db
        .prepare(
          `SELECT l.id, l.title, l.description, l.ranked, l.updated_at, u.username,
                  (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS items
           FROM lists l JOIN users u ON u.id = l.user_id WHERE ${where}
           ORDER BY l.updated_at DESC, l.id DESC LIMIT ${limit}`,
        )
        .all(...params),
    previews: (ids) =>
      db
        .prepare(
          `SELECT i.list_id, g.away_abbrev, g.home_abbrev FROM list_items i JOIN games g ON g.id = i.game_id
           WHERE i.list_id IN (${inList(ids)}) AND i.position <= 4 ORDER BY i.list_id, i.position`,
        )
        .all(...ids),
  };

  // Contagem de curtidas/comentários e se quem está vendo curtiu, para qualquer lista de logs.
  function decorateLogs(rows, viewerId) {
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    const likes = new Map(
      db.prepare(`SELECT log_id, COUNT(*) AS n FROM review_likes WHERE log_id IN (${inList(ids)}) GROUP BY log_id`).all(...ids).map((r) => [r.log_id, r.n]),
    );
    const comments = new Map(
      db.prepare(`SELECT log_id, COUNT(*) AS n FROM comments WHERE log_id IN (${inList(ids)}) GROUP BY log_id`).all(...ids).map((r) => [r.log_id, r.n]),
    );
    const mine = viewerId
      ? new Set(db.prepare(`SELECT log_id FROM review_likes WHERE user_id = ? AND log_id IN (${inList(ids)})`).all(viewerId, ...ids).map((r) => r.log_id))
      : new Set();
    return rows.map((r) => ({ ...r, like_count: likes.get(r.id) ?? 0, comment_count: comments.get(r.id) ?? 0, liked_by_me: mine.has(r.id) }));
  }

  function withPreviews(lists) {
    if (!lists.length) return lists;
    const byList = new Map();
    for (const p of q.previews(lists.map((l) => l.id))) {
      if (!byList.has(p.list_id)) byList.set(p.list_id, []);
      byList.get(p.list_id).push([p.away_abbrev, p.home_abbrev]);
    }
    return lists.map((l) => ({ ...l, preview: byList.get(l.id) ?? [] }));
  }

  const userLists = (userId) => withPreviews(q.listsSummary('l.user_id = ?', [userId], 100));
  const recentLists = () => withPreviews(q.listsSummary('EXISTS (SELECT 1 FROM list_items i WHERE i.list_id = l.id)', [], 10));
  const listsWithGame = (gameId) =>
    withPreviews(q.listsSummary('EXISTS (SELECT 1 FROM list_items i WHERE i.list_id = l.id AND i.game_id = ?)', [gameId], 6));

  function followInfo(userId, viewerId) {
    return {
      ...q.followCounts.get(userId),
      is_following: Boolean(viewerId && viewerId !== userId && q.isFollowing.get(viewerId, userId)),
      follows_you: Boolean(viewerId && viewerId !== userId && q.isFollowing.get(userId, viewerId)),
    };
  }

  function findUser(username) {
    const user = userByName.get(username);
    if (!user) throw new HttpError(404, 'Usuário não encontrado');
    return user;
  }

  function findLog(id) {
    const owner = q.logOwner.get(Number(id));
    if (!owner) throw new HttpError(404, 'Review não encontrada');
    return owner;
  }

  function ownList(req, id) {
    const user = requireUser(req);
    const list = q.listById.get(Number(id));
    if (!list) throw new HttpError(404, 'Lista não encontrada');
    if (list.user_id !== user.id) throw new HttpError(403, 'Só quem criou a lista pode mudar ela');
    return list;
  }

  // Garante que o jogo existe na tabela games. Só entra em lista jogo que já começou.
  async function ensureGame(gameId) {
    const id = String(gameId ?? '');
    if (!GAME_RE.test(id)) throw new HttpError(400, 'Jogo inválido');
    if (q.knownGame.get(Number(id))) return Number(id);
    const game = await nhl.game(Number(id));
    if (game.state === 'future') throw new HttpError(400, 'Só dá para listar jogos que já começaram');
    snapshotGame(game);
    return game.id;
  }

  function listFields(body) {
    const title = cleanText(body.title, 100);
    if (!title) throw new HttpError(400, 'Dê um título para a lista');
    return { title, description: cleanText(body.description, 1000), ranked: body.ranked ? 1 : 0 };
  }

  // ---------- seguir ----------

  route('POST', /^\/api\/users\/([A-Za-z0-9_]+)\/follow$/, (req, _res, [username]) => {
    const me = requireUser(req);
    const target = findUser(username);
    if (target.id === me.id) throw new HttpError(400, 'Você não pode seguir a si mesmo');
    if (q.follow.run(me.id, target.id).changes) {
      // Um aviso por pessoa: seguir e desseguir várias vezes não empilha avisos.
      q.unnotify.run(target.id, me.id, 'follow', null);
      q.notify.run(target.id, me.id, 'follow', null, null);
    }
    return followInfo(target.id, me.id);
  });

  route('DELETE', /^\/api\/users\/([A-Za-z0-9_]+)\/follow$/, (req, _res, [username]) => {
    const me = requireUser(req);
    const target = findUser(username);
    if (q.unfollow.run(me.id, target.id).changes) q.unnotify.run(target.id, me.id, 'follow', null);
    return followInfo(target.id, me.id);
  });

  route('GET', /^\/api\/users\/([A-Za-z0-9_]+)\/network$/, (_req, _res, [username]) => {
    const user = findUser(username);
    return { username: user.username, followers: q.followers.all(user.id), following: q.following.all(user.id) };
  });

  route('GET', /^\/api\/following$/, (req) => {
    const me = requireUser(req);
    const { following } = q.followCounts.get(me.id);
    return {
      following,
      activity: decorateLogs(q.followingFeed.all(me.id), me.id),
      suggestions: q.suggestions.all(me.id),
    };
  });

  // ---------- reviews: página, curtidas, comentários ----------

  route('GET', /^\/api\/logs\/(\d+)$/, (req, _res, [id]) => {
    const log = q.logFull.get(Number(id));
    if (!log) throw new HttpError(404, 'Review não encontrada');
    const viewer = currentUser(req);
    return { log: decorateLogs([log], viewer?.id)[0], comments: q.comments.all(log.id) };
  });

  route('POST', /^\/api\/logs\/(\d+)\/like$/, (req, _res, [id]) => {
    const me = requireUser(req);
    const { user_id } = findLog(id);
    if (user_id === me.id) throw new HttpError(400, 'Não dá para curtir a própria review');
    if (q.like.run(me.id, Number(id)).changes) q.notify.run(user_id, me.id, 'like', Number(id), null);
    return { like_count: q.likeCount.get(Number(id)).n, liked_by_me: true };
  });

  route('DELETE', /^\/api\/logs\/(\d+)\/like$/, (req, _res, [id]) => {
    const me = requireUser(req);
    const { user_id } = findLog(id);
    if (q.unlike.run(me.id, Number(id)).changes) q.unnotify.run(user_id, me.id, 'like', Number(id));
    return { like_count: q.likeCount.get(Number(id)).n, liked_by_me: false };
  });

  route('POST', /^\/api\/logs\/(\d+)\/comments$/, async (req, _res, [id]) => {
    const me = requireUser(req);
    const { user_id: owner } = findLog(id);
    const body = cleanText((await readJson(req)).body, 1000);
    if (!body) throw new HttpError(400, 'Comentário vazio');
    const commentId = Number(q.addComment.run(Number(id), me.id, body).lastInsertRowid);
    // Avisa o dono da review e quem mais comentou nela (menos quem acabou de comentar).
    if (owner !== me.id) q.notify.run(owner, me.id, 'comment', Number(id), commentId);
    for (const { user_id } of q.threadCommenters.all(Number(id), me.id, owner)) {
      q.notify.run(user_id, me.id, 'reply', Number(id), commentId);
    }
    return { comments: q.comments.all(Number(id)) };
  });

  // Só quem escreveu edita (o dono da review pode apagar, mas não reescrever o texto dos outros).
  route('PUT', /^\/api\/comments\/(\d+)$/, async (req, _res, [id]) => {
    const me = requireUser(req);
    const c = q.commentById.get(Number(id));
    if (!c) throw new HttpError(404, 'Comentário não encontrado');
    if (c.user_id !== me.id) throw new HttpError(403, 'Só quem escreveu pode editar o comentário');
    const body = cleanText((await readJson(req)).body, 1000);
    if (!body) throw new HttpError(400, 'Comentário vazio');
    if (body !== c.body) q.editComment.run(body, c.id);
    return { comments: q.comments.all(c.log_id) };
  });

  route('DELETE', /^\/api\/comments\/(\d+)$/, (req, _res, [id]) => {
    const me = requireUser(req);
    const c = q.commentById.get(Number(id));
    if (!c) throw new HttpError(404, 'Comentário não encontrado');
    // Apaga quem escreveu ou o dono da review.
    if (c.user_id !== me.id && c.log_owner !== me.id) throw new HttpError(403, 'Você não pode apagar esse comentário');
    q.deleteComment.run(c.id);
    return { comments: q.comments.all(c.log_id) };
  });

  // ---------- listas ----------

  route('GET', /^\/api\/me\/lists$/, (req, _res, _m, url) => {
    const me = requireUser(req);
    const game = Number(url.searchParams.get('game')) || null;
    return {
      lists: userLists(me.id).map((l) => ({ ...l, has_game: game ? Boolean(q.hasItem.get(l.id, game)) : false })),
    };
  });

  route('POST', /^\/api\/lists$/, async (req) => {
    const me = requireUser(req);
    const body = await readJson(req);
    const { title, description, ranked } = listFields(body);
    const gameId = body.gameId != null ? await ensureGame(body.gameId) : null;
    const listId = Number(q.createList.run(me.id, title, description, ranked).lastInsertRowid);
    if (gameId) q.insertItem.run(listId, gameId, 1, null);
    return { list: q.listById.get(listId) };
  });

  route('GET', /^\/api\/lists\/(\d+)$/, (_req, _res, [id]) => {
    const list = q.listById.get(Number(id));
    if (!list) throw new HttpError(404, 'Lista não encontrada');
    return { list, items: q.listItems.all(list.id) };
  });

  // Salva a lista inteira: título, descrição, ordem e notas dos jogos.
  route('PUT', /^\/api\/lists\/(\d+)$/, async (req, _res, [id]) => {
    const list = ownList(req, id);
    const body = await readJson(req);
    const { title, description, ranked } = listFields(body);
    if (!Array.isArray(body.items)) throw new HttpError(400, 'Itens inválidos');
    if (body.items.length > MAX_LIST_ITEMS) throw new HttpError(400, `Uma lista pode ter até ${MAX_LIST_ITEMS} jogos`);
    const items = [];
    const seen = new Set();
    for (const it of body.items) {
      const gameId = await ensureGame(it?.gameId);
      if (seen.has(gameId)) throw new HttpError(400, 'Jogo repetido na lista');
      seen.add(gameId);
      items.push({ gameId, note: cleanText(it.note, 500) });
    }
    db.exec('BEGIN');
    try {
      q.updateList.run(title, description, ranked, list.id);
      q.clearItems.run(list.id);
      items.forEach((it, i) => q.insertItem.run(list.id, it.gameId, i + 1, it.note));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { list: q.listById.get(list.id), items: q.listItems.all(list.id) };
  });

  route('POST', /^\/api\/lists\/(\d+)\/items$/, async (req, _res, [id]) => {
    const list = ownList(req, id);
    const body = await readJson(req);
    const gameId = await ensureGame(body.gameId);
    if (q.hasItem.get(list.id, gameId)) throw new HttpError(409, 'Esse jogo já está na lista');
    const { n, last } = q.itemCount.get(list.id);
    if (n >= MAX_LIST_ITEMS) throw new HttpError(400, `Uma lista pode ter até ${MAX_LIST_ITEMS} jogos`);
    q.insertItem.run(list.id, gameId, last + 1, cleanText(body.note, 500));
    q.touchList.run(list.id);
    return { ok: true, items: n + 1 };
  });

  route('DELETE', /^\/api\/lists\/(\d+)$/, (req, _res, [id]) => {
    const list = ownList(req, id);
    q.deleteList.run(list.id);
    return { ok: true };
  });

  // ---------- notificações ----------

  route('GET', /^\/api\/notifications\/count$/, (req) => {
    const me = currentUser(req);
    return { unread: me ? q.unreadCount.get(me.id).n : 0 };
  });

  route('GET', /^\/api\/notifications$/, (req) => {
    const me = requireUser(req);
    return { items: q.notifications.all(me.id), unread: q.unreadCount.get(me.id).n };
  });

  route('POST', /^\/api\/notifications\/read$/, (req) => {
    const me = requireUser(req);
    q.markRead.run(me.id);
    return { unread: 0 };
  });

  return { decorateLogs, followInfo, userLists, recentLists, listsWithGame };
}
