import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./log.ts";
import type { ObsConnection, OBSEventTypes } from "./obs.ts";
import { redactSettings, type SecretRegistry } from "./redact.ts";

/**
 * Scene timeline: one JSON object per line, appended to OBS_TIMELINE_FILE.
 * It answers «which scene was live at 01:23:45 of the stream?» when cutting
 * clips later. Times are this machine's clock (ISO 8601, UTC).
 *
 * Line types:
 *   {"t","type":"recorder","state":"started"|"connected"|"disconnected"|"stopped"}
 *   {"t","type":"snapshot","programScene","streaming","recording"}
 *   {"t","type":"event","event":"<obs-websocket event>","data":{...redacted...}}
 */

export const TIMELINE_EVENTS = [
  "CurrentProgramSceneChanged",
  "CurrentPreviewSceneChanged",
  "StudioModeStateChanged",
  "SceneCreated",
  "SceneRemoved",
  "SceneNameChanged",
  "StreamStateChanged",
  "RecordStateChanged",
  "RecordFileChanged",
  "ReplayBufferStateChanged",
  "ReplayBufferSaved",
  "VirtualcamStateChanged",
  "SceneItemEnableStateChanged",
  "SourceFilterCreated",
  "SourceFilterRemoved",
  "SourceFilterNameChanged",
  "SourceFilterEnableStateChanged",
  "SourceFilterSettingsChanged",
  "InputCreated",
  "InputRemoved",
  "InputNameChanged",
  "InputSettingsChanged",
  "InputMuteStateChanged",
  "ExitStarted",
] as const satisfies ReadonlyArray<keyof OBSEventTypes>;

export type TimelineLine =
  | { t: string; type: "recorder"; state: "started" | "connected" | "disconnected" | "stopped"; reason?: string }
  | {
      t: string;
      type: "snapshot";
      programScene: string | null;
      streaming: boolean;
      recording: boolean;
      /** How long the stream/recording had been running when the snapshot was taken. */
      streamDurationMs?: number;
      recordDurationMs?: number;
    }
  | { t: string; type: "event"; event: string; data: Record<string, unknown> };

export class TimelineWriter {
  private readonly file: string;
  private readonly secrets: SecretRegistry;
  constructor(file: string, secrets: SecretRegistry) {
    this.file = file;
    this.secrets = secrets;
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) {
      closeSync(openSync(file, "a", 0o600));
    }
    try {
      chmodSync(file, 0o600);
    } catch {
      // not ours to fix (e.g. a shared path); appending still works
    }
  }

  write(line: TimelineLine): void {
    appendFileSync(this.file, this.secrets.scrub(JSON.stringify(redactSettings(line))) + "\n", { mode: 0o600 });
  }
}

/** One recorder per timeline file: a pid lock so two processes never write duplicate lines. */
export function acquireTimelineLock(file: string): (() => void) | undefined {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
        } catch {
          // already gone
        }
      };
    } catch {
      let pid = NaN;
      try {
        pid = Number(readFileSync(lock, "utf8").trim());
      } catch {
        // unreadable: treat as stale
      }
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) return undefined;
      try {
        unlinkSync(lock);
      } catch {
        // raced with another process
      }
    }
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Subscribes to OBS events on `conn` and writes them to the timeline. */
export class TimelineRecorder {
  private readonly conn: ObsConnection;
  private readonly writer: TimelineWriter;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly sceneItemNames = new Map<string, string>();

  constructor(conn: ObsConnection, writer: TimelineWriter, logger: Logger, now: () => Date = () => new Date()) {
    this.conn = conn;
    this.writer = writer;
    this.logger = logger;
    this.now = now;
  }

  start(): void {
    this.writer.write({ t: this.ts(), type: "recorder", state: "started" });
    this.conn.onConnected(async () => {
      this.writer.write({ t: this.ts(), type: "recorder", state: "connected" });
      await this.snapshot();
    });
    this.conn.onClosed(() => {
      this.writer.write({ t: this.ts(), type: "recorder", state: "disconnected" });
    });
    for (const event of TIMELINE_EVENTS) {
      this.conn.on(event, (data) => {
        void this.record(event, (data ?? {}) as Record<string, unknown>);
      });
    }
  }

  stop(reason?: string): void {
    this.writer.write({ t: this.ts(), type: "recorder", state: "stopped", ...(reason ? { reason } : {}) });
  }

