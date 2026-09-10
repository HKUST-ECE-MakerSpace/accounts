// Sends email through the org's Power Automate "send email" flow — the same
// flow the signups service uses (documented in the signups notes).
//
// Every send attempt (sent, blocked or failed) is logged to the console.
// Errors are logged and never thrown.
//
// MAIL_DEV + MAIL_DEV_EMAIL: dev safety gate. When MAIL_DEV is set, only mail
// addressed to MAIL_DEV_EMAIL is delivered; anything else is blocked and
// logged, and the full body (magic links included) is printed to the console
// instead of being sent. When unset, mail goes to any recipient and bodies
// are never logged — magic links are secrets.
//
// PA_MAIL_URL / PA_MAIL_TOKEN override the baked-in flow endpoint and shared
// token (used by tests and for rotating secrets without a code change).

const PA_MAIL_URL = process.env.PA_MAIL_URL ||
  'https://defaultc917f3e2932249269bb3daca730413.ca.environment.api.powerplatform.com:443/' +
  'powerautomate/automations/direct/cu/13/workflows/404e79ac853e4778afb2b32ff264d18a/' +
  'triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=D-TAhTfyrnXgxhAG--IvfURT2mE66GHxUWtlvwB9k5Y';
const PA_MAIL_TOKEN = process.env.PA_MAIL_TOKEN || '52Z9A3HGZrFK&HqK';

const DEV = !!process.env.MAIL_DEV;
const DEV_EMAIL = (process.env.MAIL_DEV_EMAIL || '').toLowerCase();
if (DEV && !DEV_EMAIL) {
  console.error('FATAL: MAIL_DEV is set but MAIL_DEV_EMAIL is not.');
  process.exit(1);
}

export async function sendEmail({ to, subject, body } = {}) {
  const toStr = String(to ?? '').trim();
  const subjectStr = String(subject ?? '');
  const bodyStr = String(body ?? '');

  if (!toStr) {
    console.log('[mail] blocked: no recipient');
    return { ok: false, reason: 'no_recipient' };
  }

  if (DEV) console.log(`[mail] MAIL_DEV body for ${toStr}:\n${bodyStr}`);

  if (DEV && toStr.toLowerCase() !== DEV_EMAIL) {
    console.log(`[mail] MAIL_DEV blocked send to ${toStr} (subject: "${subjectStr}")`);
    return { ok: false, reason: 'dev_gate', to: toStr };
  }

  try {
    const res = await fetch(PA_MAIL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: toStr,
        subject: subjectStr,
        body: bodyStr,
        token: PA_MAIL_TOKEN,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`[mail] sent to ${toStr} but flow returned ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, reason: 'flow_status', status: res.status };
    }
    console.log(`[mail] sent to ${toStr} | subject: "${subjectStr}"`);
    return { ok: true };
  } catch (e) {
    console.log(`[mail] error sending to ${toStr}: ${e.message}`);
    return { ok: false, reason: 'error', error: e.message };
  }
}
