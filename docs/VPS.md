# Running on a VPS

The defaults suit a home server on a LAN. On a VPS everything is reachable from the internet, so
use the settings below. The app's own protections apply everywhere: mandatory TOTP for owners and
editors, account lockout after 10 failed sign-ins, per-address login limits in the api and in nginx,
`SameSite=Strict` HttpOnly session cookies, CSRF tokens, a strict CSP and an audit log of every
admin action.

## 1. Keep the admin panel off the public port

```bash
# deploy/.env
PUBLIC_HOST=video.example.com
PUBLIC_SCHEME=https
ADMIN_LISTENER=private      # /admin, /api/admin and /metrics only on the private admin port
ADMIN_BIND=127.0.0.1        # private admin port on loopback only (default)
ADMIN_PORT=8081
ADMIN_SESSION_IDLE_MINUTES=120
```

With `ADMIN_LISTENER=private`, nginx answers 404 for every admin path on ports 80/443. The api also
refuses admin requests that nginx did not receive on the private listener. The admin network
allowlist (`ADMIN_ALLOW_CIDRS`) still applies on the private port.

Open the panel through an SSH tunnel:

```bash
ssh -N -L 8081:127.0.0.1:8081 you@video.example.com
```

Then browse to `http://127.0.0.1:8081/admin/`. The tunnel encrypts the traffic. Over plain HTTP on
the private port the session cookie is sent without the `Secure` flag, because not every browser
stores Secure cookies for `http://127.0.0.1`.

If you use a VPN instead (WireGuard or Tailscale), set `ADMIN_BIND` to the VPS's VPN address (for
example `100.101.102.103`). Make sure `ADMIN_ALLOW_CIDRS` covers the VPN range: CGNAT `100.64.0.0/10`
(Tailscale) is in the default list.

**Never set `ADMIN_ALLOW_CIDRS=0.0.0.0/0`** with `ADMIN_LISTENER=public`. The api logs a warning at
startup and the System page shows it. Also avoid `ADMIN_LISTENER=public` on a VPS even with the
default private ranges. Docker's userland proxy (used, for example, for IPv6 connections to an
IPv4-only container network) makes internet clients appear to nginx as the Docker gateway
`172.x.0.1`, which is inside the default allowlist.

## 2. TLS

Put `fullchain.pem` and `privkey.pem` in `deploy/tls/` and set `PUBLIC_SCHEME=https`. Options:

- certbot with a DNS challenge (no downtime), or `certbot certonly --standalone` while nginx is
  stopped, then copy or link the files and `docker compose restart nginx`.
- A reverse proxy in front (Caddy, Traefik) that terminates TLS. Set `HTTP_BIND=127.0.0.1` and
  `EDGE_TRUSTED_PROXIES=127.0.0.1/32`. Keep `ADMIN_LISTENER=private`: the proxy only needs ports
  80/443.

nginx sends HSTS once TLS is enabled.

## 3. Firewall and host

- Docker publishes ports past `ufw`/`firewalld` rules, so rely on the bind addresses. 80/443 are
  public by design, the admin port binds to `ADMIN_BIND`, and postgres and the api are not published
  at all. Check with `ss -tlnp`.
- In the host firewall, allow 22 (SSH), 80 and 443, plus the VPN port if you use one. Drop
  everything else.
- SSH: keys only (`PasswordAuthentication no`) and `PermitRootLogin no`. Consider `fail2ban` for
  sshd.
- Turn on unattended security updates (`unattended-upgrades` on Debian/Ubuntu). Update the app as
  described in the README.
- Keep `deploy/.env` readable only by root (`chmod 600`). It holds the signing and encryption keys.

## 4. Accounts and alerts

- Add at least one notification channel (ntfy, email or webhook). Owners get an alert when someone
  signs in from an address with no sign-in in the last 90 days, and when an account is locked
  after repeated wrong passwords.
- Sensitive owner actions ask for the password and TOTP code again when the last check is older
  than `ADMIN_REAUTH_MINUTES` (default 10). These actions are user management, API tokens,
  notification channels, settings, and GDPR export and erase. Five wrong attempts end the session.
- **Settings → My account** lists signed-in devices. Sign out anything you do not recognise, then
  change your password.
- Give people the `viewer` role unless they need to edit. API tokens are read-only.
- Store the TOTP secret in an authenticator app with a backup. If a device is lost, the operator CLI
  resets TOTP (`reset-totp`; see the README).

## 5. Backups

The nightly `pg_dump` lands in `BACKUP_DIR` on the same machine. Copy it off the VPS (restic, borg,
rclone) together with `MEDIA_DIR` and `deploy/.env`, and test a restore (`deploy/RESTORE.md`).
