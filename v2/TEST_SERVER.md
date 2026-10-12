# v2 test server

Isolated Paper server for v2 development and the benchmark. **Never** point v2 work at the live server (`~/dev/minecraft-endeavours`, port 25565, container `minecraft-server`).

| | Live (v1, main checkout) | Test (v2 worktree) |
|---|---|---|
| Checkout | `~/dev/minecraft-endeavours` | `~/dev/minecraft-endeavours-v2` (branch `v2`) |
| Compose file / project | `docker-compose.yml` / dir name | `docker-compose.test.yml` / `mcv2test` |
| Container | `minecraft-server` | `mc-v2-test` |
| Game port | 25565 (public) | `127.0.0.1:25566` |
| RCON | inside container only | `127.0.0.1:25576` |
| Data dir | `./data` (live world + bot memory) | worktree `./data` (test world + `Steve_v2` memory) |
| Bot username | `Steve_AI` | `Steve_v2` |
| Whitelist | on | off (loopback only) |

## How the isolation works

The worktree's `.env` (gitignored, **non-secret**, no DuckDNS token) sets `COMPOSE_FILE=docker-compose.test.yml` and `COMPOSE_PROJECT_NAME=mcv2test`. So inside the worktree, `docker compose …` and `scripts/start.sh|stop.sh|console.sh|backup.sh` act on the test server only. `botStart.sh` / `botLogs.sh` / `dashboard.sh` read `MC_HOST`/`MC_PORT` from `.env`.

Recreate `.env` from scratch if lost:

```
COMPOSE_FILE=docker-compose.test.yml
COMPOSE_PROJECT_NAME=mcv2test
MC_VERSION=1.21.9
MEMORY=2G
MC_HOST=localhost
MC_PORT=25566
RCON_HOST=127.0.0.1
RCON_PORT=25576
RCON_PASSWORD=v2-test-local-only
DIFFICULTY=normal
LEVEL_SEED=-4172144997902289642
```

`MEMORY=2G` because the Docker VM has 8 GB and the live server takes 4G when up.

## Commands (run in the worktree)

```bash
./scripts/start.sh            # boot test server
./scripts/console.sh          # rcon-cli on the test server
./scripts/stop.sh
docker compose down && rm -rf data/world*   # wipe the TEST world only
```
