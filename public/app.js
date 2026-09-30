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
let returnTo = '#/'; // última tela do app antes do login

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

function reviewItem(r, { withGame = false, showMvp } = {}) {
  const mine = me && me.username === r.username;
  // No feed, o placar só aparece se o próprio leitor já viu o jogo; aqui não sabemos, então segue o modo sem spoiler.
  const scoreOk = !spoilerFree || revealed.has(r.game_id) || mine;
  showMvp ??= scoreOk;
  return `
    <article class="review">
      <header>
        <a href="#/u/${esc(r.username)}">${esc(r.username)}</a>
        ${stars(r.rating)} ${r.liked ? '<span style="color:var(--like)">♥</span>' : ''}
        ${r.rewatch ? '<span class="badge">Revisto</span>' : ''}
        <span class="muted small">assistiu em ${fmtDate(r.watched_on)}</span>
        ${showMvp ? mvpTag(r) : ''}
      </header>
      ${withGame ? `<div class="game-line">${gameLine(r, { showScore: scoreOk })}</div>` : ''}
      ${r.review ? `<p class="${r.spoilers && !mine ? 'spoiler' : ''}" ${r.spoilers && !mine ? 'title="Contém spoilers. Clique para ler."' : ''}>${esc(r.review)}</p>` : ''}
      ${reviewActions(r)}
    </article>`;
}

// Curtir e comentar. Só aparece quando o servidor mandou as contagens.
function reviewActions(r) {
  if (r.like_count === undefined) return '';
  const mine = me && me.username === r.username;
  const canLike = me && !mine;
  const n = r.comment_count;
  return `<footer class="review-actions">
    <button class="like-btn" data-like="${r.id}" aria-pressed="${Boolean(r.liked_by_me)}" ${canLike ? '' : 'disabled'}
      title="${!me ? 'Entre para curtir' : mine ? 'Sua review' : r.liked_by_me ? 'Descurtir' : 'Curtir review'}">♥ <span>${r.like_count}</span></button>
    <a href="#/review/${r.id}">${n ? `${n} ${n === 1 ? 'comentário' : 'comentários'}` : 'Comentar'}</a>
  </footer>`;
}

// Lista de jogos em formato de cartão, com os confrontos dos primeiros jogos.
function listCard(l) {
  const preview = (l.preview ?? []).map(([a, h]) => `<span class="pair">${logo(a, 'sm')}${logo(h, 'sm')}</span>`).join('');
  return `<a class="list-card" href="#/lista/${l.id}">
    <div class="preview">${preview || '<span class="muted small">Lista vazia</span>'}</div>
    <strong>${esc(l.title)}</strong>
    <span class="muted small">${esc(l.username)} · ${l.items} ${l.items === 1 ? 'jogo' : 'jogos'}${l.ranked ? ' · ranking' : ''}</span>
  </a>`;
}

function histogram(h, total) {
  const max = Math.max(1, ...Object.values(h));
  const bars = Array.from({ length: 10 }, (_, i) => {
    const n = h[i + 1] ?? 0;
    return `<span style="height:${(n / max) * 100}%" title="${(i + 1) / 2}★: ${n}"></span>`;
  }).join('');
  return `<div class="histo">${bars}</div><div class="histo-labels"><span>½★</span><span>${total} ${total === 1 ? 'nota' : 'notas'}</span><span>★★★★★</span></div>`;
}

const mvpTag = (r) => (r.mvp_name ? `<span class="mvp-tag" title="Escolha do espectador">MVP: ${logo(r.mvp_team, 'sm')} ${esc(r.mvp_name)}</span>` : '');

// Ranking de jogadores (escolha do espectador). `count` devolve o texto da contagem.
function playerRanking(rows, count) {
  if (!rows.length) return '';
  return `<ol class="ranking">${rows.map((p) => `<li>${logo(p.team, 'sm')} <span class="who">${esc(p.name)} <span class="muted small">${esc(p.team)}${p.position ? ' · ' + esc(p.position) : ''}</span></span><span class="muted small">${count(p)}</span></li>`).join('')}</ol>`;
}

function bindSpoilers(root = $view) {
  root.querySelectorAll('.spoiler').forEach((el) => el.addEventListener('click', () => el.classList.add('shown')));
  root.querySelectorAll('[data-like]').forEach((btn) => btn.addEventListener('click', async () => {
    const liked = btn.getAttribute('aria-pressed') === 'true';
    btn.disabled = true;
    try {
      const r = await api(liked ? 'DELETE' : 'POST', `/api/logs/${btn.dataset.like}/like`);
      btn.setAttribute('aria-pressed', r.liked_by_me);
      btn.querySelector('span').textContent = r.like_count;
    } catch (e) {
      alert(e.message);
    }
    btn.disabled = false;
  }));
}

