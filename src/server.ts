import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "type-fest";
import { z } from "zod";
import { findRedactedPlaceholders, runGuarded, type GuardResult } from "./guard.ts";
import type { Logger } from "./log.ts";
import type { ObsClient } from "./obs.ts";
import {
  DefaultsCache,
  diffSettings,
  getFilters,
  getLiveState,
  getMergedInputSettings,
  listAllSources,
} from "./obsData.ts";
import { redactSettings, type SecretRegistry } from "./redact.ts";
import { analyzeSourceRecord, collectSourceRecordContext } from "./sourceRecord.ts";
import { parseTimeline, summarizeTimeline } from "./timeline.ts";
import { VERSION } from "./version.ts";

export interface ServerDeps {
  obs: ObsClient;
  secrets: SecretRegistry;
  logger: Logger;
  readOnly: boolean;
  timelineFile: string | undefined;
}

export const INSTRUCTIONS = `Inspect and control OBS Studio over obs-websocket v5.
Read tools never change OBS. Tools that change OBS default to dry_run=true: the first call only says what would change; call again with dry_run=false to apply.
Live guard: while OBS is streaming or recording, changes are refused unless confirmLive=true. Ask the person before passing confirmLive=true — the audience sees the change.
Secret fields (stream keys, passwords, tokens, URL paths) are shown as "[redacted]"; never send those placeholders back in settings.
check_source_record answers «¿listo para grabar?» for the Source Record plugin. read_timeline tells which scene was live when.`;

const dryRunArg = z
  .boolean()
  .default(true)
  .describe("Default true: only describe the change. Set false to apply it.");
const confirmLiveArg = z
  .boolean()
  .default(false)
  .describe("Required (true) to apply a change while OBS is streaming or recording. Ask the person first.");
const settingsArg = z
  .record(z.string(), z.unknown())
  .describe("Settings object (only the fields to change when overlay=true).");

