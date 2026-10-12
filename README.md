# Minecraft Server

Paper Minecraft server running in Docker.

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Port **25565** open on your router

## Quick Start

```bash
# 1. Edit server settings
nano .env

# 2. Start the server (downloads Paper automatically on first run)
./scripts/start.sh

# 3. Watch startup logs
docker compose logs -f
```

## Common Commands

| Command | What it does |
|---|---|
| `./scripts/start.sh` | Start the server |
| `./scripts/stop.sh` | Stop the server (saves world) |
| `./scripts/backup.sh` | Back up the world |
| `./scripts/console.sh` | Open the server console (type MC commands) |
| `docker compose logs -f` | Stream live server logs |

## Configuration

All settings live in `.env`. Edit it and run `docker compose up -d` to apply changes.

## Connecting

### From the same machine (localhost)

1. Open Minecraft Java Edition
2. Click **Multiplayer** → **Add Server**
3. Set **Server Address** to `localhost`
4. Click **Done**, then join the server

### From the same network (LAN)

1. Find the host machine's local IP (`en0` for ethernet, `en1` for Wi-Fi):
   ```bash
   ipconfig getifaddr en1
   ```
2. Open Minecraft → **Multiplayer** → **Add Server**
3. Set **Server Address** to that IP (e.g. `192.168.1.42`)
4. Click **Done**, then join the server

### From outside the network

The server uses DuckDNS to maintain a stable hostname at `minecraft-with-friends.duckdns.org`. Port 25565 must be forwarded on the router to the host machine's local IP. Your ISP must also provide a dedicated public IP — if you're behind CGNAT (check your router's WAN IP; if it's in the `100.64.x.x` range, you are), call your ISP and ask to be moved off it.

1. Open Minecraft → **Multiplayer** → **Add Server**
2. Set **Server Address** to `minecraft-with-friends.duckdns.org`
3. Click **Done**, then join

## World Data

Everything lives in `./data/` — worlds, plugins, server.properties, etc. This folder is gitignored.

## Ops / Admin

Add your Minecraft username to `OPS=` in `.env`, then restart the server. In-game you can also run `/op <username>` from the console.

## Access control

The server runs in offline-mode (no Mojang auth) to support AI NPC bots, so access is gated by the **whitelist**: only usernames listed in `WHITELIST=` in `.env` can join. Add friends' Minecraft usernames there (comma-separated) and restart.

## AI NPC (Steve)

`Steve_AI` is a Claude Haiku-driven player you chat with ("steve, make an iron pickaxe", "build me a house", "follow me", "survive the night"). The v2 bot plans goals deterministically and runs them as background jobs, so it is fast and cheap; start it with `./scripts/botStart.sh`. Design: [ARCHITECTURE.md](ARCHITECTURE.md), [JOBS.md](JOBS.md), [SKILLS.md](SKILLS.md), [ROADMAP.md](ROADMAP.md).

**Benchmark:** `npm run eval` plays a scripted human against the bot on an isolated test server (`docker-compose.test.yml`, never the live one) and scores 31 core scenarios plus a stretch suite; see [v2/EVAL.md](v2/EVAL.md). `npm test` runs the unit tests.

## Why Docker, and not Apple's `container`

Evaluated September 2026 (`apple/container` 1.4.1, macOS 26.1, M4 Pro) and
**rejected**. Recorded here so it doesn't get re-litigated.

**The blocker: Apple's `container` can only publish ports to localhost.** Every
container gets an IP on a NAT'd, isolated `vmnet` subnet (`192.168.64.0/24`),
"reachable by that IP from the host and from other containers on the same
network" — and the publish section of [Apple's networking
docs](https://github.com/apple/container/blob/main/docs/networking.md) is titled
*"Forward traffic from `localhost` to your container."* Publishing is a
userspace forwarder bound to a loopback socket, not kernel NAT. There is no
bridged or macvlan mode; `container network create` only makes more isolated
private subnets.

That kills the setup described under [From outside the
network](#from-outside-the-network): the router would forward 25565 to this
Mac's LAN IP and hit nothing.

> This is **not** the same as the macOS 26.1 port-forwarding bug
> ([apple/container#919](https://github.com/apple/container/issues/919)) — that
> one was real, hit `container` 0.6.0, and is fixed. The loopback-only design is
> current on `main` and is not fixed by updating macOS.

**A `socat` TCP relay on the host would work** for Minecraft specifically (it's
TCP, one long-lived connection per player), but the server would then see every
player as connecting from the relay — breaking per-IP bans and making the logs
show a single address. Username whitelisting is unaffected.

**Secondary gaps:** no `--restart` flag (so no `restart: unless-stopped`), no
healthchecks (`mc-health` has nowhere to run), and no compose equivalent.

**There is no performance upside.** Both runtimes run the same arm64 Linux
image; tick rate is set by the JVM and the Aikar GC flags, not by the container
runtime. `container`'s headline win is sub-second cold start, which is a
dev-loop benefit — this server starts once and runs for weeks. Docker Desktop
idles at ~543 MB and 0.0% CPU with the container stopped, and quitting Docker
Desktop reclaims that without migrating anything.

**Revisit if** Apple ships bridged networking — that's the one gap without a
clean workaround. Everything else here is solvable.