function followButton(username, following) {
  return `<button class="${following ? 'ghost' : 'primary'} follow-btn" data-follow="${esc(username)}" aria-pressed="${following}">${following ? 'Seguindo' : 'Seguir'}</button>`;
}

function bindFollow(root = $view, after = null) {
  root.querySelectorAll('[data-follow]').forEach((btn) => btn.addEventListener('click', async () => {
    const following = btn.getAttribute('aria-pressed') === 'true';
    btn.disabled = true;
    try {
      const info = await api(following ? 'DELETE' : 'POST', `/api/users/${encodeURIComponent(btn.dataset.follow)}/follow`);
      btn.setAttribute('aria-pressed', info.is_following);
      btn.textContent = info.is_following ? 'Seguindo' : 'Seguir';
      btn.className = `${info.is_following ? 'ghost' : 'primary'} follow-btn`;
      after?.(info);
    } catch (e) {
      alert(e.message);
    }
    btn.disabled = false;
  }));
}

// ---------- sessão ----------

function renderSession() {
  document.getElementById('nav-feed').hidden = !me;
  document.getElementById('nav-bell').hidden = !me;
  refreshBell();
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
            : me ? `<button class="primary" id="log">${g.loggedByMe ? 'Registrar de novo' : '+ Registrar / avaliar'}</button>
                    <button class="ghost" id="add-to-list">+ Adicionar à lista</button>`
            : '<a class="btn primary" href="#/entrar">Entre para registrar este jogo</a>'}
        </div>

        ${myLogs.length ? `<h2>Seus registros</h2>${myLogs.map((l) => `
          <div class="review">
            <header>${stars(l.rating)} ${l.liked ? '<span style="color:var(--like)">♥</span>' : ''}
              <span class="muted small">${fmtDate(l.watched_on)}${l.how ? ' · ' + HOW[l.how] : ''}${l.rewatch ? ' · revisto' : ''}</span>
              ${mvpTag(l)}
              <button class="danger small" data-del="${l.id}">Apagar</button></header>
            ${l.review ? `<p>${esc(l.review)}</p>` : ''}
          </div>`).join('')}` : ''}

        <h2>Reviews</h2>
        ${c.reviews.length ? c.reviews.map((r) => reviewItem(r, { showMvp: show })).join('') : '<p class="muted">Ninguém escreveu sobre este jogo ainda.</p>'}

        ${g.state !== 'future' ? `<h2>Gols</h2>${show ? goalsHtml() : '<p class="muted">Escondido no modo sem spoiler.</p>'}` : ''}
        ${show && g.stars.length ? `<h2>Jogadores em destaque</h2><div class="stars-list">${[...g.stars].sort((a, b) => a.star - b.star).map((s) => `<div><span class="badge">${s.star}º</span> ${logo(s.team, 'sm')} ${esc(s.name)} <span class="muted small">${esc(s.team)} · ${esc(s.position)}</span></div>`).join('')}</div><p class="muted small">Seleção oficial da NHL para o jogo.</p>` : ''}
      </div>
      <aside>
        <h2>Comunidade</h2>
        ${c.rated ? `<div class="avg-big">${(c.avg / 2).toFixed(1)} <span class="stars" style="font-size:1.4rem">★</span></div>` : '<p class="muted">Sem notas ainda.</p>'}
        ${histogram(c.histogram, c.rated)}
        <p class="small muted">${c.watchers} ${c.watchers === 1 ? 'pessoa assistiu' : 'pessoas assistiram'} · ${c.likes ?? 0} ${c.likes === 1 ? 'curtida' : 'curtidas'}</p>
        ${g.state !== 'future' ? `<h2>Escolha do espectador</h2>
          ${!show ? '<p class="muted small">Escondido no modo sem spoiler.</p>'
            : c.mvpVotes.length ? playerRanking(c.mvpVotes, (p) => `${p.votes} ${p.votes === 1 ? 'voto' : 'votos'}`)
            : '<p class="muted small">Ninguém escolheu ainda. Registre o jogo e diga quem foi o melhor no gelo na sua opinião.</p>'}` : ''}
        ${c.lists.length ? `<h2>Aparece nas listas</h2><div class="list-grid one">${c.lists.map(listCard).join('')}</div>` : ''}
      </aside>
    </div>`;

  bindSpoilers();
  document.getElementById('reveal')?.addEventListener('click', () => { reveal(g.id); render(); });
  document.getElementById('log')?.addEventListener('click', () => openLogDialog(g));
  document.getElementById('add-to-list')?.addEventListener('click', () => openListDialog(g));
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
      <label class="field"><span>Escolha do espectador: quem foi o melhor do jogo para você?</span>
        <select name="mvp" id="mvp-select" disabled><option value="">Carregando jogadores…</option></select>
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

  const $mvp = document.getElementById('mvp-select');
  api('GET', `/api/games/${g.id}/players`)
    .then(({ away, home }) => {
      const line = (p) => {
        const stat = p.position === 'G'
          ? (p.shotsAgainst != null ? ` · ${p.saves}/${p.shotsAgainst} defesas` : '')
          : p.goals || p.assists ? ` · ${p.goals}G ${p.assists}A` : '';
        return `<option value="${p.id}">${p.number != null ? '#' + p.number + ' ' : ''}${esc(p.name)} (${esc(p.position)})${stat}</option>`;
      };
      const group = (t) => (t.players.length ? `<optgroup label="${esc(TEAMS[t.abbrev] ?? t.abbrev)}">${t.players.map(line).join('')}</optgroup>` : '');
      const has = away.players.length + home.players.length > 0;
      $mvp.innerHTML = `<option value="">${has ? 'Sem escolha' : 'Elenco indisponível para este jogo'}</option>${group(away)}${group(home)}`;
      $mvp.disabled = !has;
    })
    .catch(() => { $mvp.innerHTML = '<option value="">Não foi possível carregar o elenco</option>'; });

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
        mvpPlayerId: f.get('mvp') ? Number(f.get('mvp')) : null,
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
  const { user, stats, diary, lists } = await api('GET', `/api/users/${encodeURIComponent(username)}`);
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
      <td>${l.liked ? '<span style="color:var(--like)">♥</span>' : ''} ${l.review ? `<a href="#/review/${l.id}" title="Ler review">✎</a>` : ''} ${l.rewatch ? '<span title="Revisto">↻</span>' : ''}</td>
      <td class="muted small hide-sm">${l.how ? HOW[l.how] : ''}</td>
    </tr>`;
  }).join('');

  $view.innerHTML = `
    <div class="profile-head">
      <div class="avatar">${esc(user.username[0].toUpperCase())}</div>
      <div>
        <h1>${esc(user.username)} ${user.fav_team ? logo(user.fav_team, 'sm') : ''}</h1>
        <p class="muted" style="margin:0">${user.bio ? esc(user.bio) : isMe ? 'Escreva uma bio no seu perfil.' : ''}</p>
        <p class="small" style="margin:.4rem 0 0">
          <a href="#/u/${esc(user.username)}/rede"><b id="followers-n">${user.followers}</b> ${user.followers === 1 ? 'seguidor' : 'seguidores'} · <b>${user.following}</b> seguindo</a>
          ${user.follows_you ? '<span class="badge">Segue você</span>' : ''}
        </p>
        ${me && !isMe ? `<div style="margin-top:.5rem">${followButton(user.username, user.is_following)}</div>` : ''}
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

    <h2>Listas ${isMe ? '<a href="#/listas/nova" class="btn ghost small" style="float:right;text-transform:none">+ Nova lista</a>' : ''}</h2>
    ${lists.length ? `<div class="list-grid">${lists.map(listCard).join('')}</div>`
      : `<p class="muted small">${isMe ? 'Monte listas como "Melhores jogos de playoff que eu vi". Crie uma aqui ou pela página de qualquer jogo.' : 'Nenhuma lista ainda.'}</p>`}

    <div class="layout-2">
      <div>
        <h2>Diário</h2>
        ${diary.length ? `<table class="diary"><tbody>${rows}</tbody></table>` : `<p class="empty">${isMe ? 'Você ainda não registrou nenhum jogo. <a href="#/" style="color:var(--ice)">Comece pelos jogos de hoje.</a>' : 'Nenhum jogo registrado.'}</p>`}
      </div>
      <aside>
        <h2>Notas</h2>
        ${histogram(stats.histogram, Object.values(stats.histogram).reduce((a, b) => a + b, 0))}
        <h2>${isMe ? 'Suas escolhas do espectador' : 'Escolhas do espectador'}</h2>
        ${stats.mvps.length ? playerRanking(stats.mvps, (p) => `${p.games} ${p.games === 1 ? 'jogo' : 'jogos'}`) : `<p class="muted small">${isMe ? 'Quando registrar um jogo, escolha o melhor jogador. Seu ranking aparece aqui.' : '—'}</p>`}
        <h2>Times mais vistos</h2>
        ${stats.topTeams.length ? stats.topTeams.map((t) => `<div style="padding:.25rem 0"><a href="#/time/${esc(t.team)}">${logo(t.team, 'sm')} ${esc(TEAMS[t.team] ?? t.team)}</a> <span class="muted small">${t.n}</span></div>`).join('') : '<p class="muted">—</p>'}
      </aside>
    </div>`;

  bindFollow($view, (info) => {
    const n = document.getElementById('followers-n');
    n.textContent = info.followers;
    n.nextSibling.textContent = ` ${info.followers === 1 ? 'seguidor' : 'seguidores'} · `;
  });
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
  const { recent, recentLists, popular, topRated, topMvps } = await api('GET', '/api/feed');
  const list = (rows, extra) => rows.map((r) => `<div class="review">${gameLine(r, { showScore: !spoilerFree || revealed.has(r.game_id) })}<div class="small muted">${extra(r)}</div></div>`).join('');
  $view.innerHTML = `
    <div class="layout-2">
      <div>
        ${recentLists.length ? `<h2>Listas recentes</h2><div class="list-grid">${recentLists.slice(0, 6).map(listCard).join('')}</div>` : ''}
        <h2>Atividade recente</h2>
        ${recent.length ? recent.map((r) => reviewItem(r, { withGame: true })).join('') : '<p class="empty">Nada por aqui ainda. Seja a primeira pessoa a registrar um jogo.</p>'}
      </div>
      <aside>
        <h2>Populares da semana</h2>
        ${popular.length ? list(popular, (r) => `${r.logs} registros ${r.avg ? '· ' + stars(Math.round(r.avg)) : ''}`) : '<p class="muted">—</p>'}
        <h2>Mais bem avaliados</h2>
        ${topRated.length ? list(topRated, (r) => `${(r.avg / 2).toFixed(1)}★ em ${r.rated} notas`) : '<p class="muted small">Aparece quando um jogo tiver ao menos 2 notas.</p>'}
        <h2>Escolhas do espectador</h2>
        ${topMvps.length ? playerRanking(topMvps, (p) => `${p.votes} ${p.votes === 1 ? 'voto' : 'votos'}`) : '<p class="muted small">Ninguém escolheu um melhor jogador ainda.</p>'}
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
      location.hash = returnTo;
    } catch (err) {
      document.getElementById('auth-error').textContent = err.message;
    }
  });
}

// ---------- social: feed, review, seguidores ----------

function userChip(u, { withFollow = false } = {}) {
  return `<div class="user-chip">
    <a href="#/u/${esc(u.username)}"><span class="avatar sm">${esc(u.username[0].toUpperCase())}</span> ${esc(u.username)} ${u.fav_team ? logo(u.fav_team, 'sm') : ''}</a>
    ${u.logs != null ? `<span class="muted small">${u.logs} ${u.logs === 1 ? 'registro' : 'registros'}</span>` : ''}
    ${withFollow && me && me.username !== u.username ? followButton(u.username, false) : ''}
  </div>`;
}

async function viewFeed() {
  if (!me) { location.hash = '#/entrar'; return; }
  $view.innerHTML = '<div class="loading">Carregando…</div>';
  const { following, activity, suggestions } = await api('GET', '/api/following');
  const suggest = suggestions.length
    ? suggestions.map((u) => userChip(u, { withFollow: true })).join('')
    : '<p class="muted small">Ainda não tem mais ninguém registrando jogos. Chame os amigos!</p>';
  $view.innerHTML = `
    <div class="layout-2">
      <div>
        <h2>Quem você segue</h2>
        ${following === 0 ? '<p class="empty">Você ainda não segue ninguém. Siga pessoas para ver aqui o que elas assistiram.</p>'
          : activity.length ? activity.map((r) => reviewItem(r, { withGame: true })).join('')
          : '<p class="empty">Quem você segue ainda não registrou nenhum jogo.</p>'}
      </div>
      <aside>
        <h2>Sugestões para seguir</h2>
        ${suggest}
      </aside>
    </div>`;
  bindSpoilers();
  bindFollow();
}

async function viewReview(id) {
  $view.innerHTML = '<div class="loading">Carregando review…</div>';
  const { log: r, comments } = await api('GET', `/api/logs/${id}`);
  const mine = me && me.username === r.username;
  const scoreOk = !spoilerFree || revealed.has(r.game_id) || mine;
  const commentHtml = (list) => list.length
    ? list.map((c) => `<div class="comment">
        <header><a href="#/u/${esc(c.username)}">${esc(c.username)}</a> <span class="muted small">${fmtDate(c.created_at.slice(0, 10))}${c.edited_at ? ' · editado' : ''}</span>
          ${me && me.username === c.username ? `<button class="link small" data-edit-comment="${c.id}">Editar</button>` : ''}
          ${me && (me.username === c.username || mine) ? `<button class="danger small" data-del-comment="${c.id}">Apagar</button>` : ''}</header>
        <p data-comment-body="${c.id}">${esc(c.body)}</p></div>`).join('')
    : '<p class="muted">Nenhum comentário ainda.</p>';

  $view.innerHTML = `
    <div class="review-page">
      <div class="game-line big">${gameLine(r, { showScore: scoreOk })}</div>
      ${reviewItem(r)}
      <h2>Comentários</h2>
      <div id="comments">${commentHtml(comments)}</div>
      ${me ? `<form id="comment-form" class="comment-form">
          <textarea name="body" maxlength="1000" required placeholder="Escreva um comentário"></textarea>
          <p class="error" id="comment-error"></p>
          <button class="primary">Comentar</button>
        </form>` : '<p><a class="btn primary" href="#/entrar">Entre para comentar</a></p>'}
    </div>`;
  bindSpoilers();

  const $comments = document.getElementById('comments');
  let current = comments; // comentários na tela, para a edição saber o texto original
  const showComments = (list) => {
    current = list;
    $comments.innerHTML = commentHtml(list);
    const link = $view.querySelector('.review-actions a');
    if (link) link.textContent = list.length ? `${list.length} ${list.length === 1 ? 'comentário' : 'comentários'}` : 'Comentar';
    bindDeletes();
  };
  const bindDeletes = () => {
    $comments.querySelectorAll('[data-del-comment]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Apagar este comentário?')) return;
      const res = await api('DELETE', `/api/comments/${b.dataset.delComment}`);
      showComments(res.comments);
    }));
    // Edição no lugar: troca o texto por uma caixa com Salvar/Cancelar.
    $comments.querySelectorAll('[data-edit-comment]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.editComment;
      const c = current.find((x) => String(x.id) === id);
      const $p = $comments.querySelector(`[data-comment-body="${id}"]`);
      b.hidden = true;
      $p.outerHTML = `<form class="comment-edit" data-edit-form="${id}">
          <textarea maxlength="1000" required>${esc(c.body)}</textarea>
          <p class="error"></p>
          <div class="actions" style="margin:.4rem 0 0"><button class="primary small">Salvar</button><button type="button" class="ghost small" data-cancel>Cancelar</button></div>
        </form>`;
      const $form = $comments.querySelector(`[data-edit-form="${id}"]`);
      const $ta = $form.querySelector('textarea');
      $ta.focus();
      $ta.setSelectionRange($ta.value.length, $ta.value.length);
      $form.querySelector('[data-cancel]').addEventListener('click', () => showComments(current));
      $form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const res = await api('PUT', `/api/comments/${id}`, { body: $ta.value });
          showComments(res.comments);
        } catch (err) {
          $form.querySelector('.error').textContent = err.message;
        }
      });
    }));
  };
  bindDeletes();
  document.getElementById('comment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const $body = e.target.elements.body;
    try {
      const res = await api('POST', `/api/logs/${r.id}/comments`, { body: $body.value });
      $body.value = '';
      showComments(res.comments);
    } catch (err) {
      document.getElementById('comment-error').textContent = err.message;
    }
  });
}

async function viewNetwork(username) {
  $view.innerHTML = '<div class="loading">Carregando…</div>';
  const { followers, following } = await api('GET', `/api/users/${encodeURIComponent(username)}/network`);
  const col = (title, list, empty) => `<div><h2>${title} (${list.length})</h2>${list.length ? list.map((u) => userChip(u)).join('') : `<p class="muted">${empty}</p>`}</div>`;
  $view.innerHTML = `
    <p style="margin-top:1.5rem"><a href="#/u/${esc(username)}">← Perfil de ${esc(username)}</a></p>
    <div class="layout-halves">
      ${col('Seguidores', followers, 'Ninguém ainda.')}
      ${col('Seguindo', following, 'Não segue ninguém ainda.')}
    </div>`;
}

// ---------- listas ----------

// Converte um jogo da agenda (formato normalizado) para o formato de item de lista.
const gameToRow = (g) => ({
  game_id: g.id, note: null, game_date: g.date, away_abbrev: g.away.abbrev, home_abbrev: g.home.abbrev,
  away_score: g.away.score, home_score: g.home.score, last_period: g.state === 'final' ? g.lastPeriod : null,
});

async function openListDialog(g) {
  $dialog.innerHTML = '<p class="loading">Carregando suas listas…</p>';
  $dialog.showModal();
  const draw = async () => {
    const { lists } = await api('GET', `/api/me/lists?game=${g.id}`);
    $dialog.innerHTML = `
      <h3 style="margin-top:0">Adicionar a uma lista</h3>
      <p class="muted small">${esc(g.away.abbrev)} @ ${esc(g.home.abbrev)} · ${fmtDate(g.date)}</p>
      <div class="pick-lists">
        ${lists.length ? lists.map((l) => `<div class="pick-row"><span>${esc(l.title)} <span class="muted small">${l.items} ${l.items === 1 ? 'jogo' : 'jogos'}</span></span>
          ${l.has_game ? '<span class="badge mine">Já está</span>' : `<button class="ghost small" data-add="${l.id}">Adicionar</button>`}</div>`).join('')
          : '<p class="muted small">Você ainda não tem listas.</p>'}
      </div>
      <form id="new-list" class="new-list">
        <label class="field"><span>Nova lista com este jogo</span><input name="title" maxlength="100" placeholder="Ex.: Melhores jogos de playoff que eu vi" required></label>
        <div class="checks"><label><input type="checkbox" name="ranked"> Lista em ranking (numerada)</label></div>
        <p class="error" id="list-error"></p>
        <div class="actions" style="justify-content:space-between;margin:0">
          <button type="button" class="ghost" id="close-lists">Fechar</button>
          <button class="primary">Criar lista</button>
        </div>
      </form>`;
    document.getElementById('close-lists').addEventListener('click', () => $dialog.close());
    $dialog.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api('POST', `/api/lists/${b.dataset.add}/items`, { gameId: g.id }); await draw(); }
      catch (e) { document.getElementById('list-error').textContent = e.message; b.disabled = false; }
    }));
    document.getElementById('new-list').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const { list } = await api('POST', '/api/lists', { title: f.get('title'), ranked: f.get('ranked') === 'on', gameId: g.id });
        $dialog.close();
        location.hash = `#/lista/${list.id}`;
      } catch (err) {
        document.getElementById('list-error').textContent = err.message;
      }
    });
  };
  try { await draw(); } catch (e) { $dialog.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function viewNewList() {
  if (!me) { location.hash = '#/entrar'; return; }
  $view.innerHTML = `
    <form class="form-card" id="create-list" style="max-width:560px">
      <h1>Nova lista</h1>
      <label class="field"><span>Título</span><input name="title" maxlength="100" required placeholder="Ex.: Os jogos 7 mais tensos que eu vi"></label>
      <label class="field"><span>Descrição (opcional)</span><textarea name="description" maxlength="1000"></textarea></label>
      <div class="checks"><label><input type="checkbox" name="ranked"> Lista em ranking (numerada)</label></div>
      <p class="muted small">Depois de criar, adicione jogos pela própria lista ou pelo botão "Adicionar à lista" na página de cada jogo.</p>
      <p class="error" id="create-error"></p>
      <div class="actions"><button class="primary">Criar lista</button></div>
    </form>`;
  document.getElementById('create-list').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { list } = await api('POST', '/api/lists', { title: f.get('title'), description: f.get('description'), ranked: f.get('ranked') === 'on' });
      location.hash = `#/lista/${list.id}`;
    } catch (err) {
      document.getElementById('create-error').textContent = err.message;
    }
  });
}