  async snapshot(): Promise<void> {
    try {
      const [scene, stream, record] = await Promise.all([
        this.conn.call("GetCurrentProgramScene"),
        this.conn.call("GetStreamStatus"),
        this.conn.call("GetRecordStatus"),
      ]);
      this.writer.write({
        t: this.ts(),
        type: "snapshot",
        programScene: scene.currentProgramSceneName ?? null,
        streaming: stream.outputActive,
        recording: record.outputActive,
        ...(stream.outputActive ? { streamDurationMs: stream.outputDuration } : {}),
        ...(record.outputActive ? { recordDurationMs: record.outputDuration } : {}),
      });
    } catch (err) {
      this.logger.warn(`Timeline snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async record(event: string, data: Record<string, unknown>): Promise<void> {
    const t = this.ts();
    const extra: Record<string, unknown> = {};
    if (event === "SceneItemEnableStateChanged" && typeof data.sceneName === "string" && typeof data.sceneItemId === "number") {
      extra.sourceName = await this.sceneItemName(data.sceneName, data.sceneItemId);
    }
    this.writer.write({ t, type: "event", event, data: { ...data, ...extra } });
  }

  private async sceneItemName(sceneName: string, id: number): Promise<string | undefined> {
    const key = `${sceneName}\u0000${id}`;
    const cached = this.sceneItemNames.get(key);
    if (cached) return cached;
    try {
      const { sceneItems } = await this.conn.call("GetSceneItemList", { sceneName });
      for (const it of sceneItems) this.sceneItemNames.set(`${sceneName}\u0000${String(it.sceneItemId)}`, String(it.sourceName));
    } catch {
      return undefined;
    }
    return this.sceneItemNames.get(key);
  }

  private ts(): string {
    return this.now().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Reading and summarising

export interface SceneSegment {
  scene: string;
  start: string;
  end: string | null;
  durationSec: number;
  /** Seconds since the stream started, if a stream was running when this segment started. */
  streamOffsetSec?: number;
  /** Seconds since the main recording started, if it was running. */
  recordOffsetSec?: number;
  endReason?: "scene_change" | "output_change" | "recorder_gap" | "open";
}

export interface Session {
  start: string;
  end: string | null;
  durationSec: number;
  outputPath?: string;
}

export interface TimelineSummary {
  file: string;
  lines: number;
  badLines: number;
  first: string | null;
  last: string | null;
  segments: SceneSegment[];
  segmentsTruncated: boolean;
  timePerScene: Record<string, number>;
  streams: Session[];
  recordings: Session[];
  eventCounts: Record<string, number>;
  at?: { time: string; scene: string | null; streaming: boolean; recording: boolean; streamOffsetSec?: number; recordOffsetSec?: number };
}

export function parseTimeline(text: string): { lines: TimelineLine[]; bad: number } {
  const lines: TimelineLine[] = [];
  let bad = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as TimelineLine;
      if (v && typeof v.t === "string" && !Number.isNaN(Date.parse(v.t))) lines.push(v);
      else bad++;
    } catch {
      bad++;
    }
  }
  lines.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { lines, bad };
}

const secs = (a: string, b: string): number => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 100) / 10);

export function summarizeTimeline(
  file: string,
  text: string,
  opts: {
    from?: string;
    to?: string;
    at?: string;
    /** Instead of `at`: seconds into a stream (e.g. a VOD timestamp). */
    atStreamOffsetSec?: number;
    /** Which stream `atStreamOffsetSec` refers to: 0 = first in the file, -1 = last (default). */
    streamIndex?: number;
    maxSegments?: number;
    now?: Date;
  } = {},
): TimelineSummary {
  const { lines, bad } = parseTimeline(text);
  const now = (opts.now ?? new Date()).toISOString();
  const maxSegments = opts.maxSegments ?? 300;

  const segments: SceneSegment[] = [];
  const streams: Session[] = [];
  const recordings: Session[] = [];
  const eventCounts: Record<string, number> = {};

  let scene: string | null = null;
  let segStart: string | null = null;
  let segStreamOffset: number | undefined;
  let segRecordOffset: number | undefined;
  let streamStart: string | null = null;
  let recordStart: string | null = null;
  let recordPath: string | undefined;

  const closeSegment = (t: string, reason: SceneSegment["endReason"]): void => {
    if (scene !== null && segStart !== null) {
      const seg: SceneSegment = { scene, start: segStart, end: t, durationSec: secs(segStart, t), endReason: reason };
      if (segStreamOffset !== undefined) seg.streamOffsetSec = segStreamOffset;
      if (segRecordOffset !== undefined) seg.recordOffsetSec = segRecordOffset;
      segments.push(seg);
    }
    segStart = null;
  };
  const openSegment = (sc: string | null, t: string): void => {
    scene = sc;
    segStart = sc === null ? null : t;
    segStreamOffset = streamStart ? secs(streamStart, t) : undefined;
    segRecordOffset = recordStart ? secs(recordStart, t) : undefined;
  };
  /** Outputs started or stopped: split the segment so each one is wholly inside or outside a session. */
  const splitSegment = (t: string): void => {
    if (scene === null || segStart === null) return;
    const sc = scene;
    if (segStart !== t) closeSegment(t, "output_change");
    openSegment(sc, t);
  };

  for (const l of lines) {
    if (l.type === "recorder") {
      if (l.state === "disconnected" || l.state === "stopped" || l.state === "started") {
        closeSegment(l.t, "recorder_gap");
        scene = null;
        // While blind we cannot know when outputs stopped; close sessions at the gap.
        if (streamStart) streams.push({ start: streamStart, end: l.t, durationSec: secs(streamStart, l.t) });
        if (recordStart) recordings.push({ start: recordStart, end: l.t, durationSec: secs(recordStart, l.t), ...(recordPath ? { outputPath: recordPath } : {}) });
        streamStart = null;
        recordStart = null;
        recordPath = undefined;
      }
    } else if (l.type === "snapshot") {
      if (l.programScene !== scene) {
        closeSegment(l.t, "scene_change");
        openSegment(l.programScene, l.t);
      }
      // A snapshot taken mid-stream (e.g. after a reconnect) knows how long the
      // output has been running, so offsets stay true to the stream/VOD clock.
      const back = (ms: number | undefined): string => new Date(Date.parse(l.t) - (ms ?? 0)).toISOString();
      let changed = false;
      if (l.streaming && !streamStart) {
        streamStart = back(l.streamDurationMs);
        changed = true;
      }
      if (l.recording && !recordStart) {
        recordStart = back(l.recordDurationMs);
        changed = true;
      }
      if (changed) splitSegment(l.t);
    } else if (l.type === "event") {
      eventCounts[l.event] = (eventCounts[l.event] ?? 0) + 1;
      const d = l.data;
      if (l.event === "CurrentProgramSceneChanged" && typeof d.sceneName === "string") {
        if (d.sceneName !== scene) {
          closeSegment(l.t, "scene_change");
          openSegment(d.sceneName, l.t);
        }
      } else if (l.event === "StreamStateChanged") {
        if (d.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") {
          streamStart = l.t;
          splitSegment(l.t);
        }
        if (d.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED" && streamStart) {
          streams.push({ start: streamStart, end: l.t, durationSec: secs(streamStart, l.t) });
          streamStart = null;
          splitSegment(l.t);
        }
      } else if (l.event === "RecordStateChanged") {
        if (d.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") {
          recordStart = l.t;
          recordPath = typeof d.outputPath === "string" ? d.outputPath : undefined;
          splitSegment(l.t);
        }
        if (d.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED" && recordStart) {
          const p = typeof d.outputPath === "string" ? d.outputPath : recordPath;
          recordings.push({ start: recordStart, end: l.t, durationSec: secs(recordStart, l.t), ...(p ? { outputPath: p } : {}) });
          recordStart = null;
          recordPath = undefined;
          splitSegment(l.t);
        }
      }
    }
  }
  if (scene !== null && segStart !== null) {
    const seg: SceneSegment = { scene, start: segStart, end: null, durationSec: secs(segStart, now), endReason: "open" };
    if (segStreamOffset !== undefined) seg.streamOffsetSec = segStreamOffset;
    if (segRecordOffset !== undefined) seg.recordOffsetSec = segRecordOffset;
    segments.push(seg);
  }
  if (streamStart) streams.push({ start: streamStart, end: null, durationSec: secs(streamStart, now) });
  if (recordStart) recordings.push({ start: recordStart, end: null, durationSec: secs(recordStart, now), ...(recordPath ? { outputPath: recordPath } : {}) });

  // Window
  const fromMs = opts.from ? Date.parse(opts.from) : -Infinity;
  const toMs = opts.to ? Date.parse(opts.to) : Infinity;
  const overlaps = (s: { start: string; end: string | null }): boolean =>
    Date.parse(s.start) <= toMs && (s.end === null ? Date.parse(now) : Date.parse(s.end)) >= fromMs;
  const windowed = segments.filter(overlaps);

  const timePerScene: Record<string, number> = {};
  for (const s of windowed) timePerScene[s.scene] = Math.round(((timePerScene[s.scene] ?? 0) + s.durationSec) * 10) / 10;

  const summary: TimelineSummary = {
    file,
    lines: lines.length,
    badLines: bad,
    first: lines[0]?.t ?? null,
    last: lines[lines.length - 1]?.t ?? null,
    segments: windowed.slice(-maxSegments),
    segmentsTruncated: windowed.length > maxSegments,
    timePerScene,
    streams: streams.filter(overlaps),
    recordings: recordings.filter(overlaps),
    eventCounts,
  };

  let atIso = opts.at;
  if (atIso === undefined && opts.atStreamOffsetSec !== undefined && streams.length > 0) {
    const idx = opts.streamIndex ?? -1;
    const st = streams[idx < 0 ? streams.length + idx : idx];
    if (st) atIso = new Date(Date.parse(st.start) + opts.atStreamOffsetSec * 1000).toISOString();
  }
  if (atIso) {
    const atMs = Date.parse(atIso);
    const seg = segments.find((s) => Date.parse(s.start) <= atMs && (s.end === null || Date.parse(s.end) > atMs));
    const inSession = (list: Session[]): Session | undefined =>
      list.find((s) => Date.parse(s.start) <= atMs && (s.end === null || Date.parse(s.end) > atMs));
    const st = inSession(streams);
    const rec = inSession(recordings);
    const time = new Date(atMs).toISOString();
    summary.at = {
      time,
      scene: seg?.scene ?? null,
      streaming: Boolean(st),
      recording: Boolean(rec),
      ...(st ? { streamOffsetSec: secs(st.start, time) } : {}),
      ...(rec ? { recordOffsetSec: secs(rec.start, time) } : {}),
    };
  }
  return summary;
}
