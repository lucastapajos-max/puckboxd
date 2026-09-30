// Puckboxd: SPA em JS puro com rotas por hash.

const $view = document.getElementById('view');
const $session = document.getElementById('session');
const $dialog = document.getElementById('log-dialog');
const $spoiler = document.getElementById('spoiler-free');

const TEAMS = {
  ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CGY: 'Calgary Flames',
  CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets',
  DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montréal Canadiens', NSH: 'Nashville Predators',
  NJD: 'New Jersey Devils', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SJS: 'San Jose Sharks', SEA: 'Seattle Kraken',
  STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth',
  VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WSH: 'Washington Capitals', WPG: 'Winnipeg Jets',
};
const HOW = { live: 'Ao vivo', tv: 'Na TV / streaming', replay: 'Reprise', arena: 'No ginásio' };

let me = null;

// ---------- utilidades ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const logoUrl = (abbrev) => `https://assets.nhle.com/logos/nhl/svg/${abbrev}_dark.svg`;
const logo = (abbrev, cls = '') => `<img class="logo ${cls}" src="${logoUrl(esc(abbrev))}" alt="${esc(abbrev)}" loading="lazy">`;
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
const shiftDate = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);
const fmtDate = (iso, opts = { day: '2-digit', month: 'short', year: 'numeric' }) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', ...opts });
const fmtTime = (utc) => new Date(utc).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const suffix = (p) => (p === 'OT' ? ' (OT)' : p === 'SO' ? ' (SO)' : '');

function stars(rating) {
  if (!rating) return '';
  return `<span class="stars" title="${rating / 2} de 5">${'★'.repeat(Math.floor(rating / 2))}${rating % 2 ? '½' : ''}</span>`;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { status: res.status });
  return data;
}

// ---------- modo sem spoiler ----------

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } },
};
let spoilerFree = store.get('spoilerFree', false);
const revealed = new Set(store.get('revealed', []));
$spoiler.checked = spoilerFree;
$spoiler.addEventListener('change', () => {
  spoilerFree = $spoiler.checked;
  store.set('spoilerFree', spoilerFree);
  render();
});
const canSee = (g) => !spoilerFree || g.loggedByMe || revealed.has(g.id);
function reveal(id) {
  revealed.add(id);
  store.set('revealed', [...revealed].slice(-500));
}

// ---------- componentes ----------

function gameCard(g) {
  const show = g.state !== 'future' && canSee(g);
  const awayWin = g.state === 'final' && g.away.score > g.home.score;
  const homeWin = g.state === 'final' && g.home.score > g.away.score;
  const score = (s) => (g.state === 'future' ? '' : show ? s : '<span class="hidden-score">•</span>');
  const status =
    g.state === 'live' ? '<span class="badge live">Ao vivo</span>'
    : g.state === 'final' ? `<span class="badge">Final${show ? suffix(g.lastPeriod) : ''}</span>`
    : `<span>${g.startTimeUTC ? fmtTime(g.startTimeUTC) : 'A definir'}</span>`;
  const community = g.community?.logs
    ? `<span>${g.community.avg ? stars(Math.round(g.community.avg)) : ''} ${g.community.logs} ${g.community.logs === 1 ? 'registro' : 'registros'}</span>`
    : '';
  return `
    <a class="game-card" href="#/jogo/${g.id}">
      <div class="row ${show && homeWin ? 'loser' : ''}">${logo(g.away.abbrev)}<span class="abbr">${esc(g.away.place || g.away.abbrev)} <span class="muted">${esc(g.away.name)}</span></span><span class="score">${score(g.away.score)}</span></div>
      <div class="row ${show && awayWin ? 'loser' : ''}">${logo(g.home.abbrev)}<span class="abbr">${esc(g.home.place || g.home.abbrev)} <span class="muted">${esc(g.home.name)}</span></span><span class="score">${score(g.home.score)}</span></div>
      <div class="meta">${status}${g.loggedByMe ? '<span class="badge mine">Assistido</span>' : community}</div>
    </a>`;
}