async function viewList(id) {
  $view.innerHTML = '<div class="loading">Carregando lista…</div>';
  const data = await api('GET', `/api/lists/${id}`);
  const isOwner = me && me.id === data.list.user_id;
  let editing = false;
  let draft = null; // cópia editável da lista

  const itemHtml = (it, i, list, edit) => {
    const showScore = !spoilerFree || revealed.has(it.game_id) || isOwner;
    return `<li class="list-item">
      ${list.ranked ? `<span class="rank">${i + 1}</span>` : ''}
      <div class="body">
        <div>${gameLine(it, { showScore })}</div>
        ${edit ? `<input class="note-input" data-note="${i}" maxlength="500" placeholder="Nota sobre este jogo (opcional)" value="${esc(it.note ?? '')}">`
          : it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
      </div>
      ${edit ? `<div class="item-tools">
          <button type="button" class="ghost small" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
          <button type="button" class="ghost small" data-down="${i}" ${i === draft.items.length - 1 ? 'disabled' : ''} aria-label="Descer">↓</button>
          <button type="button" class="danger small" data-remove="${i}" aria-label="Tirar da lista">✕</button>
        </div>` : ''}
    </li>`;
  };

  const draw = () => {
    const list = editing ? draft.list : data.list;
    const items = editing ? draft.items : data.items;
    $view.innerHTML = `
      <div class="list-head">
        ${editing ? `
          <label class="field"><span>Título</span><input id="l-title" maxlength="100" value="${esc(list.title)}"></label>
          <label class="field"><span>Descrição</span><textarea id="l-desc" maxlength="1000">${esc(list.description ?? '')}</textarea></label>
          <div class="checks"><label><input type="checkbox" id="l-ranked" ${list.ranked ? 'checked' : ''}> Lista em ranking (numerada)</label></div>`
        : `<h1>${esc(list.title)}</h1>
          <p class="muted">Lista de <a href="#/u/${esc(list.username)}">${esc(list.username)}</a> · ${items.length} ${items.length === 1 ? 'jogo' : 'jogos'}</p>
          ${list.description ? `<p class="list-desc">${esc(list.description)}</p>` : ''}`}
        ${isOwner ? `<div class="actions">${editing
          ? '<button class="primary" id="save">Salvar</button><button class="ghost" id="cancel">Cancelar</button><button class="danger" id="delete-list" style="margin-left:auto">Apagar lista</button>'
          : '<button class="ghost" id="edit">Editar lista</button>'}</div>` : ''}
        <p class="error" id="list-error"></p>
      </div>
      ${items.length ? `<ol class="list-items">${items.map((it, i) => itemHtml(it, i, list, editing)).join('')}</ol>`
        : `<p class="empty">Lista vazia.${isOwner ? ' Clique em "Editar lista" para adicionar jogos.' : ''}</p>`}
      ${editing ? `<div class="add-game">
          <h2>Adicionar jogo</h2>
          <div class="dialog-row"><input type="date" id="add-date" value="${todayISO()}" style="width:auto"><select id="add-game" style="flex:1;min-width:220px"><option value="">Escolha a data</option></select><button type="button" class="ghost" id="add-btn">Adicionar</button></div>
          <p class="muted small">Dica: na página de qualquer jogo também tem o botão "Adicionar à lista".</p>
        </div>` : ''}`;
    bind();
  };

  let dayGames = [];
  async function loadDay(date) {
    const $sel = document.getElementById('add-game');
    $sel.innerHTML = '<option value="">Carregando…</option>';
    try {
      const { games } = await api('GET', `/api/schedule/${date}`);
      dayGames = games.filter((g) => g.state !== 'future');
      $sel.innerHTML = dayGames.length
        ? `<option value="">Escolha o jogo</option>${dayGames.map((g) => `<option value="${g.id}">${esc(g.away.abbrev)} @ ${esc(g.home.abbrev)}</option>`).join('')}`
        : '<option value="">Nenhum jogo já disputado nesse dia</option>';
    } catch (e) {
      $sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
    }
  }

  function syncDraftFields() {
    draft.list.title = document.getElementById('l-title').value;
    draft.list.description = document.getElementById('l-desc').value;
    draft.list.ranked = document.getElementById('l-ranked').checked ? 1 : 0;
    $view.querySelectorAll('[data-note]').forEach((el) => { draft.items[Number(el.dataset.note)].note = el.value; });
  }

  function bind() {
    document.getElementById('edit')?.addEventListener('click', () => {
      editing = true;
      draft = { list: { ...data.list }, items: data.items.map((it) => ({ ...it })) };
      draw();
      loadDay(todayISO());
    });
    if (!editing) return;
    const $err = document.getElementById('list-error');
    document.getElementById('cancel').addEventListener('click', () => { editing = false; draw(); });
    document.getElementById('add-date').addEventListener('change', (e) => e.target.value && loadDay(e.target.value));
    document.getElementById('add-btn').addEventListener('click', () => {
      const g = dayGames.find((x) => String(x.id) === document.getElementById('add-game').value);
      if (!g) return;
      syncDraftFields();
      if (draft.items.some((it) => it.game_id === g.id)) { $err.textContent = 'Esse jogo já está na lista'; return; }
      draft.items.push(gameToRow(g));
      const date = document.getElementById('add-date').value;
      draw();
      document.getElementById('add-date').value = date;
      loadDay(date);
    });
    const move = (i, d) => {
      syncDraftFields();
      [draft.items[i], draft.items[i + d]] = [draft.items[i + d], draft.items[i]];
      draw();
      loadDay(todayISO());
    };
    $view.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.up), -1)));
    $view.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.down), 1)));
    $view.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      syncDraftFields();
      draft.items.splice(Number(b.dataset.remove), 1);
      draw();
      loadDay(todayISO());
    }));
    document.getElementById('save').addEventListener('click', async () => {
      syncDraftFields();
      try {
        const saved = await api('PUT', `/api/lists/${data.list.id}`, {
          title: draft.list.title,
          description: draft.list.description,
          ranked: Boolean(draft.list.ranked),
          items: draft.items.map((it) => ({ gameId: it.game_id, note: it.note })),
        });
        data.list = { ...data.list, ...saved.list };
        data.items = saved.items;
        editing = false;
        draw();
      } catch (e) {
        $err.textContent = e.message;
      }
    });
    document.getElementById('delete-list').addEventListener('click', async () => {
      if (!confirm('Apagar esta lista? Não dá para desfazer.')) return;
      await api('DELETE', `/api/lists/${data.list.id}`);
      location.hash = `#/u/${me.username}`;
    });
  }

  draw();
}

