// Cliente da API pública da NHL (api-web.nhle.com), com cache em memória e
// normalização das respostas. A API não manda cabeçalhos CORS, então o
// navegador nunca fala com ela direto: tudo passa por aqui.
//
// Referência dos endpoints: https://github.com/Zmalski/NHL-API-Reference

import { TEAMS } from './teams.js';

const BASE = 'https://api-web.nhle.com/v1';

// Campos localizados vêm como { default: "...", fr: "..." }.
const t = (v) => (v && typeof v === 'object' ? v.default ?? '' : v ?? '');

function stateOf(gameState) {
  if (gameState === 'LIVE' || gameState === 'CRIT') return 'live';
  if (gameState === 'FINAL' || gameState === 'OFF') return 'final';
  return 'future'; // FUT, PRE, PPD (adiado)
}

function team(raw = {}) {
  const abbrev = raw.abbrev ?? '';
  return {
    abbrev,
    place: t(raw.placeName),
    name: t(raw.commonName) || t(raw.name) || TEAMS[abbrev] || abbrev,
    score: raw.score ?? null,
    sog: raw.sog ?? null,
    logo: raw.darkLogo || raw.logo || `https://assets.nhle.com/logos/nhl/svg/${abbrev}_dark.svg`,
  };
}

// `dayDate` vem do agrupamento da agenda: lá os jogos não trazem gameDate, e o
// dia em UTC erra jogos noturnos (19h ET já é o dia seguinte em UTC).
export function normalizeGame(g, dayDate = null) {
  return {
    id: g.id,
    season: g.season ?? null,
    gameType: g.gameType ?? null, // 1 pré-temporada, 2 temporada regular, 3 playoffs
    date: g.gameDate ?? dayDate ?? (g.startTimeUTC ? g.startTimeUTC.slice(0, 10) : null),
    startTimeUTC: g.startTimeUTC ?? null,
    state: stateOf(g.gameState),
    rawState: g.gameState ?? null,
    venue: t(g.venue),
    away: team(g.awayTeam),
    home: team(g.homeTeam),
    period: g.periodDescriptor?.number ?? null,
    lastPeriod: g.gameOutcome?.lastPeriodType ?? g.periodDescriptor?.periodType ?? null,
  };
}

function periodLabel(pd = {}) {
  if (pd.periodType === 'SO') return 'Shootout';
  if (pd.periodType === 'OT') return pd.number > 4 ? `${pd.number - 3}º OT` : 'Prorrogação';
  return `${pd.number}º período`;
}

function normalizeLanding(raw) {
  const game = normalizeGame(raw);
  const goals = [];
  for (const period of raw.summary?.scoring ?? []) {
    for (const g of period.goals ?? []) {
      goals.push({
        period: periodLabel(period.periodDescriptor),
        time: g.timeInPeriod ?? '',
        team: t(g.teamAbbrev),
        playerId: g.playerId ?? null,
        scorer: t(g.name) || `${t(g.firstName)} ${t(g.lastName)}`.trim(),
        headshot: g.headshot ?? null,
        assists: (g.assists ?? []).map((a) => t(a.name) || `${t(a.firstName)} ${t(a.lastName)}`.trim()),
        strength: g.strength ?? 'ev',
        awayScore: g.awayScore ?? null,
        homeScore: g.homeScore ?? null,
      });
    }
  }
  const stars = (raw.summary?.threeStars ?? []).map((s) => ({
    star: s.star,
    playerId: s.playerId ?? null,
    name: t(s.name),
    team: t(s.teamAbbrev),
    position: s.position ?? '',
    headshot: s.headshot ?? null,
  }));
  return { ...game, goals, stars };
}

// Quem entrou no gelo, a partir de /gamecenter/{id}/boxscore.
// Ordenado por pontos, com goleiros no fim de cada time.
export function normalizeBoxscore(raw) {
  const side = (key) => {
    const abbrev = raw[key]?.abbrev ?? '';
    const stats = raw.playerByGameStats?.[key] ?? {};
    const skaters = [...(stats.forwards ?? []), ...(stats.defense ?? [])].map((p) => ({
      id: p.playerId,
      name: t(p.name),
      team: abbrev,
      position: p.position ?? '',
      number: p.sweaterNumber ?? null,
      goals: p.goals ?? 0,
      assists: p.assists ?? 0,
    }));
    skaters.sort((a, b) => b.goals + b.assists - (a.goals + a.assists) || b.goals - a.goals);
    const goalies = (stats.goalies ?? [])
      .filter((p) => p.toi && p.toi !== '00:00')
      .map((p) => ({
        id: p.playerId,
        name: t(p.name),
        team: abbrev,
        position: 'G',
        number: p.sweaterNumber ?? null,
        saves: p.saves ?? null,
        shotsAgainst: p.shotsAgainst ?? null,
      }));
    return { abbrev, players: [...skaters, ...goalies].filter((p) => p.id && p.name) };
  };
  return { away: side('awayTeam'), home: side('homeTeam') };
}