// Linha compacta para jogos vindos do banco (feed, perfil).
function gameLine(r, { showScore = true } = {}) {
  const score = showScore && r.away_score != null ? ` ${r.away_score}–${r.home_score}${suffix(r.last_period)}` : '';
  return `<a href="#/jogo/${r.game_id}">${logo(r.away_abbrev, 'sm')} ${esc(r.away_abbrev)} @ ${esc(r.home_abbrev)} ${logo(r.home_abbrev, 'sm')}${score}</a> <span class="muted">· ${fmtDate(r.game_date)}</span>`;
}

function reviewItem(r, { withGame = false } = {}) {
  const mine = me && me.username === r.username;
  // No feed, o placar só aparece se o próprio leitor já viu o jogo; aqui não sabemos, então segue o modo sem spoiler.
  const scoreOk = !spoilerFree || revealed.has(r.game_id) || mine;
  return `
    <article class="review">
      <header>
        <a href="#/u/${esc(r.username)}">${esc(r.username)}</a>
        ${stars(r.rating)} ${r.liked ? '<span style="color:var(--like)">♥</span>' : ''}
        ${r.rewatch ? '<span class="badge">Revisto</span>' : ''}
        <span class="muted small">assistiu em ${fmtDate(r.watched_on)}</span>
      </header>
      ${withGame ? `<div class="game-line">${gameLine(r, { showScore: scoreOk })}</div>` : ''}
      ${r.review ? `<p class="${r.spoilers && !mine ? 'spoiler' : ''}" ${r.spoilers && !mine ? 'title="Contém spoilers. Clique para ler."' : ''}>${esc(r.review)}</p>` : ''}
    </article>`;
}

function histogram(h, total) {
  const max = Math.max(1, ...Object.values(h));
  const bars = Array.from({ length: 10 }, (_, i) => {
    const n = h[i + 1] ?? 0;
    return `<span style="height:${(n / max) * 100}%" title="${(i + 1) / 2}★: ${n}"></span>`;
  }).join('');
  return `<div class="histo">${bars}</div><div class="histo-labels"><span>½★</span><span>${total} notas</span><span>★★★★★</span></div>`;
}

function bindSpoilers(root = $view) {
  root.querySelectorAll('.spoiler').forEach((el) => el.addEventListener('click', () => el.classList.add('shown')));
}

// ---------- sessão ----------

function renderSession() {
  $session.innerHTML = me
    ? `<a href="#/u/${esc(me.username)}">${esc(me.username)}</a> <button class="ghost" id="logout">Sair</button>`
    : `<a href="#/entrar" class="btn primary">Entrar</a>`;
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('POST', '/api/logout');
    me = null;
    renderSession();
    render();
  });
}

// ---------- telas ----------

async function viewSchedule(date) {
  $view.innerHTML = `
    <div class="date-nav">
      <h1>${date === todayISO() ? 'Hoje' : fmtDate(date, { weekday: 'long', day: '2-digit', month: 'long' })}</h1>
      <a class="btn ghost" href="#/dia/${shiftDate(date, -1)}">← Dia anterior</a>
      <input type="date" id="pick" value="${date}" aria-label="Escolher data">
      <a class="btn ghost" href="#/dia/${shiftDate(date, 1)}">Próximo dia →</a>
    </div>
    <div id="games" class="loading">Carregando jogos…</div>
    <h2>Times</h2>
    <div class="game-grid" style="grid-template-columns:repeat(auto-fill,minmax(64px,1fr))">
      ${Object.keys(TEAMS).map((a) => `<a href="#/time/${a}" title="${TEAMS[a]}" style="text-align:center">${logo(a)}<div class="small muted">${a}</div></a>`).join('')}
    </div>`;
  document.getElementById('pick').addEventListener('change', (e) => e.target.value && (location.hash = `#/dia/${e.target.value}`));
  const $games = document.getElementById('games');
  try {
    const { games } = await api('GET', `/api/schedule/${date}`);
    $games.className = games.length ? 'game-grid' : 'empty';
    $games.innerHTML = games.length ? games.map(gameCard).join('') : 'Nenhum jogo nesse dia.';
  } catch (e) {
    $games.className = 'empty';
    $games.textContent = e.message;
  }
}

