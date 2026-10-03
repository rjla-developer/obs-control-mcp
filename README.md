# obs-control-mcp

An [MCP](https://modelcontextprotocol.io) server to inspect and **safely** control
[OBS Studio](https://obsproject.com) over **obs-websocket v5** — built for people
who let an AI assistant near the OBS they stream with.

- **Read everything**: version and performance stats, scenes, inputs and their
  settings, filters with their settings, stream/recording status, output paths,
  video settings.
- **Change things only on purpose**: every tool that changes OBS is a dry run
  unless you say otherwise, and a **live guard** refuses changes while OBS is
  streaming or recording unless you explicitly confirm.
- **«¿Listo para grabar?»** — a readiness check for the
  [Source Record](https://github.com/exeldro/obs-source-record) plugin.
- **Scene timeline** — a JSON-lines log of which scene was on program, and when,
  so you can cut clips from a VOD later.
- **No secrets in logs or outputs** — tested.

> [Leer en español](#en-español)

## Safety design

| Risk | What this server does |
|---|---|
| A change shows up in front of your audience | Write tools default to `dry_run=true` and return what *would* change (a before/after diff). While OBS is streaming or recording, a real change is refused unless `confirmLive=true`. The live state is read from OBS right before applying. |
| The password ends up in a log | The password is read from a file (or an env var that is deleted once read). Every log line and every tool result passes through a scrubber that removes it. `DEBUG` is cleared before `obs-websocket-js` loads (its debug output prints every incoming message, stream keys included). The test suite runs the real process with `DEBUG=*` and fails if a password or stream key appears anywhere. |
| Stream keys, tokens and widget URLs leak through settings | Fields that look like credentials (`key`, `stream_key`, `password`, `token`, `bearer_token`, ...) are shown as `[redacted]`; URLs are cut down to their origin (alert-box URLs carry their token in the path). Dry-run diffs of secret fields are redacted too. |
| A redacted value is written back | Settings containing the `[redacted]` placeholder are refused, so a stream key cannot be overwritten with it. |
| You only want to look | `OBS_READ_ONLY=1` registers only the read tools. |
| Secrets committed to this public repo | `scripts/check-secrets.mjs` runs as a pre-commit hook, in CI and in the test suite: it blocks IP addresses, home-directory paths, e-mail addresses, private keys and token formats. |

## Tools

**Read** (never change OBS)

| Tool | What it returns |
|---|---|
| `get_overview` | OBS / obs-websocket version, CPU, memory, free disk, fps, skipped frames, stream/record state, current scene, profile, scene collection, video settings, recording folder |
| `list_scenes` | Scenes top to bottom, the program (and preview) scene, the sources in each |
| `list_inputs` | Inputs and their kinds; optionally their settings (OBS defaults filled in) |
| `get_input_settings` | One input's settings, which fields differ from the defaults, mute state |
| `list_filters` | Filters of one source or of all, top to bottom, with settings |
| `get_outputs` | Stream, recording, replay buffer, virtual camera, recording folder, every output, stream service (key redacted) |
| `get_video_settings` | Canvas and output resolution, fps |
| `check_source_record` | Source Record readiness verdict (see below) |
| `read_timeline` | Scene timeline summary; what was live at a time or at a second of a stream |

**Write** (guarded: `dry_run` defaults to `true`; `confirmLive=true` required while live)

| Tool | What it does |
|---|---|
| `switch_scene` | Puts a scene on program |
| `set_filter_settings` | Changes filter settings (Source Record included), merge or replace |
| `set_filter_enabled` | Turns a filter on or off |
| `set_filter_index` | Moves a filter in the chain (shows the order before/after) |
| `start_record` / `stop_record` | Starts / stops the main recording |
| `set_input_settings` | Changes input settings, merge or replace |

## Source Record readiness check

`check_source_record` (or `obs-control-mcp check` on the command line) finds every
`source_record_filter` and checks, for each one:

- the filter is enabled and its **record mode** (none / always / streaming /
  recording / streaming or recording / virtual camera), and whether it is
  writing a file right now;
- **encoder**, **rate control** and the **QP/CQP/CRF** actually in use (when the
  filter does not set it, the encoder's OBS default), or the bitrate;
- **scaling** and resolution, **frame rate** (divisor) against the canvas fps;
- **file names**: two filters writing to the same folder with the same format
  collide (they start in the same second); formats without date/time codes;
- **output folder** and **container** (`mp4`/`mov` are lost if OBS crashes;
  `hybrid_mp4`, `mkv` and fragmented formats are not);
- **audio**: own sound, another source (exists? muted?) or a mixer track;
  sources with no audio of their own (screen capture) give a silent file;
- **filter order**: masks, crops and keys *above* Source Record are baked into
  the file; below it they stay out;
- capture devices with **«Deactivate when not showing»**;

and globally: **free disk** (`GetStats.availableDiskSpace`, with an hours
estimate when bitrates are known), render fps vs canvas fps, lagged frames,
number of simultaneous encoders, and whether OBS is streaming/recording.

The verdict is `ready`, `ready_with_warnings`, `not_ready` or
`no_source_record_filters`, with a Spanish one-liner (`veredicto`). The command
line exits 0 / 1 / 2 accordingly (3 on connection errors).

## Scene timeline

When `OBS_TIMELINE_FILE` is set, the server subscribes to OBS events and appends
one JSON object per line:

```json
{"t":"2026-01-01T20:02:00.000Z","type":"event","event":"CurrentProgramSceneChanged","data":{"sceneName":"Main"}}
```

Recorded: program/preview scene changes, stream / recording / replay buffer /
virtual camera state, scene item visibility (with the source name), filter and
input creation, renames, enable state and settings changes (redacted), mutes.
After every (re)connection it writes a snapshot of the current scene and outputs,
including how long the stream has been running, so offsets stay on the stream's
clock after a reconnect.

`read_timeline` turns it into scene segments (split where the stream/recording
starts or stops) with `streamOffsetSec` — seconds into the stream, which is the
VOD timestamp — time per scene, stream and recording sessions, and answers
“what was live at …” (`at`) or “at second N of the stream” (`atStreamOffsetSec`).

Only one process records a given file (a pid lock). To record without an MCP
client running, use `obs-control-mcp timeline`. The file grows by a few hundred
lines per stream; rotate or delete it as you see fit — nothing else reads it.

## Install

Requires Node.js ≥ 22.18 and OBS 28+ (obs-websocket 5 is built in: *Tools →
WebSocket Server Settings*).

```bash
git clone https://github.com/rjla-developer/obs-control-mcp.git
cd obs-control-mcp
npm ci && npm run build
```

### Configuration (environment only)

| Variable | Default | |
|---|---|---|
| `OBS_HOST` | `127.0.0.1` | Host name or IP of the OBS machine (no scheme, no port) |
| `OBS_PORT` | `4455` | |
| `OBS_PASSWORD_FILE` | — | File whose first line is the password (**preferred**; `chmod 600`) |
| `OBS_PASSWORD` | — | The password itself; removed from the environment once read |
| `OBS_TIMELINE_FILE` | — | JSON-lines timeline file; enables recording and `read_timeline` |
| `OBS_TIMELINE_RECORD` | `1` | `0`: the server only reads the timeline |
| `OBS_READ_ONLY` | `0` | `1`: register only the read tools |
| `OBS_CONNECT_TIMEOUT_MS` | `5000` | |

### Claude Code

Keep the password out of the client's config: point the client at a small
launcher that sets the variables, and let the server read the password file.

```bash
cat > ~/obs-control.sh <<'SH'
#!/usr/bin/env bash
export OBS_HOST=192.0.2.10 OBS_PORT=4455
export OBS_PASSWORD_FILE="$HOME/.config/obs-control/password"
export OBS_TIMELINE_FILE="$HOME/.local/share/obs-control/timeline.jsonl"
exec node /path/to/obs-control-mcp/dist/cli.js "$@"
SH
chmod 700 ~/obs-control.sh
claude mcp add obs-control -s user -- ~/obs-control.sh
```

Other MCP clients: run `node dist/cli.js` over stdio with the same variables.

### Command line

```bash
obs-control-mcp            # MCP server on stdio
obs-control-mcp check      # Source Record readiness, JSON on stdout
obs-control-mcp timeline   # only record the timeline, until Ctrl-C
```

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
npm run check-secrets     # also runs as a pre-commit hook and in CI
```

Tests run against a fake obs-websocket v5 server (`test/fakeObs.ts`) that
implements the real handshake (challenge/salt authentication) and the requests
used here. Put your own LAN address, user name or host names in a git-ignored
`.forbidden-strings` file (one per line) and the secret check will block them too.

## License

MIT

---

## En español

Servidor MCP para **ver y controlar con cuidado** OBS Studio por obs-websocket v5.

- **Lee todo**: versión y rendimiento, escenas, fuentes y sus ajustes, filtros y
  sus ajustes, estado de transmisión y grabación, carpetas de salida, video.
- **Cambia solo a propósito**: cada herramienta que cambia algo es un *dry run*
  (`dry_run=true`) hasta que se pide lo contrario, y mientras OBS transmite o
  graba se niega a cambiar nada si no va `confirmLive=true`. Antes de confirmar
  en vivo, hay que preguntarle a quien transmite.
- **«¿Listo para grabar?»**: `check_source_record` revisa cada filtro de
  Source Record — modo de grabación, codificador y calidad (CQP), escala, fps,
  nombres de archivo que chocan, carpeta y contenedor, de dónde sale el audio,
  si hay máscaras *encima* del filtro (se quedan en el archivo), cámaras con
  «Desactivar cuando no se muestra» y el espacio libre en disco — y da un
  veredicto: `ready`, `ready_with_warnings` o `not_ready`.
- **Línea de tiempo de escenas**: con `OBS_TIMELINE_FILE`, apunta en un archivo
  JSON-lines qué escena estaba al aire y cuándo; `read_timeline` responde «¿qué
  se veía en el segundo 01:23:45 del directo?» para sacar clips del VOD.
- **Ningún secreto sale del proceso**: la contraseña se lee de un archivo
  (`OBS_PASSWORD_FILE`), nunca se escribe en el log, y las claves de transmisión,
  tokens y URLs de widgets se muestran como `[redacted]`. Las pruebas corren el
  proceso real con `DEBUG=*` y fallan si aparece la contraseña o una clave.

Instalación: `npm ci && npm run build`, y registrar en el cliente MCP un pequeño
lanzador que ponga `OBS_HOST`, `OBS_PORT` y `OBS_PASSWORD_FILE` (ver arriba).
Con `OBS_READ_ONLY=1` solo se registran las herramientas de lectura.