// Se o boxscore falhar, monta a lista com quem aparece no resumo (gols e destaques).
function playersFromLanding(game) {
  const seen = new Map();
  const add = (id, name, team, position = '') => id && !seen.has(id) && seen.set(id, { id, name, team, position, number: null });
  game.goals.forEach((g) => add(g.playerId, g.scorer, g.team));
  game.stars.forEach((s) => add(s.playerId, s.name, s.team, s.position));
  const list = [...seen.values()];
  return {
    away: { abbrev: game.away.abbrev, players: list.filter((p) => p.team === game.away.abbrev) },
    home: { abbrev: game.home.abbrev, players: list.filter((p) => p.team === game.home.abbrev) },
  };
}

// ---------- cache ----------

const cache = new Map();
const MAX_ENTRIES = 500;

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await load();
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + ttlMs(value) });
  return value;
}

export class NhlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { 'user-agent': 'puckboxd/0.1', accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) throw new NhlError(404, 'Não encontrado na API da NHL');
  if (!res.ok) throw new NhlError(502, `API da NHL respondeu ${res.status}`);
  return res.json();
}

// Jogo encerrado não muda mais; o resto expira rápido.
const gameTtl = (g) => (g.state === 'final' ? 6 * 3600e3 : g.state === 'live' ? 20e3 : 5 * 60e3);

export function createNhl({ mock = false } = {}) {
  if (mock) return createMock();
  return {
    schedule: (date) =>
      cached(`schedule:${date}`, () => 60e3, async () => {
        const raw = await get(`/schedule/${date}`);
        const day = (raw.gameWeek ?? []).find((d) => d.date === date);
        return { date, games: (day?.games ?? []).map((g) => normalizeGame(g, date)) };
      }),
    game: (id) => cached(`game:${id}`, gameTtl, async () => normalizeLanding(await get(`/gamecenter/${id}/landing`))),
    players(id) {
      return cached(`players:${id}`, () => 3600e3, async () => {
        try {
          const box = normalizeBoxscore(await get(`/gamecenter/${id}/boxscore`));
          if (box.away.players.length + box.home.players.length > 0) return box;
        } catch (err) {
          if (err instanceof NhlError && err.status === 404) throw err;
        }
        return playersFromLanding(await this.game(id));
      });
    },
    teamSeason: (abbrev) =>
      cached(`team:${abbrev}`, () => 10 * 60e3, async () => {
        const raw = await get(`/club-schedule-season/${abbrev}/now`);
        return { abbrev, name: TEAMS[abbrev], games: (raw.games ?? []).map((g) => normalizeGame(g)) };
      }),
  };
}

// ---------- mock ----------
// Dados falsos e determinísticos, para rodar sem rede (NHL_MOCK=1).
// O id do jogo codifica data e confronto, então agenda e página do jogo batem.