async function viewGame(id) {
  $view.innerHTML = '<div class="loading">Carregando jogo…</div>';
  const { game: g, community: c, myLogs } = await api('GET', `/api/games/${id}`);
  g.loggedByMe = myLogs.length > 0;
  const show = g.state !== 'future' && canSee(g);
  const hidden = g.state !== 'future' && !show;

  const goalsHtml = () => {
    if (!g.goals.length) return '<p class="muted">Sem gols registrados.</p>';
    let last = '';
    return g.goals.map((goal) => {
      const head = goal.period !== last ? `<div class="period-title">${esc((last = goal.period))}</div>` : '';
      return `${head}<ul class="goal-list"><li>
        ${logo(goal.team, 'sm')}
        <span class="t">${esc(goal.time)}${goal.strength === 'pp' ? ' · PP' : goal.strength === 'sh' ? ' · SH' : ''}</span>
        <span class="who">${esc(goal.scorer)}<small>${goal.assists.length ? 'Assist.: ' + goal.assists.map(esc).join(', ') : 'Sem assistência'}</small></span>
        <span class="score">${goal.awayScore}–${goal.homeScore}</span>
      </li></ul>`;
    }).join('');
  };

  $view.innerHTML = `
    <section class="game-hero">
      <a href="#/time/${esc(g.away.abbrev)}">${logo(g.away.abbrev, 'lg')}<div class="team-name">${esc(g.away.place)} ${esc(g.away.name)}</div><div class="sub">Visitante</div></a>
      <div>
        <div class="big-score">${show ? `${g.away.score} – ${g.home.score}` : g.state === 'future' ? 'vs' : '? – ?'}</div>
        <div class="sub">${g.state === 'live' ? '<span class="badge live">Ao vivo</span>' : g.state === 'final' ? `Final${show ? suffix(g.lastPeriod) : ''}` : g.startTimeUTC ? fmtTime(g.startTimeUTC) : ''}</div>
        <div class="sub">${fmtDate(g.date, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })} · ${esc(g.venue)}</div>
        ${hidden ? '<button class="ghost reveal" id="reveal">Mostrar placar</button>' : ''}
      </div>
      <a href="#/time/${esc(g.home.abbrev)}">${logo(g.home.abbrev, 'lg')}<div class="team-name">${esc(g.home.place)} ${esc(g.home.name)}</div><div class="sub">Mandante</div></a>
    </section>

    <div class="layout-2">
      <div>
        <div class="actions">
          ${g.state === 'future' ? '<span class="muted">O jogo ainda não começou. Volte depois para registrar.</span>'
            : me ? `<button class="primary" id="log">${g.loggedByMe ? 'Registrar de novo' : '+ Registrar / avaliar'}</button>`
            : '<a class="btn primary" href="#/entrar">Entre para registrar este jogo</a>'}
        </div>

        ${myLogs.length ? `<h2>Seus registros</h2>${myLogs.map((l) => `
          <div class="review">
            <header>${stars(l.rating)} ${l.liked ? '<span style="color:var(--like)">♥</span>' : ''}
              <span class="muted small">${fmtDate(l.watched_on)}${l.how ? ' · ' + HOW[l.how] : ''}${l.rewatch ? ' · revisto' : ''}</span>
              <button class="danger small" data-del="${l.id}">Apagar</button></header>
            ${l.review ? `<p>${esc(l.review)}</p>` : ''}
          </div>`).join('')}` : ''}

        <h2>Reviews</h2>
        ${c.reviews.length ? c.reviews.map((r) => reviewItem(r)).join('') : '<p class="muted">Ninguém escreveu sobre este jogo ainda.</p>'}

        ${g.state !== 'future' ? `<h2>Gols</h2>${show ? goalsHtml() : '<p class="muted">Escondido no modo sem spoiler.</p>'}` : ''}
        ${show && g.stars.length ? `<h2>Três estrelas</h2><div class="stars-list">${g.stars.map((s) => `<div><span class="stars">${'★'.repeat(s.star)}</span> ${esc(s.name)} <span class="muted small">${esc(s.team)} · ${esc(s.position)}</span></div>`).join('')}</div>` : ''}
      </div>
      <aside>
        <h2>Comunidade</h2>
        ${c.rated ? `<div class="avg-big">${(c.avg / 2).toFixed(1)} <span class="stars" style="font-size:1.4rem">★</span></div>` : '<p class="muted">Sem notas ainda.</p>'}
        ${histogram(c.histogram, c.rated)}
        <p class="small muted">${c.watchers} ${c.watchers === 1 ? 'pessoa assistiu' : 'pessoas assistiram'} · ${c.likes ?? 0} curtidas</p>
      </aside>
    </div>`;

  bindSpoilers();
  document.getElementById('reveal')?.addEventListener('click', () => { reveal(g.id); render(); });
  document.getElementById('log')?.addEventListener('click', () => openLogDialog(g));
  $view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Apagar este registro?')) return;
    await api('DELETE', `/api/logs/${b.dataset.del}`);
    render();
  }));
}

