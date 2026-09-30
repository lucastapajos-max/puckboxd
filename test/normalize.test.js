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
