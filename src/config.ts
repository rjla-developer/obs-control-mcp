import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Runtime configuration. Everything comes from environment variables so that
 * no host, port or password ever has to live in a config file that an MCP
 * client stores (for example `~/.claude.json`).
 *
 *   OBS_HOST              host name or IP of the machine running OBS (default 127.0.0.1)
 *   OBS_PORT              obs-websocket port (default 4455)
 *   OBS_PASSWORD_FILE     path to a file whose first line is the password (preferred)
 *   OBS_PASSWORD          the password itself (removed from the environment once read)
 *   OBS_TIMELINE_FILE     JSON-lines file for the scene timeline (optional)
 *   OBS_TIMELINE_RECORD   "0" to stop the MCP server from recording the timeline itself
 *   OBS_READ_ONLY         "1" to register only the read tools
 *   OBS_CONNECT_TIMEOUT_MS  connection timeout (default 5000)
 */
export interface Config {
  host: string;
  port: number;
  password: string | undefined;
  timelineFile: string | undefined;
  timelineRecord: boolean;
  readOnly: boolean;
  connectTimeoutMs: number;
}

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)$/, "OBS_HOST must be a host name or an IP address (no scheme, no port)");

const envSchema = z.object({
  OBS_HOST: hostSchema.default("127.0.0.1"),
  OBS_PORT: z.coerce.number().int().min(1).max(65535).default(4455),
  OBS_PASSWORD_FILE: z.string().trim().min(1).optional(),
  OBS_PASSWORD: z.string().optional(),
  OBS_TIMELINE_FILE: z.string().trim().min(1).optional(),
  OBS_TIMELINE_RECORD: z.enum(["0", "1"]).default("1"),
  OBS_READ_ONLY: z.enum(["0", "1"]).default("0"),
  OBS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),
});

export class ConfigError extends Error {}

/**
 * Reads the configuration. `env` is mutated on purpose: OBS_PASSWORD is
 * deleted once read so it is not inherited by anything this process spawns.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Only report the variable names and the rule, never the values.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;

  let password: string | undefined;
  if (e.OBS_PASSWORD_FILE) {
    let raw: string;
    try {
      raw = readFileSync(e.OBS_PASSWORD_FILE, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
      throw new ConfigError(`Cannot read OBS_PASSWORD_FILE (${code})`);
    }
    password = raw.split(/\r?\n/)[0]?.trim();
    if (!password) throw new ConfigError("OBS_PASSWORD_FILE is empty");
  } else if (e.OBS_PASSWORD !== undefined && e.OBS_PASSWORD !== "") {
    password = e.OBS_PASSWORD;
  }
  delete env.OBS_PASSWORD;

  return {
    host: e.OBS_HOST,
    port: e.OBS_PORT,
    password,
    timelineFile: e.OBS_TIMELINE_FILE,
    timelineRecord: e.OBS_TIMELINE_RECORD === "1",
    readOnly: e.OBS_READ_ONLY === "1",
    connectTimeoutMs: e.OBS_CONNECT_TIMEOUT_MS,
  };
}

export function obsUrl(config: Pick<Config, "host" | "port">): string {
  return `ws://${config.host}:${config.port}`;
}
