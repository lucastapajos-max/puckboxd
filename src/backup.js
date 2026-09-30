// Backups do banco.
// - Automático: uma cópia por dia em `dir` (no Railway, /data/backups), guardando as últimas `keep`.
// - Sob demanda: `snapshot()` gera uma cópia atual para download.
// VACUUM INTO copia o banco em uso de forma consistente, sem parar o app.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 24 * 3600e3;
const PREFIX = 'puckboxd-';

const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace('T', '-').replace(':', ''); // 2026-09-30-1745

export function createBackups({ db, dir, keep = 7, log = console }) {
  mkdirSync(dir, { recursive: true });

  function copyTo(file) {
    if (existsSync(file)) unlinkSync(file); // VACUUM INTO não sobrescreve (duas cópias no mesmo minuto)
    db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    return file;
  }

  const listDaily = () =>
    readdirSync(dir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
      .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

  function daily() {
    const latest = listDaily()[0];
    if (latest && Date.now() - latest.mtime < DAY - 3600e3) return null; // já tem uma de hoje
    const file = copyTo(join(dir, `${PREFIX}${stamp()}.db`));
    for (const old of listDaily().slice(keep)) unlinkSync(old.file);
    log.log?.(`Backup diário salvo em ${file}`);
    return file;
  }

  // Cópia temporária para download; quem chama apaga depois de enviar.
  const snapshot = () => copyTo(join(dir, `download-${stamp()}-${process.pid}-${Date.now()}.db`));

  function start() {
    // Sobras de download interrompido (ex.: o app caiu no meio).
    for (const f of readdirSync(dir)) if (f.startsWith('download-')) unlinkSync(join(dir, f));
    const run = () => {
      try { daily(); } catch (err) { log.error?.('Backup diário falhou:', err); }
    };
    run();
    setInterval(run, 3 * 3600e3).unref(); // confere a cada 3 h; só grava se a última tiver mais de ~1 dia
  }

  return { daily, snapshot, start, list: listDaily, stamp };
}
