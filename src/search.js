// Busca única: pessoas, times, confrontos ("WSH x PIT") e listas.

import { TEAMS, findTeams, normalizeText } from './teams.js';

const MAX_QUERY = 80;

// Temporada no formato da NHL (20252026) a partir de uma data: começa em julho.
function seasonOf(date = new Date()) {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 6 ? y : y - 1;
  return start * 10000 + start + 1;
}

export function createSearch({ db, nhl, route, currentUser, decorateGames }) {
  const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const q = {
    users: db.prepare(
      `SELECT username, fav_team, avatar_at FROM users WHERE username LIKE ? ESCAPE '\\'
       ORDER BY (username LIKE ? ESCAPE '\\') DESC, length(username), username LIMIT 10`,
    ),
    lists: db.prepare(
      `SELECT l.id, l.title, l.ranked, l.updated_at, u.username,
              (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS items
       FROM lists l JOIN users u ON u.id = l.user_id
       WHERE l.title LIKE ? ESCAPE '\\' ORDER BY l.updated_at DESC LIMIT 10`,
    ),
  };

  // Jogos entre dois times na temporada atual e na anterior.
  async function matchup(a, b) {
    const now = await nhl.teamSeason(a);
    const current = now.games.find((g) => g.season)?.season ?? seasonOf();
    const previous = await nhl.teamSeasonFor(a, current - 10001).catch(() => ({ games: [] }));
    const seen = new Set();
    const games = [...now.games, ...previous.games].filter((g) => {
      const vs = (g.away.abbrev === a && g.home.abbrev === b) || (g.away.abbrev === b && g.home.abbrev === a);
      if (!vs || seen.has(g.id) || g.gameType === 1) return false; // sem pré-temporada
      seen.add(g.id);
      return true;
    });
    const played = games.filter((g) => g.state !== 'future').sort((x, y) => (x.date < y.date ? 1 : -1));
    const upcoming = games.filter((g) => g.state === 'future').sort((x, y) => (x.date < y.date ? -1 : 1));
    return { teams: [a, b], played, upcoming };
  }

  route('GET', /^\/api\/search$/, async (req, _res, _m, url) => {
    const raw = String(url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY);
    const empty = { q: raw, users: [], teams: [], lists: [], matchup: null };
    if (normalizeText(raw).length < 2) return empty;

    const viewer = currentUser(req);
    let teams = findTeams(raw);
    // "New York" são dois times: mostra os dois, sem confronto.
    if (!teams.length && / new york | ny /.test(` ${normalizeText(raw)} `)) teams = ['NYI', 'NYR'];

    const result = { ...empty, teams: teams.map((abbrev) => ({ abbrev, name: TEAMS[abbrev] })) };
    const isNewYork = teams.length === 2 && teams.includes('NYI') && teams.includes('NYR') && !findTeams(raw).length;
    if (teams.length >= 2 && !isNewYork) {
      try {
        const m = await matchup(teams[0], teams[1]);
        result.matchup = {
          teams: m.teams,
          played: decorateGames(m.played, viewer),
          upcoming: decorateGames(m.upcoming, viewer),
        };
      } catch {
        result.matchup = { teams: teams.slice(0, 2), played: [], upcoming: [], error: 'Não foi possível buscar os jogos agora' };
      }
    }

    // Pessoas: nome de usuário não tem espaço, então só busca quando o texto também não tem.
    const handle = raw.replace(/^@/, '');
    if (/^[A-Za-z0-9_]+$/.test(handle)) {
      const like = likeEscape(handle);
      result.users = q.users.all(`%${like}%`, `${like}%`);
    }
    result.lists = q.lists.all(`%${likeEscape(raw)}%`);
    return result;
  });
}
