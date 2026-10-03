# obs-control-mcp — conventions

MCP server (stdio) that inspects and safely controls OBS Studio over
obs-websocket v5. TypeScript, Node ≥ 22.18, `@modelcontextprotocol/sdk`,
`obs-websocket-js` (JSON protocol), zod, vitest.

## This repository is PUBLIC

- Never commit secrets, IP addresses, host names, home-directory paths, e-mail
  addresses or anyone's personal data. Use `192.0.2.x` (documentation range),
  `example.com` and `C:/Users/example/...` in examples and fixtures.
- `npm run check-secrets` must stay clean; it runs as the pre-commit hook
  (`.githooks/`, installed by `npm install`), in CI and in `npm test`.
- Personal strings to block go in the git-ignored `.forbidden-strings`.
- Configuration comes only from environment variables / a password file.
  Never add a config file with values to the repo.

## Safety rules (do not weaken)

1. Every tool that changes OBS goes through `runGuarded` (`src/guard.ts`):
   `dry_run` defaults to `true`, and while streaming or recording it needs
   `confirmLive=true`. A new write tool without both is a bug; the tool-list
   test checks the defaults. The `brb` command is the one deliberate
   exception to the live question: its job is to switch while live, so
   `--apply` is the person's confirmation (it still goes through `runGuarded`,
   is a dry run without the flag, only moves between its two scenes, and is
   refused under `OBS_READ_ONLY=1`).
2. Every tool result goes through `ok()`/`fail()` in `src/server.ts`
   (redaction by key + scrubbing of literal secrets). Never return raw OBS data.
3. Log only through `createLogger` (`src/log.ts`), never `console.*`
   (lint rule). stdout is the MCP protocol.
4. `src/cli.ts` clears `DEBUG` before loading anything; keep it the entry point.
5. Settings containing `[redacted]` are refused on write.

## Layout

| File | What |
|---|---|
| `src/cli.ts`, `src/main.ts` | Entry point; `serve` (default), `check`, `timeline` |
| `src/config.ts` | Environment → config (zod) |
| `src/obs.ts` | Lazy, reconnecting obs-websocket connection; errors scrubbed |
| `src/obsData.ts` | Live state, defaults merging, diffs |
| `src/guard.ts` | dry run + live guard |
| `src/redact.ts`, `src/log.ts` | Redaction and the only logger |
| `src/sourceRecord.ts` | Source Record readiness: collect (I/O) + `analyzeSourceRecord` (pure) |
| `src/irl.ts` | IRL readiness (`check_irl`, `check-irl`): collect (I/O) + `analyzeIrl` (pure). Never reports the feed URL, only its protocol |
| `src/brb.ts` | BRB auto-switcher (`brb` command): `decideBrb` (pure, hysteresis) + `BrbSwitcher` (polls OBS; dry run unless `--apply`) + mediamtx bitrate probe |
| `src/timeline.ts` | Timeline recorder, lock, summary |
| `src/server.ts` | Tool definitions |
| `test/fakeObs.ts` | Fake obs-websocket v5 server used by the tests |

## Tests

- `npm test` (vitest). Tests live in `test/`. Every rule in
  `analyzeSourceRecord` is tested on both sides of its limit.
- Write tools: test dry run (nothing sent — check `fake.mutations`), the live
  guard, and the applied change.
- Anything that could print data: assert the password and fake stream keys do
  not appear (see `test/e2e-no-secret-logs.test.ts`).
- Before pushing: `npm run lint && npm run typecheck && npm run build && npm test`.

## Dependencies

Pinned exact versions; keep the runtime tree small (SDK, obs-websocket-js,
zod). `npm audit` must be clean. Read the diff of a dependency before bumping it.

## Git

Commits in English, `type(scope): message` (`feat`, `fix`, `refactor`, `test`,
`docs`, `chore`, `ci`). GitHub only (no other remote).