// ---------- notificações ----------

const $bellCount = document.getElementById('bell-count');

async function refreshBell() {
  if (!me) { $bellCount.hidden = true; return; }
  try {
    const { unread } = await api('GET', '/api/notifications/count');
    $bellCount.hidden = unread === 0;
    $bellCount.textContent = unread > 99 ? '99+' : unread;
    document.title = unread ? `(${unread}) Puckboxd` : 'Puckboxd';
  } catch { /* sem rede: tenta de novo no próximo ciclo */ }
}

// Confere a cada minuto, só com a aba visível.
setInterval(() => document.visibilityState === 'visible' && refreshBell(), 60e3);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshBell());

// created_at vem do SQLite em UTC, no formato "AAAA-MM-DD HH:MM:SS".
function timeAgo(sqlDate) {
  const s = (Date.now() - Date.parse(sqlDate.replace(' ', 'T') + 'Z')) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) { const d = Math.floor(s / 86400); return `há ${d} ${d === 1 ? 'dia' : 'dias'}`; }
  return fmtDate(sqlDate.slice(0, 10));
}

function notificationHtml(n) {
  const who = `<a href="#/u/${esc(n.actor)}"><b>${esc(n.actor)}</b></a>`;
  const game = n.away_abbrev ? `${esc(n.away_abbrev)} @ ${esc(n.home_abbrev)}` : 'um jogo';
  const snippet = n.comment ? `<p class="n-snippet">“${esc(n.comment.length > 140 ? n.comment.slice(0, 140) + '…' : n.comment)}”</p>` : '';
  const text = {
    follow: `${who} começou a seguir você.`,
    like: `${who} curtiu sua review de <a href="#/review/${n.log_id}">${game}</a>.`,
    comment: `${who} comentou na sua review de <a href="#/review/${n.log_id}">${game}</a>.`,
    reply: `${who} também comentou na review de ${esc(n.log_owner)} sobre <a href="#/review/${n.log_id}">${game}</a>.`,
  }[n.type];
  const icon = { follow: '+', like: '♥', comment: '✎', reply: '✎' }[n.type];
  return `<li class="notification ${n.read_at ? '' : 'unread'}">
    <span class="n-icon n-${n.type}">${icon}</span>
    <div class="n-body">${text}${snippet}<span class="muted small">${timeAgo(n.created_at)}</span></div>
  </li>`;
}

