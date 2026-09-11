// Barebones server-rendered pages. Center-aligned, sans-serif, light mode
// only — same tone as the signups service. All dynamic values are
// HTML-escaped; the admin page uses a little inline vanilla JS + fetch
// (no reloads), everything else is plain forms and redirects.

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
       background:#fff;color:#111;max-width:760px;margin:2rem auto;padding:0 1rem;text-align:center}
  table{margin:1rem auto;border-collapse:collapse}
  td,th{border:1px solid #ccc;padding:.35rem .7rem;text-align:left}
  th{background:#f5f5f5}
  button{margin:.2rem;padding:.35rem .9rem;font:inherit;cursor:pointer}
  input{padding:.4rem;font-size:1rem;text-align:center}
  label{display:block;margin:.8rem 0 .2rem;font-size:.9rem;color:#444}
  form.inline{margin:1rem auto;max-width:320px}
  .row{display:flex;justify-content:center;gap:.25rem;align-items:center;flex-wrap:wrap}
  .muted{color:#666}
  .error{color:#a00}
  .ok{color:#1a5e1a}
  .chip{display:inline-block;font-size:.75rem;border-radius:999px;padding:.05rem .6rem;
        vertical-align:1px;margin-left:.4rem}
  .chip.admin{background:#eef2ff;color:#2a2a8a;border:1px solid #b9c2ec}
  .chip.on{background:#eef7ee;color:#1a5e1a;border:1px solid #b7dfb7}
  .chip.off{background:#fdeeee;color:#8a1f1f;border:1px solid #eabbbb}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;
       background:#eef1f4;border-radius:4px;padding:.05rem .3rem}
  #msg{margin:1rem auto;max-width:640px;min-height:1.2em;font-size:.9rem;color:#444;
       word-break:break-all}
  .nav{margin-top:2rem;font-size:.9rem}
`;

// Inline-script payload data: </script>-safe JSON (escapes every <).
const scriptJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

export function layout(title, body, script = '', nav = '') {
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

const fmtTime = (sec) => new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// ---- login / logout --------------------------------------------------------

export function pageLogin({ error = '', itsc = '' } = {}) {
  const body = `
<form method="post" action="/login" class="inline">
  <label for="itsc">ITSC login</label>
  <input id="itsc" name="itsc" autocomplete="username" required
         placeholder="itsc" value="${esc(itsc)}">
  <label for="pin">PIN (4–8 digits)</label>
  <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*"
         maxlength="8" autocomplete="current-password" required>
  <div><button type="submit">Sign in</button></div>
</form>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<p class="muted"><a href="/forgot">Forgot your PIN?</a></p>`;
  return layout('ECE MakerSpace accounts', body);
}

export function pageMe(user, sess) {
  const chips =
    (user.is_admin ? '<span class="chip admin">admin</span>' : '') +
    (user.must_set_pin ? '' : '<span class="chip on">PIN set</span>');
  const nudge = user.must_set_pin
    ? '<p class="muted">You\'re signed in with your student ID as your PIN. Set a PIN only you know.</p>'
    : '';
  const body = `
<p><b>${esc(user.display_name || user.itsc)}</b>${chips}</p>
${nudge}
<table>
  <tr><th>ITSC</th><td><code>${esc(user.itsc)}</code></td></tr>
  <tr><th>Email</th><td>${esc(user.itsc)}@connect.ust.hk</td></tr>
  <tr><th>Member since</th><td>${fmtTime(user.created_at)}</td></tr>
  <tr><th>Signed in</th><td>${fmtTime(sess.session_created_at)}</td></tr>
  <tr><th>Session expires</th><td>${fmtTime(sess.expires_at)}</td></tr>
</table>
<form method="post" action="/logout"><button type="submit">Sign out</button></form>`;
  return layout('Your MakerSpace account', body, '',
    '<a href="/">home</a> &middot; <a href="/track/">workshop tracker</a>');
}

// ---- forgot / reset --------------------------------------------------------

export function pageForgot({ error = '' } = {}) {
  const body = `
<p>Enter your ITSC login and we will email a reset link to your
<code>@connect.ust.hk</code> address.</p>
<form method="post" action="/forgot" class="inline">
  <label for="itsc">ITSC login</label>
  <input id="itsc" name="itsc" autocomplete="username" required placeholder="itsc">
  <div><button type="submit">Email me a reset link</button></div>
</form>
${error ? `<p class="error">${esc(error)}</p>` : ''}`;
  return layout('Forgot PIN', body, '', '<a href="/login">back to sign in</a>');
}

// Generic post-forgot page: identical whether or not the account exists
// (no user enumeration).
export function pageForgotSent() {
  const body = `
<p class="ok">If an account exists for that login, a reset link is on its way
to <code>@connect.ust.hk</code>.</p>
<p class="muted">The link works once and expires after 30 minutes.</p>`;
  return layout('Check your email', body, '', '<a href="/login">back to sign in</a>');
}

export function pageResetForm(token, { error = '' } = {}) {
  const body = `
<p>Choose a new PIN (4–8 digits). Setting it signs you in.</p>
<form method="post" action="/reset" class="inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <label for="pin">New PIN</label>
  <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*"
         maxlength="8" autocomplete="new-password" required>
  <label for="pin2">Repeat PIN</label>
  <input id="pin2" name="pin2" type="password" inputmode="numeric" pattern="[0-9]*"
         maxlength="8" autocomplete="new-password" required>
  <div><button type="submit">Save PIN and sign in</button></div>
</form>
${error ? `<p class="error">${esc(error)}</p>` : ''}`;
  return layout('Set your PIN', body);
}

export function pageResetInvalid() {
  const body = `
<p>This link is invalid, already used, or expired.</p>
<p>Request a fresh one from the <a href="/forgot">forgot PIN</a> page.</p>`;
  return layout('Link expired', body, '', '<a href="/login">back to sign in</a>');
}

// ---- admin -----------------------------------------------------------------

export function pageAdmin(users) {
  const rows = users.map((u) => {
    const status = u.active
      ? '<span class="chip on">active</span>'
      : '<span class="chip off">inactive</span>';
    const pin = u.pin_hash
      ? '<span class="chip on">PIN set</span>'
      : '<span class="chip off">no PIN</span>';
    const admin = u.is_admin ? '<span class="chip admin">admin</span>' : '';
    const actions = `
<button data-act="invite" data-itsc="${esc(u.itsc)}">invite</button>
<button data-act="reset" data-id="${u.id}">reset PIN</button>
${u.active ? `<button data-act="deactivate" data-id="${u.id}" data-name="${esc(u.itsc)}">deactivate</button>`
             : '<span class="muted">—</span>'}`;
    return `<tr>
  <td>${u.id}</td>
  <td><code>${esc(u.itsc)}</code></td>
  <td>${esc(u.display_name)}</td>
  <td>${admin}${status}${pin}</td>
  <td>${fmtTime(u.created_at)}</td>
  <td>${actions}</td>
</tr>`;
  }).join('\n');

  const body = `
<div id="msg" role="status"></div>
<form id="add-user" class="inline">
  <label for="itsc">ITSC login</label>
  <input id="itsc" name="itsc" required placeholder="itsc">
  <label for="sid">Student ID (optional — PIN defaults to it)</label>
  <input id="sid" name="student_id" inputmode="numeric" autocomplete="off" placeholder="8-10 digits">
  <label for="name">Display name</label>
  <input id="name" name="display_name" placeholder="optional">
  <div><button type="submit">Add user &amp; send invite</button></div>
</form>
<table>
  <tr><th>id</th><th>itsc</th><th>name</th><th>flags</th><th>created</th><th>actions</th></tr>
${rows || '<tr><td colspan="6" class="muted">no users yet</td></tr>'}
</table>
<p class="muted">“invite” (re)sends the set-PIN link · “reset PIN” emails a reset link ·
“deactivate” blocks sign-ins and kills sessions.</p>`;

  const script = `
const msg=document.getElementById('msg');
const show=(t)=>{msg.textContent=t;};
async function post(url,data){
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(data)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||j.ok===false){show('error: '+(j.error||r.status));return null;}
    show(j.link?('sent — invite link (also emailed): '+j.link):(j.message||'done'));
    return j;
  }catch(e){show('error: '+e.message);return null;}
}
document.querySelectorAll('button[data-act]').forEach((b)=>{
  b.onclick=async()=>{
    const a=b.dataset.act;
    if(a==='invite'){await post('/invite',{itsc:b.dataset.itsc});}
    else if(a==='reset'){await post('/admin/users/'+b.dataset.id+'/reset',{});}
    else if(a==='deactivate'){
      if(!confirm('deactivate '+b.dataset.name+'?'))return;
      const j=await post('/admin/users/'+b.dataset.id+'/deactivate',{});
      if(j)location.reload();
    }
  };
});
document.getElementById('add-user').onsubmit=async(e)=>{
  e.preventDefault();
  const f=e.target;
  const j=await post('/admin/users',{itsc:f.itsc.value,display_name:f.display_name.value,student_id:f.student_id.value});
  if(j){f.reset();location.reload();}
};`;
  return layout('Accounts admin', body, script, '<a href="/">home</a>');
}

// ---- generic ---------------------------------------------------------------

export function pageMessage(title, html, nav = '<a href="/login">sign in</a>') {
  return layout(title, html, '', nav);
}

export function page404() {
  return pageMessage('404', '<p>Nothing here.</p>', '<a href="/">home</a>');
}

export function pageForbidden() {
  return pageMessage('403', '<p>Admins only.</p>', '<a href="/">home</a>');
}

export function pageLocked() {
  return pageMessage('Account locked',
    '<p>Too many failed attempts. Try again in 15 minutes, or reset your PIN from the ' +
    '<a href="/forgot">forgot PIN</a> page.</p>');
}
