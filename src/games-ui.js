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
  body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
       background:#faf9f5;color:#1f1f1f;max-width:760px;margin:2rem auto;padding:0 1rem;text-align:center}
  a{color:#0366d6}
  table{margin:1rem auto;border-collapse:collapse}
  td,th{border:1px solid #ccc;padding:.35rem .7rem;text-align:left}
  th{background:#f0eee6}
  button{margin:.2rem;padding:.35rem .9rem;font:inherit;cursor:pointer}
  input,select,textarea{padding:.4rem;font-size:1rem}
  .muted{color:#666}
  .dealer{color:#7a5c00}
  .danger{color:#a11}
  .nav{margin-top:2rem;font-size:.9rem}
`;

const NAV = '<a href="/">home</a> &middot; <a href="/track">tracker</a>';

function layout(title, body, script = '', nav = NAV) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h2>${esc(title)}</h2>
${body}
<p class="nav">${nav}</p>
<script>${script}</script>
</body>
</html>`;
}

// leaderboard: [{ itsc, display_name, games, total, avg, best }] (sorted);
// games: [{ id, played_at, notes, players: [{ itsc, display_name, seat,
// is_dealer, score }] }] newest first; opts.isAdmin adds delete buttons.
export function pageTrack(leaderboard, games, opts = {}) {
  const lb = leaderboard.length === 0
    ? '<p class="muted">No games recorded yet.</p>'
    : `<table>
<tr><th>#</th><th>player</th><th>games</th><th>total</th><th>avg</th><th>best</th></tr>
${leaderboard.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.display_name)} <span class="muted">(${esc(r.itsc)})</span></td><td>${esc(r.games)}</td><td><b>${esc(r.total)}</b></td><td>${esc(r.avg)}</td><td>${esc(r.best)}</td></tr>`).join('\n')}
</table>`;

  const gl = games.length === 0
    ? '<p class="muted">No games recorded yet.</p>'
    : `<table>
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
<table>
<tr><th></th><th>itsc login</th><th>score</th></tr>
${rows}
<tr><td class="muted">dealer</td><td colspan="2"><select name="dealer">${dealerOpts}</select></td></tr>
<tr><td class="muted">notes</td><td colspan="2"><input name="notes" size="32" placeholder="optional"></td></tr>
</table>
<button>record game</button>
</form>`, script, NAV + ' &middot; <a href="/track/new">record</a>');
}

export function pageCreated(gameId) {
  return layout('Game recorded', `
<p>Game <b>#${esc(gameId)}</b> recorded.</p>
<p><a href="/track">view leaderboard</a> &middot; <a href="/track/new">record another</a></p>`);
}
