import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { createNhl } from './nhl.js';
import { createApp } from './app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;
const mock = process.env.NHL_MOCK === '1';

const db = openDb(process.env.DB_FILE || join(root, 'data', 'puckboxd.db'));
const nhl = createNhl({ mock });
const app = createApp({
  db,
  nhl,
  publicDir: join(root, 'public'),
  secureCookies: process.env.NODE_ENV === 'production',
});

app.listen(port, () => {
  console.log(`Puckboxd em http://localhost:${port}${mock ? ' (dados mock da NHL)' : ''}`);
});