function openLogDialog(g) {
  let rating = null;
  let liked = false;
  $dialog.innerHTML = `
    <form method="dialog" id="log-form">
      <h3 style="margin-top:0">${esc(g.away.abbrev)} @ ${esc(g.home.abbrev)} <span class="muted small">${fmtDate(g.date)}</span></h3>
      <div class="dialog-row">
        <div class="rating-input" id="rating" role="slider" aria-label="Nota" aria-valuemin="0" aria-valuemax="5" tabindex="0">
          ${[1, 2, 3, 4, 5].map((i) => `<span class="s" data-i="${i}"><span class="half" hidden></span><span class="full" hidden></span></span>`).join('')}
        </div>
        <button type="button" class="like-toggle" id="like" aria-pressed="false" aria-label="Curtir">♥</button>
        <button type="button" class="ghost small" id="clear-rating">Limpar nota</button>
      </div>
      <label class="field"><span>Assistiu em</span><input type="date" name="watchedOn" value="${todayISO() < g.date ? g.date : todayISO()}" min="${g.date}" required></label>
      <label class="field"><span>Como</span>
        <select name="how"><option value="">—</option>${Object.entries(HOW).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Review (opcional)</span><textarea name="review" maxlength="5000" placeholder="O que achou do jogo?"></textarea></label>
      <div class="checks">
        <label><input type="checkbox" name="spoilers"> Contém spoilers</label>
        <label><input type="checkbox" name="rewatch" ${g.loggedByMe ? 'checked' : ''}> Já tinha visto</label>
      </div>
      <p class="error" id="log-error"></p>
      <div class="actions" style="justify-content:flex-end;margin:0">
        <button type="button" class="ghost" id="cancel">Cancelar</button>
        <button type="submit" class="primary">Salvar</button>
      </div>
    </form>`;

  const $rating = document.getElementById('rating');
  const paint = () => {
    $rating.querySelectorAll('.s').forEach((s) => {
      const i = Number(s.dataset.i);
      s.querySelector('.full').hidden = !(rating >= i * 2);
      s.querySelector('.half').hidden = !(rating === i * 2 - 1);
    });
    $rating.setAttribute('aria-valuenow', rating ? rating / 2 : 0);
  };
  $rating.addEventListener('click', (e) => {
    const s = e.target.closest('.s');
    if (!s) return;
    const r = s.getBoundingClientRect();
    rating = Number(s.dataset.i) * 2 - (e.clientX - r.left < r.width / 2 ? 1 : 0);
    paint();
  });
  $rating.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') rating = Math.min(10, (rating ?? 0) + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') rating = Math.max(1, (rating ?? 2) - 1);
    else return;
    e.preventDefault();
    paint();
  });
  document.getElementById('clear-rating').addEventListener('click', () => { rating = null; paint(); });
  const $like = document.getElementById('like');
  $like.addEventListener('click', () => { liked = !liked; $like.setAttribute('aria-pressed', liked); });
  document.getElementById('cancel').addEventListener('click', () => $dialog.close());

  document.getElementById('log-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/logs', {
        gameId: g.id,
        rating,
        liked,
        watchedOn: f.get('watchedOn'),
        how: f.get('how') || null,
        review: f.get('review'),
        spoilers: f.get('spoilers') === 'on',
        rewatch: f.get('rewatch') === 'on',
      });
      $dialog.close();
      render();
    } catch (err) {
      document.getElementById('log-error').textContent = err.message;
    }
  });
  $dialog.showModal();
}