export function createServer(deps: ServerDeps): McpServer {
  const { obs, secrets, logger } = deps;
  const server = new McpServer({ name: "obs-control", version: VERSION }, { instructions: INSTRUCTIONS });

  /** Every tool result passes through here: redact by key, then scrub literal secrets. */
  const ok = (value: unknown): CallToolResult => ({
    content: [{ type: "text", text: secrets.scrub(JSON.stringify(redactSettings(value), null, 2)) }],
  });
  const fail = (message: string): CallToolResult => ({
    isError: true,
    content: [{ type: "text", text: secrets.scrub(message) }],
  });
  const guarded = (r: GuardResult): CallToolResult => (r.status === "refused" ? { ...ok(r), isError: true } : ok(r));

  const wrap =
    <A>(name: string, fn: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await fn(args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`${name}: ${msg}`);
        return fail(msg);
      }
    };

  const READ = { readOnlyHint: true, openWorldHint: false } as const;
  const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

  // ---------------------------------------------------------------- read

  server.registerTool(
    "get_overview",
    {
      title: "OBS overview",
      description:
        "Version, performance stats (CPU, memory, free disk, fps, skipped frames), stream/record state, current scene, profile, scene collection, video settings and recording folder.",
      inputSchema: {},
      annotations: READ,
    },
    wrap("get_overview", async () => {
      const [version, stats, live, program, studio, video, recDir, profiles, collections] = await Promise.all([
        obs.call("GetVersion"),
        obs.call("GetStats"),
        getLiveState(obs),
        obs.call("GetCurrentProgramScene"),
        obs.call("GetStudioModeEnabled").catch(() => ({ studioModeEnabled: false })),
        obs.call("GetVideoSettings"),
        obs.call("GetRecordDirectory").catch(() => ({ recordDirectory: undefined })),
        obs.call("GetProfileList").catch(() => undefined),
        obs.call("GetSceneCollectionList").catch(() => undefined),
      ]);
      const preview = studio.studioModeEnabled ? await obs.call("GetCurrentPreviewScene").catch(() => undefined) : undefined;
      return ok({
        obs: {
          obsVersion: version.obsVersion,
          obsWebSocketVersion: version.obsWebSocketVersion,
          rpcVersion: version.rpcVersion,
          platform: version.platform,
          platformDescription: version.platformDescription,
        },
        live,
        programScene: program.currentProgramSceneName,
        previewScene: preview?.currentPreviewSceneName ?? null,
        studioMode: studio.studioModeEnabled,
        profile: profiles?.currentProfileName,
        sceneCollection: collections?.currentSceneCollectionName,
        stats: {
          cpuPercent: round(stats.cpuUsage, 1),
          memoryMb: round(stats.memoryUsage, 0),
          freeDiskGb: round(stats.availableDiskSpace / 1024, 1),
          activeFps: round(stats.activeFps, 2),
          averageFrameRenderMs: round(stats.averageFrameRenderTime, 2),
          renderSkippedFrames: stats.renderSkippedFrames,
          renderTotalFrames: stats.renderTotalFrames,
          outputSkippedFrames: stats.outputSkippedFrames,
          outputTotalFrames: stats.outputTotalFrames,
        },
        video: describeVideo(video),
        recordDirectory: recDir.recordDirectory,
      });
    }),
  );

  server.registerTool(
    "list_scenes",
    {
      title: "List scenes",
      description: "Scenes in the order OBS shows them, the current program (and preview) scene, and optionally the sources in each scene.",
      inputSchema: { includeItems: z.boolean().default(true).describe("Include the sources of each scene.") },
      annotations: READ,
    },
    wrap("list_scenes", async ({ includeItems }: { includeItems: boolean }) => {
      const list = await obs.call("GetSceneList");
      const scenes = [...list.scenes].sort((a, b) => Number(b.sceneIndex) - Number(a.sceneIndex));
      const out = await Promise.all(
        scenes.map(async (s) => {
          const sceneName = String(s.sceneName);
          if (!includeItems) return { sceneName };
          const { sceneItems } = await obs.call("GetSceneItemList", { sceneName });
          return {
            sceneName,
            items: [...sceneItems]
              .sort((a, b) => Number(b.sceneItemIndex) - Number(a.sceneItemIndex))
              .map((it) => ({
                sourceName: it.sourceName,
                sceneItemId: it.sceneItemId,
                enabled: it.sceneItemEnabled,
                inputKind: it.inputKind ?? null,
                isGroup: it.isGroup ?? false,
              })),
          };
        }),
      );
      return ok({
        programScene: list.currentProgramSceneName,
        previewScene: list.currentPreviewSceneName ?? null,
        scenes: out,
      });
    }),
  );

  server.registerTool(
    "list_inputs",
    {
      title: "List inputs",
      description: "All inputs (sources) with their kind; optionally their settings with OBS defaults filled in. Secret fields are redacted.",
      inputSchema: {
        kind: z.string().optional().describe("Only inputs of this kind, e.g. dshow_input."),
        includeSettings: z.boolean().default(false),
      },
      annotations: READ,
    },
    wrap("list_inputs", async ({ kind, includeSettings }: { kind?: string; includeSettings: boolean }) => {
      const { inputs } = await obs.call("GetInputList", kind ? { inputKind: kind } : {});
      const defaults = new DefaultsCache(obs);
      const out = await Promise.all(
        inputs.map(async (i) => {
          const base = { inputName: i.inputName, inputKind: i.inputKind, unversionedKind: i.unversionedInputKind };
          if (!includeSettings) return base;
          const s = await getMergedInputSettings(obs, String(i.inputName), defaults);
          return { ...base, settings: s.settings, changedFromDefault: s.explicitKeys };
        }),
      );
      return ok({ count: out.length, inputs: out });
    }),
  );

  server.registerTool(
    "get_input_settings",
    {
      title: "Get input settings",
      description: "Settings of one input with OBS defaults filled in, plus which fields differ from the defaults. Secret fields are redacted.",
      inputSchema: { inputName: z.string().min(1) },
      annotations: READ,
    },
    wrap("get_input_settings", async ({ inputName }: { inputName: string }) => {
      const s = await getMergedInputSettings(obs, inputName, new DefaultsCache(obs));
      const mute = await obs.call("GetInputMute", { inputName }).catch(() => undefined);
      return ok({ inputName, inputKind: s.inputKind, muted: mute?.inputMuted, settings: s.settings, changedFromDefault: s.explicitKeys });
    }),
  );

  server.registerTool(
    "list_filters",
    {
      title: "List filters",
      description:
        "Filters of one source (or of every source and scene), top to bottom as in OBS, with settings (defaults filled in, secrets redacted). Filters apply top to bottom.",
      inputSchema: {
        sourceName: z.string().optional().describe("Source or scene name. Omit for all."),
        kind: z.string().optional().describe("Only filters of this kind, e.g. source_record_filter."),
        includeSettings: z.boolean().default(true),
      },
      annotations: READ,
    },
    wrap("list_filters", async ({ sourceName, kind, includeSettings }: { sourceName?: string; kind?: string; includeSettings: boolean }) => {
      const defaults = new DefaultsCache(obs);
      const names = sourceName ? [sourceName] : (await listAllSources(obs)).map((s) => s.sourceName);
      const out: Array<{ sourceName: string; filters: unknown[] }> = [];
      for (const name of names) {
        let filters;
        try {
          filters = await getFilters(obs, name, defaults);
        } catch (err) {
          if (sourceName) throw err;
          continue;
        }
        const shown = filters
          .filter((f) => !kind || f.filterKind === kind)
          .sort((a, b) => a.filterIndex - b.filterIndex)
          .map((f) => ({
            filterName: f.filterName,
            filterKind: f.filterKind,
            filterIndex: f.filterIndex,
            enabled: f.filterEnabled,
            ...(includeSettings ? { settings: f.settings, changedFromDefault: f.explicitKeys } : {}),
          }));
        if (shown.length > 0 || sourceName) out.push({ sourceName: name, filters: shown });
      }
      return ok({ sources: out });
    }),
  );

  server.registerTool(
    "get_outputs",
    {
      title: "Stream and recording status",
      description:
        "Stream, recording, replay buffer and virtual camera status, the recording folder, every OBS output, and the stream service (server shown, key redacted).",
      inputSchema: {},
      annotations: READ,
    },
    wrap("get_outputs", async () => {
      const [stream, record, recDir, outputs, service, replay, vcam] = await Promise.all([
        obs.call("GetStreamStatus"),
        obs.call("GetRecordStatus"),
        obs.call("GetRecordDirectory").catch(() => ({ recordDirectory: undefined })),
        obs.call("GetOutputList").catch(() => ({ outputs: [] })),
        obs.call("GetStreamServiceSettings").catch(() => undefined),
        obs.call("GetReplayBufferStatus").catch(() => undefined),
        obs.call("GetVirtualCamStatus").catch(() => undefined),
      ]);
      return ok({
        stream,
        record,
        recordDirectory: recDir.recordDirectory,
        replayBuffer: replay ?? null,
        virtualCam: vcam ?? null,
        streamService: service ? { type: service.streamServiceType, settings: service.streamServiceSettings } : null,
        outputs: outputs.outputs.map((o) => ({ name: o.outputName, kind: o.outputKind, active: o.outputActive })),
      });
    }),
  );

  server.registerTool(
    "get_video_settings",
    {
      title: "Video settings",
      description: "Canvas (base) and output resolution and frame rate.",
      inputSchema: {},
      annotations: READ,
    },
    wrap("get_video_settings", async () => ok(describeVideo(await obs.call("GetVideoSettings")))),
  );

  server.registerTool(
    "check_source_record",
    {
      title: "Source Record: ready to record?",
      description:
        "«¿Listo para grabar?» Finds every Source Record filter and checks record mode, encoder and rate control/QP, scaling, fps, file name collisions, output folder, container, audio source, filter order (masks above it get baked in), capture devices that deactivate when hidden, render fps and free disk. Returns a verdict: ready, ready_with_warnings, not_ready. Read-only.",
      inputSchema: {},
      annotations: READ,
    },
    wrap("check_source_record", async () => ok(analyzeSourceRecord(await collectSourceRecordContext(obs)))),
  );

  server.registerTool(
    "read_timeline",
    {
      title: "Read the scene timeline",
      description:
        "Summarises the scene timeline log (OBS_TIMELINE_FILE): which scene was on program and for how long, stream and recording sessions with offsets, and what was live at a given time or at a given second of a stream (e.g. a VOD timestamp).",
      inputSchema: {
        from: z.string().optional().describe("ISO time; only segments after this."),
        to: z.string().optional().describe("ISO time; only segments before this."),
        at: z.string().optional().describe("ISO time to look up."),
        atStreamOffsetSec: z.number().min(0).optional().describe("Seconds into a stream to look up (instead of `at`)."),
        streamIndex: z.number().int().default(-1).describe("Which stream atStreamOffsetSec refers to: 0 = first, -1 = last."),
        tail: z.number().int().min(0).max(200).default(0).describe("Also return the last N raw lines."),
      },
      annotations: READ,
    },
    wrap(
      "read_timeline",
      async (a: { from?: string; to?: string; at?: string; atStreamOffsetSec?: number; streamIndex: number; tail: number }) => {
        if (!deps.timelineFile) return fail("No timeline file configured: set OBS_TIMELINE_FILE.");
        for (const [k, v] of [["from", a.from], ["to", a.to], ["at", a.at]] as const) {
          if (v !== undefined && Number.isNaN(Date.parse(v))) return fail(`${k} is not a valid date/time: ${v}`);
        }
        let text: string;
        try {
          text = readFileSync(deps.timelineFile, "utf8");
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          return fail(code === "ENOENT" ? "The timeline file does not exist yet: nothing has been recorded." : `Cannot read the timeline file (${code ?? "error"}).`);
        }
        const summary = summarizeTimeline(deps.timelineFile, text, {
          ...(a.from ? { from: a.from } : {}),
          ...(a.to ? { to: a.to } : {}),
          ...(a.at ? { at: a.at } : {}),
          ...(a.atStreamOffsetSec !== undefined ? { atStreamOffsetSec: a.atStreamOffsetSec } : {}),
          streamIndex: a.streamIndex,
        });
        const tail = a.tail > 0 ? parseTimeline(text).lines.slice(-a.tail) : undefined;
        return ok({ ...summary, ...(tail ? { tail } : {}) });
      },
    ),
  );

  if (deps.readOnly) return server;

  // ---------------------------------------------------------------- write (guarded)

  server.registerTool(
    "switch_scene",
    {
      title: "Switch program scene",
      description: "Puts a scene on program (what viewers see). Guarded: dry_run by default; needs confirmLive=true while streaming/recording.",
      inputSchema: { sceneName: z.string().min(1), dry_run: dryRunArg, confirmLive: confirmLiveArg },
      annotations: { ...WRITE, idempotentHint: true },
    },
    wrap("switch_scene", async ({ sceneName, dry_run, confirmLive }: { sceneName: string; dry_run: boolean; confirmLive: boolean }) => {
      const list = await obs.call("GetSceneList");
      if (!list.scenes.some((s) => s.sceneName === sceneName)) {
        return fail(`No scene named «${sceneName}». Scenes: ${list.scenes.map((s) => s.sceneName).join(", ")}`);
      }
      const current = list.currentProgramSceneName;
      if (current === sceneName) return ok({ status: "no_change", message: `«${sceneName}» is already on program.` });
      return guarded(
        await runGuarded(obs, { dryRun: dry_run, confirmLive }, {
          action: `Switch program scene from «${current}» to «${sceneName}».`,
          changes: { from: current, to: sceneName },
          apply: () => obs.call("SetCurrentProgramScene", { sceneName }),
        }),
      );
    }),
  );

  server.registerTool(
    "set_filter_settings",
    {
      title: "Change filter settings",
      description:
        "Changes settings of a filter (including Source Record). overlay=true (default) changes only the given fields. Shows a before/after diff. Guarded: dry_run by default; needs confirmLive=true while streaming/recording.",
      inputSchema: {
        sourceName: z.string().min(1),
        filterName: z.string().min(1),
        settings: settingsArg,
        overlay: z.boolean().default(true).describe("true: merge into current settings. false: replace them (unset fields go back to defaults)."),
        dry_run: dryRunArg,
        confirmLive: confirmLiveArg,
      },
      annotations: WRITE,
    },
    wrap(
      "set_filter_settings",
      async (a: { sourceName: string; filterName: string; settings: Record<string, unknown>; overlay: boolean; dry_run: boolean; confirmLive: boolean }) => {
        const placeholders = findRedactedPlaceholders(a.settings);
        if (placeholders.length) return fail(`Refused: ${placeholders.join(", ")} contain the "[redacted]" placeholder; leave secret fields out.`);
        const defaults = new DefaultsCache(obs);
        const filters = await getFilters(obs, a.sourceName, defaults);
        const f = filters.find((x) => x.filterName === a.filterName);
        if (!f) return fail(`No filter «${a.filterName}» on «${a.sourceName}». Filters: ${filters.map((x) => x.filterName).join(", ") || "none"}`);
        const defs = await defaults.filterDefaults(f.filterKind);
        const after = a.overlay ? { ...f.settings, ...(a.settings as JsonObject) } : { ...defs, ...(a.settings as JsonObject) };
        const diff = diffSettings(f.settings, after);
        if (diff.length === 0) return ok({ status: "no_change", message: "Those values are already set." });
        return guarded(
          await runGuarded(obs, { dryRun: a.dry_run, confirmLive: a.confirmLive }, {
            action: `${a.overlay ? "Update" : "Replace"} settings of filter «${a.filterName}» (${f.filterKind}) on «${a.sourceName}»: ${diff.length} field(s).`,
            changes: diff,
            apply: () =>
              obs.call("SetSourceFilterSettings", {
                sourceName: a.sourceName,
                filterName: a.filterName,
                filterSettings: a.settings as JsonObject,
                overlay: a.overlay,
              }),
          }),
        );
      },
    ),
  );

  server.registerTool(
    "set_filter_enabled",
    {
      title: "Enable or disable a filter",
      description: "Turns a filter on or off. Disabling a Source Record filter stops its file. Guarded: dry_run by default; needs confirmLive=true while streaming/recording.",
      inputSchema: {
        sourceName: z.string().min(1),
        filterName: z.string().min(1),
        enabled: z.boolean(),
        dry_run: dryRunArg,
        confirmLive: confirmLiveArg,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    wrap(
      "set_filter_enabled",
      async (a: { sourceName: string; filterName: string; enabled: boolean; dry_run: boolean; confirmLive: boolean }) => {
        const f = await obs.call("GetSourceFilter", { sourceName: a.sourceName, filterName: a.filterName });
        if (f.filterEnabled === a.enabled) return ok({ status: "no_change", message: `Already ${a.enabled ? "enabled" : "disabled"}.` });
        return guarded(
          await runGuarded(obs, { dryRun: a.dry_run, confirmLive: a.confirmLive }, {
            action: `${a.enabled ? "Enable" : "Disable"} filter «${a.filterName}» (${f.filterKind}) on «${a.sourceName}».`,
            changes: { enabled: { before: f.filterEnabled, after: a.enabled } },
            apply: () => obs.call("SetSourceFilterEnabled", { sourceName: a.sourceName, filterName: a.filterName, filterEnabled: a.enabled }),
          }),
        );
      },
    ),
  );

  server.registerTool(
    "set_filter_index",
    {
      title: "Move a filter",
      description: "Moves a filter to a position (0 = top, applied first). Shows the order before and after. Guarded: dry_run by default; needs confirmLive=true while streaming/recording.",
      inputSchema: {
        sourceName: z.string().min(1),
        filterName: z.string().min(1),
        filterIndex: z.number().int().min(0),
        dry_run: dryRunArg,
        confirmLive: confirmLiveArg,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    wrap(
      "set_filter_index",
      async (a: { sourceName: string; filterName: string; filterIndex: number; dry_run: boolean; confirmLive: boolean }) => {
        const { filters } = await obs.call("GetSourceFilterList", { sourceName: a.sourceName });
        const order = [...filters].sort((x, y) => Number(x.filterIndex) - Number(y.filterIndex)).map((x) => String(x.filterName));
        const from = order.indexOf(a.filterName);
        if (from < 0) return fail(`No filter «${a.filterName}» on «${a.sourceName}». Filters: ${order.join(", ") || "none"}`);
        const to = Math.min(a.filterIndex, order.length - 1);
        if (from === to) return ok({ status: "no_change", message: `«${a.filterName}» is already at position ${to}.` });
        const after = [...order];
        after.splice(from, 1);
        after.splice(to, 0, a.filterName);
        return guarded(
          await runGuarded(obs, { dryRun: a.dry_run, confirmLive: a.confirmLive }, {
            action: `Move filter «${a.filterName}» on «${a.sourceName}» from position ${from} to ${to}.`,
            changes: { before: order, after },
            apply: () => obs.call("SetSourceFilterIndex", { sourceName: a.sourceName, filterName: a.filterName, filterIndex: to }),
          }),
        );
      },
    ),
  );

  server.registerTool(
    "start_record",
    {
      title: "Start recording",
      description: "Starts the main OBS recording (Source Record filters in «recording» mode start with it). Guarded: dry_run by default; needs confirmLive=true while streaming.",
      inputSchema: { dry_run: dryRunArg, confirmLive: confirmLiveArg },
      annotations: WRITE,
    },
    wrap("start_record", async ({ dry_run, confirmLive }: { dry_run: boolean; confirmLive: boolean }) => {
      const rec = await obs.call("GetRecordStatus");
      if (rec.outputActive) return ok({ status: "no_change", message: "Already recording." });
      return guarded(
        await runGuarded(obs, { dryRun: dry_run, confirmLive }, {
          action: "Start the main recording.",
          apply: () => obs.call("StartRecord"),
        }),
      );
    }),
  );

  server.registerTool(
    "stop_record",
    {
      title: "Stop recording",
      description: "Stops the main OBS recording and returns the file path. Always needs confirmLive=true (it only acts while recording). dry_run by default.",
      inputSchema: { dry_run: dryRunArg, confirmLive: confirmLiveArg },
      annotations: WRITE,
    },
    wrap("stop_record", async ({ dry_run, confirmLive }: { dry_run: boolean; confirmLive: boolean }) => {
      const rec = await obs.call("GetRecordStatus");
      if (!rec.outputActive) return ok({ status: "no_change", message: "Not recording." });
      return guarded(
        await runGuarded(obs, { dryRun: dry_run, confirmLive }, {
          action: `Stop the main recording (running for ${rec.outputTimecode}).`,
          apply: () => obs.call("StopRecord"),
        }),
      );
    }),
  );

  server.registerTool(
    "set_input_settings",
    {
      title: "Change input settings",
      description:
        "Changes settings of an input (source). overlay=true (default) changes only the given fields. Shows a before/after diff. Guarded: dry_run by default; needs confirmLive=true while streaming/recording.",
      inputSchema: {
        inputName: z.string().min(1),
        settings: settingsArg,
        overlay: z.boolean().default(true),
        dry_run: dryRunArg,
        confirmLive: confirmLiveArg,
      },
      annotations: WRITE,
    },
    wrap(
      "set_input_settings",
      async (a: { inputName: string; settings: Record<string, unknown>; overlay: boolean; dry_run: boolean; confirmLive: boolean }) => {
        const placeholders = findRedactedPlaceholders(a.settings);
        if (placeholders.length) return fail(`Refused: ${placeholders.join(", ")} contain the "[redacted]" placeholder; leave secret fields out.`);
        const defaults = new DefaultsCache(obs);
        const cur = await getMergedInputSettings(obs, a.inputName, defaults);
        const defs = await defaults.inputDefaults(cur.inputKind);
        const after = a.overlay ? { ...cur.settings, ...(a.settings as JsonObject) } : { ...defs, ...(a.settings as JsonObject) };
        const diff = diffSettings(cur.settings, after);
        if (diff.length === 0) return ok({ status: "no_change", message: "Those values are already set." });
        return guarded(
          await runGuarded(obs, { dryRun: a.dry_run, confirmLive: a.confirmLive }, {
            action: `${a.overlay ? "Update" : "Replace"} settings of input «${a.inputName}» (${cur.inputKind}): ${diff.length} field(s).`,
            changes: diff,
            apply: () => obs.call("SetInputSettings", { inputName: a.inputName, inputSettings: a.settings as JsonObject, overlay: a.overlay }),
          }),
        );
      },
    ),
  );

  return server;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function describeVideo(v: { baseWidth: number; baseHeight: number; outputWidth: number; outputHeight: number; fpsNumerator: number; fpsDenominator: number }) {
  return {
    base: `${v.baseWidth}x${v.baseHeight}`,
    output: `${v.outputWidth}x${v.outputHeight}`,
    fps: v.fpsDenominator > 0 ? round(v.fpsNumerator / v.fpsDenominator, 3) : null,
    ...v,
  };
}
