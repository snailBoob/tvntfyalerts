# TV ntfy Alerts

**Your own TradingView alerts. Instantly forwarded to ntfy.**

Forward existing TradingView price alerts to your own ntfy server, even when your
browser is closed. No webhooks, alert polling, email, database or embedded browser.

The app listens to TradingView's private WebSocket using your session cookies.
This is **not an officially supported TradingView integration**: protocol or
authentication changes may require an update. No automatic TradingView login is provided.

## Supported platforms

Image: **`ghcr.io/snailboob/tvntfyalerts:1.0.0`**

| Platform | Image architecture |
| --- | --- |
| Intel/AMD Synology or other x86-64 Docker host | `linux/amd64` |
| Raspberry Pi with a **64-bit OS**, or another ARM64 Docker host | `linux/arm64` |

Docker selects the appropriate architecture automatically. These images do not
support 32-bit Raspberry Pi OS. Both architectures are built and smoke-tested
on native GitHub runners. Live forwarding was verified on an Intel Synology;
physical Raspberry Pi hardware has not been tested.

## Quick start: existing ntfy server

Download `compose.yml` and `docker.env.example` from the
[latest release](https://github.com/snailBoob/tvntfyalerts/releases/latest),
and place them in one project directory.

```sh
cp -n docker.env.example docker.env
chmod 600 docker.env
```

Edit `docker.env` using a text editor. On macOS, `open -e docker.env` opens it
in TextEdit. Set these values:

```dotenv
APP_BIND=0.0.0.0
APP_PORT=3080
PUBLIC_URL=http://YOUR-DOCKER-HOST:3080
NTFY_URL=https://YOUR-NTFY-SERVER
NTFY_TOPIC=tradingview-alerts
NTFY_TOKEN=
```

- `PUBLIC_URL` is the address of **this app's settings page**, reachable from
  your browser or phone. It is also used by **Open settings** notifications.
- `NTFY_URL` is the ntfy **base URL without the topic**.
- Set `NTFY_TOKEN` only if your server requires authentication. Do not include
  the `Bearer` prefix. Keep credentials out of shell commands, logs and Git.
- For a Mac-only test, use `APP_BIND=127.0.0.1` and `PUBLIC_URL=http://localhost:3080`.

Start the app:

```sh
docker compose --env-file docker.env config --quiet
docker compose --env-file docker.env up -d
docker compose --env-file docker.env ps
```

Subscribe to your topic in an ntfy client. Open the settings page and enter
your TradingView cookies as described below. You do not need to wait for a
notification to access the page.

### ntfy already runs on the same NAS

Use its existing Docker network to avoid routing through the NAS's public
hostname or published host port. **The ntfy container does not need to change.**

Find its network name in Container Manager under the ntfy container's details.
Download `compose.existing-ntfy.yml` alongside `compose.yml` and set:

```dotenv
NTFY_NETWORK=ntfy_default
NTFY_INTERNAL_URL=http://ntfy:80
```

Replace the network and hostname if yours differ. Keep `NTFY_URL` populated
in `docker.env`; the overlay replaces it with `NTFY_INTERNAL_URL`.

```sh
docker compose --env-file docker.env -f compose.yml -f compose.existing-ntfy.yml up -d
```

Use both `-f` arguments for subsequent commands. The app connects to ntfy
through Docker; your phone continues to use ntfy's usual browser/LAN address.
Do not try to open `http://ntfy:80` on your phone.

### No ntfy server yet

Download `compose.ntfy.yml`. It starts an optional ntfy service in the same project:

```sh
docker compose --env-file docker.env -f compose.yml -f compose.ntfy.yml up -d
```

This overlay sets the app destination to `http://ntfy:80` and clears its token.
The default ntfy browser address is `http://localhost:8080`. For LAN access, set
`NTFY_BIND=0.0.0.0` and `NTFY_PUBLIC_URL=http://YOUR-DOCKER-HOST:8080`.
Subscribe to `tradingview-alerts` there before connecting TradingView.

This example permits anonymous publishing and reading and is intended for a
trusted LAN. For authentication, use an existing configured server or follow
[ntfy's authentication guide](https://docs.ntfy.sh/config/#authentication).
For self-hosted iOS background push, follow the
[iOS configuration guide](https://docs.ntfy.sh/config/#ios-instant-notifications).
The basic example does not configure an upstream push server.

Use **either** the existing-network overlay **or** the bundled-server overlay.

## Synology Container Manager

1. Create a project folder, for example `/volume1/docker/tv-ntfy`.
2. Download `compose.yml` into it. Copy `docker.env.example` to **`.env`** in
   the same folder, and edit it with your NAS address and ntfy settings.
   The Project UI uses `.env` automatically; CLI examples use `--env-file docker.env`.
3. In **Container Manager → Project → Create**, select that directory and YAML.
4. Keep the same project name when updating so the same data volume is reused.
5. Open `PUBLIC_URL`, subscribe to the ntfy topic and connect TradingView.

For an existing ntfy container, the following complete YAML can be pasted into
the Project UI. Replace the NAS address and network name with your values:

```yaml
services:
  app:
    container_name: tv-ntfy
    image: ghcr.io/snailboob/tvntfyalerts:1.0.0
    init: true
    restart: unless-stopped
    stop_grace_period: 20s
    ports:
      - "3080:3080"
    environment:
      HOST: "0.0.0.0"
      PORT: "3080"
      PUBLIC_URL: "http://YOUR-NAS-IP:3080"
      NTFY_URL: "http://ntfy:80"
      NTFY_TOPIC: "tradingview-alerts"
      NTFY_TOKEN: ""
    volumes:
      - app-state:/state
    networks:
      - ntfy-network
volumes:
  app-state:
networks:
  ntfy-network:
    external: true
    name: ntfy_default
```

### Offline image import

Release downloads include an image archive for each architecture and `SHA256SUMS`.
For Intel/AMD Synology, download `tvntfyalerts-1.0.0-linux-amd64.tar.gz`,
decompress it to `.tar`, then use **Image → Add → Add From File**.
The imported image is tagged `ghcr.io/snailboob/tvntfyalerts:1.0.0`, matching the YAML.

For a 64-bit Raspberry Pi, use the `linux-arm64.tar.gz` archive:

```sh
docker load -i tvntfyalerts-1.0.0-linux-arm64.tar.gz
docker compose --env-file docker.env up -d --pull never
```

The optional ntfy server image is not included in the app archive; it must be
pulled separately if using the bundled-server overlay.

## TradingView cookies

1. Open [TradingView](https://www.tradingview.com/chart/) in Brave or Chrome and sign in.
2. Open Developer Tools with **F12** or the browser menu.
3. Select **Application → Storage → Cookies**, then TradingView.
4. Copy the **Value** of `sessionid` and `sessionid_sign` to the matching fields
   on this app's settings page. Do not decode values or include cookie names.
5. Click **Connect**.

The app verifies the chart page and WebSocket before saving the cookies. Failed
verification preserves existing cookies. Saved cookies are never returned to
the browser, so **empty form fields after reopening are normal**.

The status **Connected to TradingView** confirms the WebSocket connection, not
ntfy delivery. Check the received notification and trigger one real price alert
to verify the full flow. You can then close the page; keep the container running.
Run only one active relay for the same TradingView session/topic to avoid duplicates.

The settings page has no login. Use it on a trusted LAN, through an SSH tunnel,
or behind your own authenticated HTTPS access layer. Do not expose it directly
to the internet. Only localhost and the configured `PUBLIC_URL` origin are accepted.

## Notifications

- Every app start sends **TV ntfy started**, even without TradingView cookies.
  This confirms ntfy delivery only. It has no action button.
- Price alerts retain the exact original text, use the received exchange/ticker
  as title, and include a **TradingView** button to the matching chart.
- A TradingView PNG icon is included. Custom ntfy icons are currently supported
  on Android, not in the ntfy web message cards.
- Connection notifications cover connected, sustained outage, recovery and
  confirmed invalid session. Temporary network failures reconnect automatically.
- **Only a confirmed invalid session** includes **Open settings**, using
  `PUBLIC_URL`. Open it, replace both cookies and reconnect.
- There is no whole-notification click action on price alerts.

The settings footer shows the configured ntfy destination. In a shared Docker
network that can be an internal address; it is not a link for your phone.

## Configuration and persistent data

| Setting | Purpose |
| --- | --- |
| `NTFY_URL` | ntfy base URL. Configure explicitly; direct Node.js fallback is `https://ntfy.sh`. |
| `NTFY_TOPIC` | Case-sensitive topic; defaults to `tradingview-alerts`. |
| `NTFY_TOKEN` | Optional access token without `Bearer`. |
| `PUBLIC_URL` | Settings-page origin, including any external port. No path, query or fragment. |
| `HOST` / `PORT` | Inside Docker: `0.0.0.0` / `3080`. |
| `APP_BIND` / `APP_PORT` | Compose's host interface and published port. |

Create an ntfy token through **Account → Access tokens** when account management
is enabled, or ask the server administrator to use `ntfy token add`. Its user
needs write permission for the topic. Subscribing clients also need read access
when the topic is protected. Change deployment settings in your env/YAML file
and recreate the container to apply them.

The `app-state` named volume mounts at `/state`. It contains:

- `.env`: verified TradingView cookies, mode `600`.
- `data/seen.json`: the last 10,000 delivered trigger IDs, not alert text.

Data survives container restarts and recreation **with the same volume**. No
extra data folder appears inside your NAS project folder: Docker manages it.
Do not use `docker compose down -v` unless you intend to delete saved state.
Do not pass `TV_SESSIONID` variables through Compose: environment variables
would override newer cookies saved through the settings page.

For a bind mount, mount the entire directory and make it writable by UID/GID
`1000:1000`. Do not mount `.env` as an individual file: saves use atomic rename.
Back up the volume with the app stopped; keep backups private and preserve
ownership on restore. Image exports contain neither saved state nor deployment tokens.

### Updating and rollback

Keep the project name, volume and settings unchanged. Set the image to the
desired version, pull it and recreate the app:

```sh
docker compose --env-file docker.env pull app
docker compose --env-file docker.env up -d --no-deps app
```

Include overlay arguments if applicable. A restart alone keeps the old image.
An update briefly interrupts the relay; missed alerts may not be replayed.
Keep the previous image and a volume backup before updating. To roll back,
restore the previous image reference and recreate with the same volume, or
restore its matching backup if a future release requires a data migration.

## Diagnostics

```sh
docker compose --env-file docker.env logs --tail=100 app
```

In Synology, use the container's **Log** tab. Logs have UTC timestamps and
`INFO`, `WARN` or `ERROR` levels. They cover startup/shutdown, connection changes,
retry delays, heartbeat failures, ntfy delivery errors/recovery and persistence errors.
Recognized DNS, routing, timeout and TLS failures include a safe diagnostic code.
HTTP redirects are reported without following them. Cookies, tokens, private
channels, tickers, alert text and raw remote error bodies are never logged.

| Symptom | Check |
| --- | --- |
| ntfy timeout on the same NAS | Join its existing Docker network and use `http://ntfy:80`; public/host routes may not be reachable from the app container. |
| DNS error | Container DNS, server hostname and shared network membership. |
| HTTP 401/403 | Token and permission to publish to the selected topic. |
| TLS error | Certificate chain, hostname and clock; do not disable certificate verification. |
| Connected but no phone notification | Server/topic subscription, client permissions, and delivery errors on the settings page. |
| Settings address rejected | Exact `PUBLIC_URL` origin, including port; recreate after changing it. |
| Session rejected | Both cookies from the same active TradingView session. |
| Persistence error | Free disk space and volume ownership. |

The Docker health check checks the settings API, not TradingView or ntfy.
A recovery log means a **new** notification was accepted, not that a failed
notification was replayed. No per-alert success logs are emitted.

## Reliability limits

- WebSocket ping/pong detects a stalled connection. Reconnect backoff increases
  to about a minute with jitter, obtaining a fresh private channel each time.
- Outages lasting more than a minute produce one notice and one recovery notice.
- A confirmed invalid session stops reconnect attempts until cookies are replaced.
- Duplicate trigger IDs are suppressed, including across restart. A new trigger
  ID with identical message text is still a new alert.
- Known HTTP 429/5xx failures get at most three attempts. Network timeouts are
  not blindly retried because delivery may already have happened.
- Pending notifications live in memory. Failed alerts have no durable retry queue.
- Exactly-once delivery is not guaranteed across a crash between ntfy acceptance
  and local persistence. Replay during a disconnected period is not established;
  there is no HTTP catch-up mechanism.

## Build locally or run without Docker

From the source checkout, with Docker Desktop or Docker Engine running:

```sh
docker buildx build --platform linux/amd64 --load -t tv-ntfy:local .
```

Use `linux/arm64` for a 64-bit Raspberry Pi. Tests run during the build. Runtime
permissions are normalized, then imports, static assets and atomic state writes
are checked as the non-root container user.

To run your local image, add `-f compose.build.yml` after `-f compose.yml`:

```sh
docker compose --env-file docker.env -f compose.yml -f compose.build.yml up -d --build
```

Without Docker, use Node.js 20.12+ (the image uses Node.js 24):

```sh
npm ci
cp -n .env.example .env
chmod 600 .env
```

Edit `.env` with your ntfy settings, leave the cookie fields empty initially,
then run `npm start`. The default local settings address is `http://localhost:3080`.
Keep the process running; stop it with Ctrl+C. Existing environment variables
take precedence over `.env`. Do not run both a local and Docker relay concurrently
against the same session/topic.

### Verification and releases

```sh
npm run check
npm test
bash scripts/docker-smoke.sh tv-ntfy:local
```

Tests use synthetic fixtures. The smoke test uses isolated Docker containers and
an internal network, checks startup delivery and recreates the app to verify
persistence. It sends no real TradingView traffic and cleans up its own resources.

GitHub Actions runs only for explicit version tags in the public repository
(or a manual run on a version tag). Native `amd64` and `arm64` builds run the
tests and smoke checks before publishing candidates. After both pass, the same
images are combined into a multi-platform tag and exported as release assets.
Intermediate build artifacts expire after three days; versioned release images
and downloads remain available for installation and rollback.

### Optional protocol probe

`npm run probe` uses local `.env` cookies to capture one real `alert_fired`
payload in ignored `debug/alert-fired.json`, mode `600`. It waits up to ten
minutes plus connection setup, does not overwrite existing recordings and does
not publish to ntfy. Captures may contain private alert text or URLs; do not share
them unredacted. Never enable `NODE_DEBUG` with live credentials.

References: [ntfy publishing](https://docs.ntfy.sh/publish/) and
[TradingView chart](https://www.tradingview.com/chart/).
