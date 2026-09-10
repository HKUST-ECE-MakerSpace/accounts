#!/usr/bin/env bash
# End-to-end smoke test. Boots the real server on 127.0.0.1:3199 with a
# throwaway data dir, seeds a user directly into SQLite, then walks:
#   healthz -> bad pin -> forgot (bogus + real) -> reset link (from the log)
#   -> set PIN -> single-use link -> login -> /api/me -> lockout after 5 pins.
#
# Mail runs with the MAIL_DEV gate on and the Power Automate URL overridden
# to a dead port, so nothing leaves the machine; the full email body (with
# the magic link) is printed to the server log instead, which is where the
# token below comes from.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=3199
BASE="http://127.0.0.1:$PORT"
ITSC=smokeadmin
EMAIL="$ITSC@connect.ust.hk"
DATA_DIR="$(mktemp -d)"
LOG="$(mktemp)"
HEADERS="$(mktemp)"
SRV=""

cleanup() {
  [ -n "$SRV" ] && kill "$SRV" 2>/dev/null
  [ -n "$SRV" ] && wait "$SRV" 2>/dev/null
  rm -rf "$DATA_DIR" "$LOG" "$HEADERS"
}
trap cleanup EXIT

post() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== boot server (MAIL_DEV=1, PA flow URL overridden to a dead port)"
MAIL_DEV=1 MAIL_DEV_EMAIL="$EMAIL" \
PA_MAIL_URL="http://127.0.0.1:9/unreachable-flow" PA_MAIL_TOKEN=smoke-token \
ADMIN_ITSCS="$ITSC" PORT="$PORT" HOST=127.0.0.1 DATA_DIR="$DATA_DIR" PUBLIC_BASE_URL="$BASE" \
  node src/server.js >"$LOG" 2>&1 &
SRV=$!

for _ in $(seq 1 50); do
  curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "== GET /healthz"
HEALTH="$(curl -fsS "$BASE/healthz")"
echo "$HEALTH"
[ "$HEALTH" = '{"ok":true}' ]

echo "== seed user '$ITSC' via direct SQLite insert (no PIN yet)"
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1] + "/accounts.db");
db.prepare("INSERT INTO users (itsc, display_name) VALUES (?, ?)").run(process.argv[2], "Smoke Admin");
console.log("seeded:", JSON.stringify(db.prepare("SELECT id, itsc FROM users").get()));
' "$DATA_DIR" "$ITSC"

echo "== POST /api/login with a wrong PIN -> 401"
CODE="$(post -X POST -H 'content-type: application/json' \
  -d '{"itsc":"'"$ITSC"'","pin":"0000"}' "$BASE/api/login")"
echo "got $CODE"
[ "$CODE" = 401 ]

echo "== POST /forgot for a bogus user -> still 200 (no user enumeration)"
CODE="$(post -X POST -d 'itsc=nosuchuser' "$BASE/forgot")"
echo "got $CODE"
[ "$CODE" = 200 ]

echo "== POST /forgot for the seeded user -> 200, link lands in the log"
CODE="$(post -X POST -d "itsc=$ITSC" "$BASE/forgot")"
echo "got $CODE"
[ "$CODE" = 200 ]
sleep 0.3
TOKEN="$(sed -n 's/.*\/reset?token=\([A-Za-z0-9_-]*\).*/\1/p' "$LOG" | tail -n 1)"
[ -n "$TOKEN" ] || { echo "FAIL: no reset token in server log"; exit 1; }
echo "extracted token from log: ${TOKEN:0:8}..."

echo "== GET /reset?token=... renders the set-PIN form"
PAGE="$(curl -fsS "$BASE/reset?token=$TOKEN")"
case "$PAGE" in *"Save PIN and sign in"*) echo "form OK" ;; *) echo "FAIL: form missing"; exit 1 ;; esac

echo "== POST /reset with mismatched PINs -> 400"
CODE="$(post -X POST --data-urlencode "token=$TOKEN" \
  --data-urlencode "pin=135790" --data-urlencode "pin2=111111" "$BASE/reset")"
echo "got $CODE"
[ "$CODE" = 400 ]

echo "== POST /reset with the new PIN -> 303 + session cookie"
CODE="$(post -D "$HEADERS" -X POST --data-urlencode "token=$TOKEN" \
  --data-urlencode "pin=135790" --data-urlencode "pin2=135790" "$BASE/reset")"
echo "got $CODE"
[ "$CODE" = 303 ]
COOKIE="$(sed -n 's/^[Ss]et-[Cc]ookie: \(.*\)$/\1/p' "$HEADERS" | head -n 1)"
[ -n "$COOKIE" ] || { echo "FAIL: no session cookie"; exit 1; }
case "$COOKIE" in
  *HttpOnly*Secure*"SameSite=Lax"*) echo "cookie flags OK (HttpOnly, Secure, SameSite=Lax)" ;;
  *) echo "FAIL: cookie flags wrong: $COOKIE"; exit 1 ;;
esac
echo "cookie: ${COOKIE%%;*}... (truncated)"

echo "== the link is single-use: GET /reset again -> 400"
CODE="$(post "$BASE/reset?token=$TOKEN")"
echo "got $CODE"
[ "$CODE" = 400 ]

echo "== POST /api/login with the new PIN -> 200, is_admin bootstrapped"
LOGIN="$(curl -fsS -D "$HEADERS" -X POST -H 'content-type: application/json' \
  -d '{"itsc":"'"$ITSC"'","pin":"135790"}' "$BASE/api/login")"
echo "$LOGIN"
case "$LOGIN" in *'"is_admin":true'*) echo "ADMIN_ITSCS bootstrap OK" ;; *) echo "FAIL: not admin"; exit 1 ;; esac
ME_COOKIE="$(sed -n 's/^[Ss]et-[Cc]ookie: \(ms_session=[^;]*\).*/\1/p' "$HEADERS" | head -n 1)"
[ -n "$ME_COOKIE" ] || { echo "FAIL: login set no cookie"; exit 1; }

echo "== GET /api/me with the session -> identity + must_set_pin=false"
ME="$(curl -fsS -H "Cookie: $ME_COOKIE" "$BASE/api/me")"
echo "$ME"
case "$ME" in *'"itsc":"'"$ITSC"'"'*'"must_set_pin":false'*) echo "me OK" ;; *) echo "FAIL: bad /api/me body"; exit 1 ;; esac

echo "== lockout: 5 bad PINs give 401, the 6th attempt gives 423"
for _ in 1 2 3 4 5; do
  CODE="$(post -X POST -H 'content-type: application/json' \
    -d '{"itsc":"'"$ITSC"'","pin":"99999"}' "$BASE/api/login")"
  [ "$CODE" = 401 ] || { echo "FAIL: expected 401 during lockout ramp, got $CODE"; exit 1; }
done
CODE="$(post -X POST -H 'content-type: application/json' \
  -d '{"itsc":"'"$ITSC"'","pin":"99999"}' "$BASE/api/login")"
echo "6th attempt got $CODE"
[ "$CODE" = 423 ]

echo
echo "ALL SMOKE CHECKS PASSED"