function createMock() {
  const abbrevs = Object.keys(TEAMS);
  const SEASON_START = Date.UTC(2025, 9, 7); // 07/10/2025
  const PER_DAY = 6;
  // Vai até bem depois de hoje, para ter jogos futuros (watchlist, agenda) no modo mock.
  const DAYS = 450;
  const DAY = 86400e3;
  const names = ['Matthews', 'McDavid', 'MacKinnon', 'Kucherov', 'Pastrnak', 'Draisaitl', 'Makar', 'Hughes', 'Eichel', 'Tkachuk', 'Marner', 'Kaprizov'];

  const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  function build(n) {
    const day = Math.floor(n / PER_DAY);
    const slot = n % PER_DAY;
    const date = new Date(SEASON_START + day * DAY).toISOString().slice(0, 10);
    const r = rng(n + 7);
    const a = (day * 5 + slot * 2) % 32;
    const h = (a + 1 + slot + (day % 13)) % 32;
    const start = new Date(SEASON_START + day * DAY + (23 * 60 + (slot % 3) * 30) * 60e3);
    const now = Date.now();
    const gameState = start > now ? 'FUT' : now - start < 3 * 3600e3 ? 'LIVE' : 'OFF';
    const awayScore = Math.floor(r() * 6);
    let homeScore = Math.floor(r() * 6);
    const lastPeriodType = awayScore === homeScore ? (r() > 0.5 ? 'OT' : 'SO') : 'REG';
    if (awayScore === homeScore) homeScore += 1;
    const id = Number(`202502${String(n + 1).padStart(4, '0')}`);
    const mk = (ab, score) => ({
      abbrev: ab,
      commonName: { default: TEAMS[ab].split(' ').slice(-1)[0] },
      placeName: { default: TEAMS[ab].split(' ').slice(0, -1).join(' ') },
      score: gameState === 'FUT' ? undefined : score,
      sog: gameState === 'FUT' ? undefined : 20 + Math.floor(r() * 20),
    });
    const raw = {
      id,
      season: 20252026,
      gameType: 2,
      gameDate: date,
      startTimeUTC: start.toISOString(),
      gameState,
      venue: { default: `${TEAMS[abbrevs[h]]} Arena` },
      awayTeam: mk(abbrevs[a], awayScore),
      homeTeam: mk(abbrevs[h], homeScore),
      periodDescriptor: { number: lastPeriodType === 'REG' ? 3 : lastPeriodType === 'OT' ? 4 : 5, periodType: lastPeriodType },
      gameOutcome: gameState === 'OFF' ? { lastPeriodType } : undefined,
    };
    if (gameState !== 'FUT') {
      const scoring = [1, 2, 3].map((p) => ({ periodDescriptor: { number: p, periodType: 'REG' }, goals: [] }));
      const regHome = lastPeriodType === 'REG' ? homeScore : homeScore - 1;
      const order = [...Array(awayScore).fill(true), ...Array(regHome).fill(false)].sort(() => r() - 0.5);
      const total = order.length;
      let aw = 0, hm = 0;
      for (let i = 0; i < total; i++) {
        const isAway = order[i];
        isAway ? aw++ : hm++;
        scoring[Math.min(2, Math.floor((i / Math.max(total, 1)) * 3))].goals.push({
          timeInPeriod: `${String(Math.floor(r() * 20)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}`,
          teamAbbrev: { default: isAway ? abbrevs[a] : abbrevs[h] },
          name: { default: `J. ${names[Math.floor(r() * names.length)]}` },
          assists: [{ name: { default: `A. ${names[Math.floor(r() * names.length)]}` } }],
          strength: r() > 0.8 ? 'pp' : 'ev',
          awayScore: aw,
          homeScore: hm,
        });
      }
      if (lastPeriodType === 'OT') {
        scoring.push({ periodDescriptor: { number: 4, periodType: 'OT' }, goals: [{ timeInPeriod: '02:31', teamAbbrev: { default: abbrevs[h] }, name: { default: `J. ${names[n % names.length]}` }, assists: [], strength: 'ev', awayScore: aw, homeScore: hm + 1 }] });
      }
      raw.summary = {
        scoring,
        threeStars: [1, 2, 3].map((star) => ({ star, name: { default: `${names[(n + star) % names.length]}` }, teamAbbrev: star === 2 ? abbrevs[a] : abbrevs[h], position: 'C' })),
      };
    }
    return raw;
  }

  const numberOf = (id) => Number(String(id).slice(6)) - 1;
  const dayIndex = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - SEASON_START) / DAY);

  return {
    async schedule(date) {
      const d = dayIndex(date);
      if (d < 0 || d >= DAYS) return { date, games: [] };
      return { date, games: Array.from({ length: PER_DAY }, (_, s) => normalizeGame(build(d * PER_DAY + s))) };
    },
    async game(id) {
      const n = numberOf(id);
      if (!String(id).startsWith('202502') || n < 0 || n >= DAYS * PER_DAY) throw new NhlError(404, 'Jogo não encontrado');
      return normalizeLanding(build(n));
    },
    async players(id) {
      const g = await this.game(id);
      if (g.state === 'future') return { away: { abbrev: g.away.abbrev, players: [] }, home: { abbrev: g.home.abbrev, players: [] } };
      // Elenco falso fixo por time, no formato do boxscore real.
      const roster = (abbrev) => {
        const base = 8_000_000 + abbrevs.indexOf(abbrev) * 100;
        const p = (k, position) => ({ playerId: base + k, sweaterNumber: k + 2, name: { default: `${'ABCDEFGHJKLM'[k % 12]}. ${names[(k + abbrevs.indexOf(abbrev)) % names.length]}` }, position, goals: k % 4 === 0 ? 1 : 0, assists: k % 3 === 0 ? 1 : 0, toi: '15:00' });
        return {
          forwards: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => p(k, ['C', 'L', 'R'][k % 3])),
          defense: [9, 10, 11, 12].map((k) => p(k, 'D')),
          goalies: [{ ...p(13, 'G'), saves: 28, shotsAgainst: 30 }, { ...p(14, 'G'), toi: '00:00' }],
        };
      };
      return normalizeBoxscore({
        awayTeam: { abbrev: g.away.abbrev },
        homeTeam: { abbrev: g.home.abbrev },
        playerByGameStats: { awayTeam: roster(g.away.abbrev), homeTeam: roster(g.home.abbrev) },
      });
    },
    async teamSeason(abbrev) {
      const games = [];
      for (let n = 0; n < DAYS * PER_DAY; n++) {
        const g = build(n);
        if (g.awayTeam.abbrev === abbrev || g.homeTeam.abbrev === abbrev) games.push(normalizeGame(g));
      }
      return { abbrev, name: TEAMS[abbrev], games };
    },
  };
}
