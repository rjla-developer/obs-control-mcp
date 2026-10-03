import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BRB_USAGE, BrbSwitcher, MediamtxProbe, parseBrbArgs } from "./brb.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { analyzeIrl, collectIrlContext, DEFAULT_IRL_NAMES } from "./irl.ts";
import { createLogger, type Logger } from "./log.ts";
import { ObsConnection, TIMELINE_SUBSCRIPTIONS } from "./obs.ts";
import { redactSettings, SecretRegistry } from "./redact.ts";
import { createServer } from "./server.ts";
import { analyzeSourceRecord, collectSourceRecordContext } from "./sourceRecord.ts";
import { acquireTimelineLock, TimelineRecorder, TimelineWriter } from "./timeline.ts";
import { VERSION } from "./version.ts";

const USAGE = `obs-control-mcp ${VERSION}

Usage:
  obs-control-mcp            MCP server on stdio (what an MCP client launches)
  obs-control-mcp check      Source Record readiness check, printed as JSON (exit 0 ready, 1 warnings, 2 not ready)
  obs-control-mcp timeline   Only record the scene timeline to OBS_TIMELINE_FILE (runs until stopped)
  obs-control-mcp check-irl  IRL readiness check (live/BRB scenes, feed Media Source), JSON (exit codes as check)
  obs-control-mcp brb        BRB auto-switcher for an incoming feed; dry run unless --apply (see brb --help)

Environment:
  OBS_HOST, OBS_PORT, OBS_PASSWORD_FILE (or OBS_PASSWORD), OBS_TIMELINE_FILE,
  OBS_TIMELINE_RECORD=0|1, OBS_READ_ONLY=0|1, OBS_CONNECT_TIMEOUT_MS`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const cmd = argv[0] ?? "serve";
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }

  if (cmd === "brb" && argv.slice(1).some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(BRB_USAGE + "\n");
    return 0;
  }

  const secrets = new SecretRegistry();
  const logger = createLogger(secrets);
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    logger.error(err instanceof ConfigError ? err.message : "Invalid configuration");
    return 64;
  }
  secrets.add(config.password);

  switch (cmd) {
    case "serve":
      return serve(config, secrets, logger);
    case "check":
      return check(config, secrets, logger);
    case "timeline":
      return timelineOnly(config, secrets, logger);
    case "check-irl":
      return checkIrl(config, secrets, logger, argv.slice(1));
    case "brb":
      return brb(config, secrets, logger, argv.slice(1));
    default:
      process.stderr.write(USAGE + "\n");
      return 64;
  }
}

async function serve(config: Config, secrets: SecretRegistry, logger: Logger): Promise<number> {
  let release: (() => void) | undefined;
  if (config.timelineFile && config.timelineRecord) {
    release = acquireTimelineLock(config.timelineFile);
    if (!release) logger.info("Another process is already recording the timeline; this server will only read it.");
  }
  const recording = Boolean(release);
  const conn = new ObsConnection({
    config,
    secrets,
    logger,
    eventSubscriptions: recording ? TIMELINE_SUBSCRIPTIONS : 0,
    autoReconnect: recording,
  });
  let recorder: TimelineRecorder | undefined;
  if (recording && config.timelineFile) {
    recorder = new TimelineRecorder(conn, new TimelineWriter(config.timelineFile, secrets), logger);
    recorder.start();
    conn.keepConnected();
  }

  const server = createServer({ obs: conn, secrets, logger, readOnly: config.readOnly, timelineFile: config.timelineFile });
  const transport = new StdioServerTransport();

  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finished = resolve));
  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    recorder?.stop(reason);
    release?.();
    await conn.close();
    await server.close().catch(() => undefined);
    finished();
  };
  transport.onclose = () => void shutdown("client closed");
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  logger.info(`obs-control-mcp ${VERSION} ready (${config.readOnly ? "read-only" : "read/write, guarded"}; OBS at ${config.host}:${config.port})`);
  await done;
  return 0;
}

