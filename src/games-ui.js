// Server-rendered pages for the mahjong points tracker (/track).
// Light cream/ink theme matching the signups service: center-aligned,
// sans-serif, every dynamic value esc()'d, small inline vanilla JS only.

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root{--felt:#1a5c34;--felt-dark:#124425;--ivory:#f8f6ee;--ink:#1c1c1c;--red:#c0392b;--gold:#a07d1c}
  *{box-sizing:border-box}
  body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
       background:var(--ivory);color:var(--ink);max-width:760px;margin:0 auto;
       padding:0 1rem max(2rem,env(safe-area-inset-bottom));text-align:center}
  .brand{background:linear-gradient(180deg,var(--felt) 0%,var(--felt-dark) 100%);color:var(--ivory);
         margin:0 -1rem;padding:.8rem 1rem .7rem;border-bottom:3px solid var(--red)}
  .brand h1{margin:.2rem 0;font-size:1.05rem;font-weight:600;letter-spacing:.02em}
  .brand .zh{color:#ffd9a8;font-size:.8rem;letter-spacing:.35em}
  .brand nav{margin-top:.35rem;font-size:.85rem}
  .brand a{color:var(--ivory);text-decoration:underline;text-underline-offset:2px}
  a{color:var(--felt)}
  a:hover{color:var(--red)}
  h2{margin:1.4rem auto .6rem}
  table{margin:1rem auto;border-collapse:collapse;background:#fff;border:1px solid #d8d1b8;
        border-radius:6px;box-shadow:0 1px 0 #fff inset,0 2px 4px rgba(28,28,28,.08)}
  th{background:var(--felt);color:var(--ivory);font-weight:600}
  td,th{border:1px solid #ccc;padding:.5rem .7rem;text-align:left}
  button{margin:.2rem;padding:.6rem 1.1rem;font:inherit;cursor:pointer;background:var(--felt);
         color:var(--ivory);border:1px solid var(--felt-dark);border-radius:6px;min-height:44px}
  button:hover{background:var(--felt-dark)}
  button.danger{background:var(--red);border-color:#8f2b20;min-height:40px}
  input,select,textarea{padding:.55rem;font-size:16px;border:1px solid #b8b096;border-radius:6px;background:#fff;
         width:100%;min-width:0;box-sizing:border-box}
  input[size="7"]{max-width:90px}
  .muted{color:#666}
  .dealer{color:var(--gold)}
  .danger{color:var(--red)}
  .twrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:1rem 0}
  .twrap table{margin:0 auto;min-width:420px}
  .brand nav a,.nav a{display:inline-block;padding:.45rem .4rem}
  @media (max-width:480px){
    .brand h1{font-size:.95rem}
    td,th{padding:.4rem .5rem}
  }
`;

const NAV = '<a href="/">accounts home</a> &middot; <a href="/track">tracker</a>';

function layout(title, body, script = '', nav = NAV) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1a5c34">
<title>${esc(title)}</title>
<title>${esc(title)} — HK Mahjong @ ECE MakerSpace</title>
<style>${STYLE}</style>
</head>
<body>
<header class="brand">
  <div class="zh">香港麻雀</div>
  <h1>HK Mahjong @ ECE MakerSpace</h1>
  <nav>${nav}</nav>
</header>
<h2>${esc(title)}</h2>
 ${body}
<footer class="muted" style="margin-top:2rem;font-size:.8rem">HKUST ECE MakerSpace &middot; points tracker</footer>
<script>${script}</script>
</body>`;
}

// leaderboard: [{ itsc, display_name, games, total, avg, best }] (sorted);
// games: [{ id, played_at, notes, players: [{ itsc, display_name, seat,
// is_dealer, score }] }] newest first; opts.isAdmin adds delete buttons.
export function pageTrack(leaderboard, games, opts = {}) {
  const lb = leaderboard.length === 0
    ? '<p class="muted">No games recorded yet.</p>'
    : `<div class="twrap"><table>
<tr><th>#</th><th>player</th><th>games</th><th>total</th><th>avg</th><th>best</th></tr>
${leaderboard.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.display_name)} <span class="muted">(${esc(r.itsc)})</span></td><td>${esc(r.games)}</td><td><b>${esc(r.total)}</b></td><td>${esc(r.avg)}</td><td>${esc(r.best)}</td></tr>`).join('\n')}
</table></div>`;

  const gl = games.length === 0
    ? '<p class="muted">No games recorded yet.</p>'
    : `<div class="twrap"><table>
<tr><th>game</th><th>players (seat order, &#9733; dealer)</th><th>notes</th><th></th></tr>
${games.map((g) => {
    const players = g.players
      .map((p) => `<span style="white-space:nowrap">${esc(p.display_name)} <b>${esc(p.score)}</b>${p.is_dealer === 1 ? ' <span class="dealer">&#9733;</span>' : ''}</span>`)
      .join(' &middot; ');
    const del = opts.isAdmin ? `<button class="danger del" data-id="${Number(g.id)}">delete</button>` : '';
    return `<tr><td>#${Number(g.id)}<br><span class="muted">${esc(String(g.played_at ?? '').slice(0, 16))}</span></td><td>${players}</td><td>${g.notes ? esc(g.notes) : '<span class="muted">&mdash;</span>'}</td><td>${del}</td></tr>`;
  }).join('\n')}
</table>`;

  const script = `
document.querySelectorAll('button.del').forEach(function(b){
  b.addEventListener('click',function(){
    if(!confirm('Delete game #'+b.dataset.id+'?'))return;
    fetch('/track/games/'+b.dataset.id+'/delete',{method:'POST'})
      .then(function(r){
        if(r.ok){location.reload();}
        else{r.json().then(function(j){alert('Delete failed: '+(j.error||r.status));});}
      });
  });
});`;

  return layout('Mahjong points tracker', `
<h3>Leaderboard</h3>
${lb}
<h3>Recent games</h3>
${gl}
<p><a href="/track/new">record a game</a></p>`, script);
}

export function pageTrackNew(user) {
  const rows = [0, 1, 2, 3].map((i) => `<tr>
<td class="muted">player ${i + 1}</td>
<td><input name="itsc${i + 1}" size="14" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="itsc"></td>
<td><input name="score${i + 1}" size="7" required inputmode="numeric" placeholder="0"></td>
</tr>`).join('\n');
  const dealerOpts = [0, 1, 2, 3].map((i) => `<option value="${i}">player ${i + 1}</option>`).join('');
  const script = `
var its=document.querySelectorAll('input[name^="itsc"]');
its.forEach(function(i){i.addEventListener('input',function(){i.value=i.value.trim().toLowerCase();});});
document.querySelector('form').addEventListener('submit',function(e){
  var v=[].map.call(its,function(i){return i.value.trim().toLowerCase();});
  if(v.indexOf('')>=0||new Set(v).size!==4){e.preventDefault();alert('Four distinct non-empty itsc logins are required.');}
});`;
  return layout('Record a game', `
<p class="muted">recording as ${esc(user.display_name)} (${esc(user.itsc)}) &middot; unknown itsc logins are auto-registered</p>
<form method="post" action="/track/new">
<div class="twrap"><table>
<tr><th></th><th>itsc login</th><th>score</th></tr>
${rows}
<tr><td class="muted">dealer</td><td colspan="2"><select name="dealer">${dealerOpts}</select></td></tr>
<tr><td class="muted">notes</td><td colspan="2"><input name="notes" size="32" placeholder="optional"></td></tr>
</table></div>
<button>record game</button>
</form>`, script, NAV + ' &middot; <a href="/track/new">record</a>');
}

export function pageCreated(gameId) {
  return layout('Game recorded', `
<p>Game <b>#${esc(gameId)}</b> recorded.</p>
<p><a href="/track">view leaderboard</a> &middot; <a href="/track/new">record another</a></p>`);
}
