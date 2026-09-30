import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createNhl } from '../src/nhl.js';
import { createApp } from '../src/app.js';
import { createBackups } from '../src/backup.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, error() {} };

test('backup diário: grava uma cópia legível, uma por dia, e guarda só as últimas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-bkp-'));
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (username, pass_hash, salt) VALUES ('ana', 'x', 'y')").run();
  const b = createBackups({ db, dir, keep: 3, log: quiet });

  const first = b.daily();
  assert.ok(first);
  assert.equal(new DatabaseSync(first).prepare('SELECT username FROM users').get().username, 'ana');
  assert.equal(b.daily(), null, 'segunda chamada no mesmo dia não grava de novo');

  // simula cópias antigas e confere a limpeza
  for (let i = 1; i <= 4; i++) {
    const f = join(dir, `puckboxd-2026-01-0${i}-0000.db`);
    writeFileSync(f, '');
    const t = (Date.now() - (10 + i) * 86400e3) / 1000;
    utimesSync(f, t, t);
  }
  const old = join(dir, readdirSync(dir).find((f) => f === `puckboxd-${b.stamp()}.db`) ?? '');
  const t = (Date.now() - 2 * 86400e3) / 1000;
  utimesSync(old, t, t); // "ontem": a próxima chamada grava de novo
  assert.ok(b.daily());
  assert.equal(b.list().length, 3);
});

test('download do backup: só administrador logado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-bkp-'));
  const db = openDb(':memory:');
  const app = createApp({
    db, nhl: createNhl({ mock: true }), publicDir: join(root, 'public'),
    backups: createBackups({ db, dir, log: quiet }), admins: ['Chefe'],
  });
  await new Promise((r) => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;
  const signup = async (username) => {
    const res = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'senha-forte' }) });
    return res.headers.get('set-cookie').split(';')[0];
  };
  const chefe = await signup('chefe');
  const comum = await signup('comum');

  assert.equal((await fetch(`${base}/api/admin/backup`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/backup`, { headers: { cookie: comum } })).status, 403);
  assert.equal((await (await fetch(`${base}/api/me`, { headers: { cookie: chefe } })).json()).user.is_admin, true, 'maiúsculas não importam');
  assert.equal((await (await fetch(`${base}/api/me`, { headers: { cookie: comum } })).json()).user.is_admin, false);

  const res = await fetch(`${base}/api/admin/backup`, { headers: { cookie: chefe } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="puckboxd-.*\.db"/);
  const file = join(dir, 'baixado.db');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const names = new DatabaseSync(file).prepare('SELECT username FROM users ORDER BY username').all().map((r) => r.username);
  assert.deepEqual(names, ['chefe', 'comum']);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!readdirSync(dir).some((f) => f.startsWith('download-')), 'cópia temporária apagada');
  app.close();
});
