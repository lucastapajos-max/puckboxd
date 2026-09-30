import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { createNhl } from './nhl.js';
import { createApp } from './app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;
const mock = process.env.NHL_MOCK === '1';
const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT);

// No Railway, o banco vai para o volume montado; sem volume, os dados somem a cada deploy.
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dbFile = process.env.DB_FILE || (volume ? join(volume, 'puckboxd.db') : join(root, 'data', 'puckboxd.db'));
if (onRailway && !volume && !process.env.DB_FILE) {
  console.warn('AVISO: nenhum volume montado. Os registros serão apagados no próximo deploy.');
}

const db = openDb(dbFile);
const nhl = createNhl({ mock });
const app = createApp({
  db,
  nhl,
  publicDir: join(root, 'public'),
  secureCookies: process.env.NODE_ENV === 'production' || onRailway,
  trustProxy: process.env.TRUST_PROXY === '1' || onRailway,
});

app.listen(port, () => {
  console.log(`Puckboxd em http://localhost:${port}${mock ? ' (dados mock da NHL)' : ''} · banco: ${dbFile}`);
});

// Deploys mandam SIGTERM: fecha o servidor e o banco antes de sair.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    app.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