async function viewNotifications() {
  if (!me) { location.hash = '#/entrar'; return; }
  $view.innerHTML = '<div class="loading">Carregando…</div>';
  const { items, unread } = await api('GET', '/api/notifications');
  $view.innerHTML = `
    <div class="notifications-page">
      <h1 style="margin-top:1.5rem">Notificações</h1>
      ${items.length ? `<ol class="notifications">${items.map(notificationHtml).join('')}</ol>`
        : '<p class="empty">Nada por aqui ainda. Quando alguém seguir você, curtir ou comentar suas reviews, aparece aqui.</p>'}
    </div>`;
  // Abrir a página marca tudo como lido; o destaque das novas fica até sair da tela.
  if (unread) {
    await api('POST', '/api/notifications/read');
    refreshBell();
  }
}

// ---------- roteador ----------

async function render() {
  const [, section, arg, sub] = location.hash.split('/');
  if (section !== 'entrar') returnTo = location.hash || '#/';
  try {
    if (section === 'jogo' && /^\d{10}$/.test(arg)) await viewGame(arg);
    else if (section === 'dia' && /^\d{4}-\d{2}-\d{2}$/.test(arg)) await viewSchedule(arg);
    else if (section === 'time' && TEAMS[arg]) await viewTeam(arg);
    else if (section === 'u' && arg && sub === 'rede') await viewNetwork(decodeURIComponent(arg));
    else if (section === 'u' && arg) await viewUser(decodeURIComponent(arg));
    else if (section === 'feed') await viewFeed();
    else if (section === 'notificacoes') await viewNotifications();
    else if (section === 'review' && /^\d+$/.test(arg)) await viewReview(arg);
    else if (section === 'lista' && /^\d+$/.test(arg)) await viewList(arg);
    else if (section === 'listas' && arg === 'nova') viewNewList();
    else if (section === 'comunidade') await viewCommunity();
    else if (section === 'entrar') viewAuth();
    else await viewSchedule(todayISO());
  } catch (e) {
    $view.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
  window.scrollTo(0, 0);
  if (section !== 'notificacoes') refreshBell();
}

window.addEventListener('hashchange', render);
({ user: me } = await api('GET', '/api/me').catch(() => ({ user: null })));
renderSession();
render();