async function viewTeam(abbrev) {
  $view.innerHTML = '<div class="loading">Carregando calendário…</div>';
  const { name, games } = await api('GET', `/api/teams/${abbrev}`);
  const played = games.filter((g) => g.state !== 'future').reverse();
  const next = games.filter((g) => g.state === 'future').slice(0, 6);
  $view.innerHTML = `
    <div class="profile-head">${logo(abbrev, 'lg')}<div><h1>${esc(name)}</h1>
      <p class="muted">${played.length} jogos disputados · ${played.filter((g) => g.loggedByMe).length} assistidos por você</p></div></div>
    ${next.length ? `<h2>Próximos jogos</h2><div class="game-grid">${next.map(gameCard).join('')}</div>` : ''}
    <h2>Já disputados</h2>
    ${played.length ? `<div class="game-grid">${played.map(gameCard).join('')}</div>` : '<p class="muted">Nenhum jogo nesta temporada ainda.</p>'}`;
}

async function viewUser(username) {
  $view.innerHTML = '<div class="loading">Carregando perfil…</div>';
  const { user, stats, diary } = await api('GET', `/api/users/${encodeURIComponent(username)}`);
  const isMe = me && me.id === user.id;
  let month = '';
  const rows = diary.map((l) => {
    const m = fmtDate(l.watched_on, { month: 'long', year: 'numeric' });
    const head = m !== month ? `<tr><td colspan="5" class="month">${esc((month = m))}</td></tr>` : '';
    const showScore = !spoilerFree || isMe;
    return `${head}<tr>
      <td class="muted">${fmtDate(l.watched_on, { day: '2-digit' })}</td>
      <td>${gameLine(l, { showScore })}</td>
      <td>${stars(l.rating)}</td>
      <td>${l.liked ? '<span style="color:var(--like)">♥</span>' : ''} ${l.review ? '<span title="Tem review">✎</span>' : ''} ${l.rewatch ? '<span title="Revisto">↻</span>' : ''}</td>
      <td class="muted small hide-sm">${l.how ? HOW[l.how] : ''}</td>
    </tr>`;
  }).join('');

  $view.innerHTML = `
    <div class="profile-head">
      <div class="avatar">${esc(user.username[0].toUpperCase())}</div>
      <div>
        <h1>${esc(user.username)} ${user.fav_team ? logo(user.fav_team, 'sm') : ''}</h1>
        <p class="muted" style="margin:0">${user.bio ? esc(user.bio) : isMe ? 'Escreva uma bio no seu perfil.' : ''}</p>
      </div>
      <div class="stat-row">
        <div><b>${stats.games}</b><span>Jogos</span></div>
        <div><b>${stats.this_year ?? 0}</b><span>Este ano</span></div>
        <div><b>${stats.reviews ?? 0}</b><span>Reviews</span></div>
        <div><b>${stats.avg ? (stats.avg / 2).toFixed(1) : '–'}</b><span>Nota média</span></div>
      </div>
    </div>

    ${isMe ? `
      <h2>Perfil</h2>
      <form id="profile" class="dialog-row">
        <select name="favTeam" style="max-width:240px"><option value="">Time do coração</option>
          ${Object.entries(TEAMS).map(([a, n]) => `<option value="${a}" ${user.fav_team === a ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <input name="bio" maxlength="280" placeholder="Bio curta" value="${esc(user.bio ?? '')}" style="flex:1;min-width:200px">
        <button class="ghost">Salvar</button>
      </form>` : ''}

    <div class="layout-2">
      <div>
        <h2>Diário</h2>
        ${diary.length ? `<table class="diary"><tbody>${rows}</tbody></table>` : `<p class="empty">${isMe ? 'Você ainda não registrou nenhum jogo. <a href="#/" style="color:var(--ice)">Comece pelos jogos de hoje.</a>' : 'Nenhum jogo registrado.'}</p>`}
      </div>
      <aside>
        <h2>Notas</h2>
        ${histogram(stats.histogram, Object.values(stats.histogram).reduce((a, b) => a + b, 0))}
        <h2>Times mais vistos</h2>
        ${stats.topTeams.length ? stats.topTeams.map((t) => `<div style="padding:.25rem 0"><a href="#/time/${esc(t.team)}">${logo(t.team, 'sm')} ${esc(TEAMS[t.team] ?? t.team)}</a> <span class="muted small">${t.n}</span></div>`).join('') : '<p class="muted">—</p>'}
      </aside>
    </div>`;

  document.getElementById('profile')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { user: u } = await api('PUT', '/api/me', { favTeam: f.get('favTeam') || null, bio: f.get('bio') });
    me = { ...me, ...u };
    render();
  });
}

async function viewCommunity() {
  $view.innerHTML = '<div class="loading">Carregando…</div>';
  const { recent, popular, topRated } = await api('GET', '/api/feed');
  const list = (rows, extra) => rows.map((r) => `<div class="review">${gameLine(r, { showScore: !spoilerFree || revealed.has(r.game_id) })}<div class="small muted">${extra(r)}</div></div>`).join('');
  $view.innerHTML = `
    <div class="layout-2">
      <div>
        <h2>Atividade recente</h2>
        ${recent.length ? recent.map((r) => reviewItem(r, { withGame: true })).join('') : '<p class="empty">Nada por aqui ainda. Seja a primeira pessoa a registrar um jogo.</p>'}
      </div>
      <aside>
        <h2>Populares da semana</h2>
        ${popular.length ? list(popular, (r) => `${r.logs} registros ${r.avg ? '· ' + stars(Math.round(r.avg)) : ''}`) : '<p class="muted">—</p>'}
        <h2>Mais bem avaliados</h2>
        ${topRated.length ? list(topRated, (r) => `${(r.avg / 2).toFixed(1)}★ em ${r.rated} notas`) : '<p class="muted small">Aparece quando um jogo tiver ao menos 2 notas.</p>'}
      </aside>
    </div>`;
  bindSpoilers();
}

function viewAuth() {
  if (me) { location.hash = `#/u/${me.username}`; return; }
  $view.innerHTML = `
    <form class="form-card" id="auth">
      <h1>Entrar</h1>
      <p class="muted small">Sem conta? Preencha e clique em “Criar conta”.</p>
      <label class="field"><span>Usuário</span><input name="username" autocomplete="username" required></label>
      <label class="field"><span>Senha</span><input name="password" type="password" autocomplete="current-password" required minlength="8"></label>
      <p class="error" id="auth-error"></p>
      <div class="actions"><button class="primary" value="login">Entrar</button><button class="ghost" value="signup">Criar conta</button></div>
    </form>`;
  document.getElementById('auth').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const action = e.submitter?.value === 'signup' ? 'signup' : 'login';
    try {
      ({ user: me } = await api('POST', `/api/${action}`, { username: f.get('username'), password: f.get('password') }));
      renderSession();
      history.length > 1 ? history.back() : (location.hash = '#/');
    } catch (err) {
      document.getElementById('auth-error').textContent = err.message;
    }
  });
}

// ---------- roteador ----------

async function render() {
  const [, section, arg] = location.hash.split('/');
  try {
    if (section === 'jogo' && /^\d{10}$/.test(arg)) await viewGame(arg);
    else if (section === 'dia' && /^\d{4}-\d{2}-\d{2}$/.test(arg)) await viewSchedule(arg);
    else if (section === 'time' && TEAMS[arg]) await viewTeam(arg);
    else if (section === 'u' && arg) await viewUser(decodeURIComponent(arg));
    else if (section === 'comunidade') await viewCommunity();
    else if (section === 'entrar') viewAuth();
    else await viewSchedule(todayISO());
  } catch (e) {
    $view.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
({ user: me } = await api('GET', '/api/me').catch(() => ({ user: null })));
renderSession();
render();