async function check(config: Config, secrets: SecretRegistry, logger: Logger): Promise<number> {
  const conn = new ObsConnection({ config, secrets, logger });
  try {
    const report = analyzeSourceRecord(await collectSourceRecordContext(conn));
    process.stdout.write(secrets.scrub(JSON.stringify(redactSettings(report), null, 2)) + "\n");
    return report.verdict === "ready" ? 0 : report.verdict === "ready_with_warnings" ? 1 : 2;
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 3;
  } finally {
    await conn.close();
  }
}

/** `check-irl [--live S] [--brb S] [--feed I]`: same exit codes as `check`. */
async function checkIrl(config: Config, secrets: SecretRegistry, logger: Logger, argv: string[]): Promise<number> {
  const names = { ...DEFAULT_IRL_NAMES };
  for (let i = 0; i < argv.length; i += 2) {
    const v = argv[i + 1];
    if (!v) {
      logger.error(`${argv[i]} needs a value`);
      return 64;
    }
    if (argv[i] === "--live") names.liveScene = v;
    else if (argv[i] === "--brb") names.brbScene = v;
    else if (argv[i] === "--feed") names.feedInput = v;
    else {
      logger.error(`Unknown option ${argv[i]} (use --live, --brb, --feed)`);
      return 64;
    }
  }
  const conn = new ObsConnection({ config, secrets, logger });
  try {
    const report = analyzeIrl(await collectIrlContext(conn, names));
    process.stdout.write(secrets.scrub(JSON.stringify(redactSettings(report), null, 2)) + "\n");
    return report.verdict === "ready" ? 0 : report.verdict === "ready_with_warnings" ? 1 : 2;
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 3;
  } finally {
    await conn.close();
  }
}

/** `brb`: watches the feed and switches between the live and BRB scenes (dry run unless --apply). */
async function brb(config: Config, secrets: SecretRegistry, logger: Logger, argv: string[]): Promise<number> {
  let args;
  try {
    args = parseBrbArgs(argv);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 64;
  }
  if (config.readOnly && args.apply) {
    logger.error("OBS_READ_ONLY=1: refusing --apply.");
    return 64;
  }
  // The probe URL may carry credentials: never let it reach a log line.
  if (args.statsUrl) secrets.add(args.statsUrl);
  const conn = new ObsConnection({ config, secrets, logger, autoReconnect: true });
  const switcher = new BrbSwitcher(
    conn,
    {
      liveScene: args.liveScene,
      brbScene: args.brbScene,
      feedInput: args.feedInput,
      thresholds: args.thresholds,
      intervalSec: args.intervalSec,
      apply: args.apply,
      returnFromManualBrb: args.returnFromManualBrb,
      probe: args.statsUrl ? new MediamtxProbe(args.statsUrl, args.statsPath) : undefined,
    },
    logger,
  );
  try {
    await switcher.start();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    await conn.close();
    return 3;
  }
  logger.info("Watching the feed; stop with Ctrl-C.");
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      switcher.stop();
      void conn.close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function timelineOnly(config: Config, secrets: SecretRegistry, logger: Logger): Promise<number> {
  if (!config.timelineFile) {
    logger.error("Set OBS_TIMELINE_FILE to the JSON-lines file to write.");
    return 64;
  }
  const release = acquireTimelineLock(config.timelineFile);
  if (!release) {
    logger.error("Another process is already recording this timeline file.");
    return 75;
  }
  const conn = new ObsConnection({ config, secrets, logger, eventSubscriptions: TIMELINE_SUBSCRIPTIONS, autoReconnect: true });
  const recorder = new TimelineRecorder(conn, new TimelineWriter(config.timelineFile, secrets), logger);
  recorder.start();
  conn.keepConnected();
  logger.info("Recording the scene timeline; stop with Ctrl-C.");
  await new Promise<void>((resolve) => {
    const stop = (sig: string) => {
      recorder.stop(sig);
      release();
      void conn.close().then(resolve);
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
  return 0;
}
