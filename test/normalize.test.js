import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGame } from '../src/nhl.js';

// Formato de um jogo dentro de /v1/schedule/{date} (sem gameDate).
const scheduleGame = {
  id: 2025020123,
  season: 20252026,
  gameType: 2,
  venue: { default: 'Scotiabank Arena' },
  startTimeUTC: '2025-11-03T00:00:00Z',
  gameState: 'OFF',
  awayTeam: { id: 6, abbrev: 'BOS', placeName: { default: 'Boston' }, commonName: { default: 'Bruins' }, score: 2 },
  homeTeam: { id: 10, abbrev: 'TOR', placeName: { default: 'Toronto' }, commonName: { default: 'Maple Leafs' }, score: 3 },
  periodDescriptor: { number: 4, periodType: 'OT' },
  gameOutcome: { lastPeriodType: 'OT' },
};

test('jogo noturno fica no dia da agenda, não no dia UTC', () => {
  assert.equal(normalizeGame(scheduleGame, '2025-11-02').date, '2025-11-02');
  assert.equal(normalizeGame({ ...scheduleGame, gameDate: '2025-11-02' }).date, '2025-11-02');
});

test('campos localizados e estado', () => {
  const g = normalizeGame(scheduleGame, '2025-11-02');
  assert.equal(g.state, 'final');
  assert.equal(g.lastPeriod, 'OT');
  assert.equal(g.venue, 'Scotiabank Arena');
  assert.deepEqual([g.home.place, g.home.name, g.home.score], ['Toronto', 'Maple Leafs', 3]);
  assert.match(g.away.logo, /BOS_dark\.svg$/);
  assert.equal(normalizeGame({ ...scheduleGame, gameState: 'CRIT' }).state, 'live');
  assert.equal(normalizeGame({ ...scheduleGame, gameState: 'PPD' }).state, 'future');
});

test('boxscore vira lista de jogadores por time', async () => {
  const { normalizeBoxscore } = await import('../src/nhl.js');
  const box = normalizeBoxscore({
    awayTeam: { abbrev: 'FLA' },
    homeTeam: { abbrev: 'CAR' },
    playerByGameStats: {
      awayTeam: {
        forwards: [
          { playerId: 1, sweaterNumber: 16, name: { default: 'A. Barkov' }, position: 'C', goals: 0, assists: 1 },
          { playerId: 2, sweaterNumber: 19, name: { default: 'M. Tkachuk' }, position: 'L', goals: 0, assists: 0 },
        ],
        defense: [{ playerId: 3, sweaterNumber: 42, name: { default: 'G. Forsling' }, position: 'D', goals: 1, assists: 0 }],
        goalies: [
          { playerId: 4, sweaterNumber: 25, name: { default: 'J. Markstrom' }, position: 'G', toi: '64:55', saves: 30, shotsAgainst: 30 },
          { playerId: 5, sweaterNumber: 72, name: { default: 'S. Bobrovsky' }, position: 'G', toi: '00:00' },
        ],
      },
      homeTeam: {},
    },
  });
  assert.deepEqual(box.away.players.map((p) => p.name), ['G. Forsling', 'A. Barkov', 'M. Tkachuk', 'J. Markstrom']);
  assert.equal(box.away.players[0].team, 'FLA');
  assert.deepEqual(box.home, { abbrev: 'CAR', players: [] });
});

test('banco antigo ganha as colunas novas sem perder registros', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openDb } = await import('../src/db.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'pbx-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY, user_id INTEGER, game_id INTEGER, watched_on TEXT, rating INTEGER, review TEXT,
    liked INTEGER DEFAULT 0, spoilers INTEGER DEFAULT 0, rewatch INTEGER DEFAULT 0, how TEXT, created_at TEXT);
    INSERT INTO logs (user_id, game_id, watched_on, rating) VALUES (1, 2025010001, '2025-09-29', 5);`);
  old.close();
  const db = openDb(file);
  const row = db.prepare('SELECT rating, mvp_player_id FROM logs').get();
  assert.equal(row.rating, 5);
  assert.equal(row.mvp_player_id, null);
  openDb(file); // rodar de novo não quebra
});
