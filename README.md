# Minecraft Server

Paper Minecraft server running in Docker.

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Port **25565** open on your router (for friends outside your local network)

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

### From outside the network (friends over the internet)

The server uses DuckDNS to maintain a stable hostname at `minecraft-with-friends.duckdns.org`. Port 25565 must be forwarded on the router to the host machine's local IP. Your ISP must also provide a dedicated public IP — if you're behind CGNAT (check your router's WAN IP; if it's in the `100.64.x.x` range, you are), call your ISP and ask to be moved off it.

1. Friends open Minecraft → **Multiplayer** → **Add Server**
2. Set **Server Address** to `minecraft-with-friends.duckdns.org`
3. Click **Done**, then join

## World Data

Everything lives in `./data/` — worlds, plugins, server.properties, etc. This folder is gitignored.

## Ops / Admin

Add your Minecraft username to `OPS=` in `.env`, then restart the server. In-game you can also run `/op <username>` from the console.
