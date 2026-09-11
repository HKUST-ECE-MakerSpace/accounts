# accounts

PIN-based account service for HKUST ECE MakerSpace internal tools. Node 24+,
**zero npm dependencies** (`node:http`, `node:crypto`, `node:sqlite`).

Users are identified by their ITSC login (`wli`) with canonical email
`<itsc>@connect.ust.hk`. Sign-in is a 4–8 digit PIN; password recovery and
account invites go through single-use magic links emailed via the org's
Power Automate flow (same as [signups](https://github.com/HKUST-ECE-MakerSpace/signups)).
Admins manage accounts at `/admin`. Self-service signup does not exist.
Admins can skip the invite email by entering the member's HKUST student ID:
the SID becomes their default PIN and `/me` nudges them to set a private one.

Other MakerSpace tools (the workshop tracker today) reuse this service's
session cookie for auth.

## run

```sh
node src/server.js            # or: npm start
# bind 127.0.0.1:3100, SQLite at ./data/accounts.db
```

Env vars:

| var | default | meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3100` / `127.0.0.1` | bind address (behind Caddy) |
| `DATA_DIR` | `./data` | SQLite lives at `$DATA_DIR/accounts.db` (WAL) |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | base URL magic links point at |
| `ADMIN_ITSCS` | *(empty)* | comma-separated ITSC logins that become admin on first login |
| `COOKIE_DOMAIN` | `.ecemaker.space` | session cookie Domain; set `""` for host-only (localhost dev) |
| `PA_MAIL_URL` / `PA_MAIL_TOKEN` | baked-in flow endpoint | Power Automate "send email" override (secret rotation, tests) |
| `MAIL_DEV` + `MAIL_DEV_EMAIL` | *(off)* | dev gate: only `MAIL_DEV_EMAIL` receives mail; everything else is blocked + the full body is printed to the log |

Never set `MAIL_DEV` on the server.

## endpoints

HTML: `GET /` (redirect), `GET/POST /login`, `POST /logout`, `GET /me`,
`GET/POST /forgot`, `GET/POST /reset?token=…`, `GET /admin`,
`POST /admin/users`, `POST /invite`, `POST /admin/users/:id/reset`,
`POST /admin/users/:id/deactivate`, `GET /healthz`.
JSON API: `GET /api/me`, `POST /api/login {itsc,pin}`, `POST /api/logout`.
`GET /track/*` is reserved for the workshop tracker.

Auth notes: PINs are scrypt-hashed (N=16384, per-user salt, `timingSafeEqual`
on verify; a dummy scrypt burns time for unknown accounts so responses don't
leak existence). 5 failed PINs per account per 15 minutes → HTTP 423. Session
tokens are 32 random bytes, only their SHA-256 is stored, cookie
`ms_session` (`HttpOnly; Secure; SameSite=Lax`, 30 days). Magic links are
single-use, expire after 30 minutes, and only hashes are stored. `/forgot`
always answers 200 with generic text and is rate-limited to 3/hour per
address. Mail bodies are never logged unless `MAIL_DEV` is set.

## test

```sh
npm test          # unit: node --test test/ (PIN hashing, lockout, sessions,
                  # magic tokens, rate limit, escaping, mailer w/ stubbed fetch)
./test/smoke.sh   # end-to-end: boots the real server on :3199 with a temp
                  # data dir and walks healthz → bad login → forgot → reset
                  # link → new PIN → login → /api/me → lockout
```

The smoke test never sends real mail: it runs with `MAIL_DEV=1` and the
Power Automate URL overridden to a dead port, then reads the magic link from
the server log.

## nixos

The flake provides a package and a NixOS module (`services.accounts`), the
same pattern as the other MakerSpace services. On the target host
(Ivy Bridge — no AVX2, so plain Node rather than bun) the module runs
`accounts-server` under systemd with `DynamicUser`, `StateDirectory=accounts`
and the usual hardening, and defines the Caddy vhost for `cfg.domain`.

```nix
# lab-nixos flake.nix
inputs.accounts = {
  url = "github:HKUST-ECE-MakerSpace/accounts";
  inputs.nixpkgs.follows = "nixpkgs";
};

# lab-nixos/features/accounts.nix
{ inputs, ... }: {
  imports = [ inputs.accounts.nixosModules.default ];

  services.accounts = {
    enable = true;
    adminItsces = [ "wli" ];
    # port = 3100;            # default
    # domain = "accounts.ecemaker.space";  # default
  };
}
```

Mail secrets are **not** in the nix store: drop an env file at
`/var/lib/accounts/env` (`EnvironmentFile`, optional) with any of:

```sh
PA_MAIL_URL=...          # only if the flow endpoint rotated
PA_MAIL_TOKEN=...        # only if the shared token rotated
MAIL_DEV=1               # NEVER on the server
MAIL_DEV_EMAIL=you@connect.ust.hk
```

`nix flake check` evaluates the flake (all 4 systems) and the module.

## license

MIT
