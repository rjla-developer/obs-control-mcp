import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger } from "../src/log.ts";
import { ObsConnection } from "../src/obs.ts";
import { SecretRegistry } from "../src/redact.ts";
import { createServer } from "../src/server.ts";
import { FakeObs, type FakeState } from "./fakeObs.ts";

export const PASSWORD = "Pw-Test-9f8e7d6c5b4a";

export interface Harness {
  fake: FakeObs;
  conn: ObsConnection;
  client: Client;
  logs: string[];
  /** Calls a tool and returns the parsed JSON (or text) plus the raw result. */
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }>;
  close(): Promise<void>;
}

export async function startHarness(
  opts: { state?: FakeState; password?: string; clientPassword?: string; readOnly?: boolean; timelineFile?: string } = {},
): Promise<Harness> {
  const password = opts.password ?? PASSWORD;
  const fake = new FakeObs({ password, ...(opts.state ? { state: opts.state } : {}) });
  await fake.start();
  const secrets = new SecretRegistry();
  const clientPassword = opts.clientPassword ?? password;
  secrets.add(clientPassword);
  const logs: string[] = [];
  const logger = createLogger(secrets, "debug", (l) => logs.push(l));
  const conn = new ObsConnection({
    config: { host: "127.0.0.1", port: fake.port, password: clientPassword, connectTimeoutMs: 2000 },
    secrets,
    logger,
  });
  const server = createServer({ obs: conn, secrets, logger, readOnly: opts.readOnly ?? false, timelineFile: opts.timelineFile });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return {
    fake,
    conn,
    client,
    logs,
    async call(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      const text = r.content.map((c) => c.text).join("\n");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: Boolean(r.isError), text, json };
    },
    async close() {
      await client.close();
      await server.close();
      await conn.close();
      await fake.stop();
    },
  };
}
