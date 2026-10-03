import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A small obs-websocket v5 server (JSON protocol) for tests. It implements the
 * handshake with real challenge/salt authentication and the requests this
 * project uses, over an in-memory model of OBS that tests can inspect.
 */

type Json = Record<string, unknown>;

export interface FakeFilter {
  name: string;
  kind: string;
  enabled: boolean;
  settings: Json;
}
export interface FakeInput {
  name: string;
  kind: string;
  settings: Json;
  muted?: boolean;
}
export interface FakeScene {
  name: string;
  items: Array<{ sourceName: string; id: number; enabled: boolean; inputKind?: string; isGroup?: boolean; sourceType?: string }>;
}

export interface FakeState {
  scenes: FakeScene[];
  program: string;
  inputs: FakeInput[];
  inputDefaults: Record<string, Json>;
  filters: Record<string, FakeFilter[]>;
  filterDefaults: Record<string, Json>;
  streaming: boolean;
  recording: boolean;
  video: { baseWidth: number; baseHeight: number; outputWidth: number; outputHeight: number; fpsNumerator: number; fpsDenominator: number };
  stats: { activeFps: number; availableDiskSpace: number; renderSkippedFrames: number; renderTotalFrames: number };
  recordDirectory: string;
  streamService: { type: string; settings: Json };
  /** Media state (OBS_MEDIA_STATE_*) per Media Source input; inputs not listed answer "none". */
  media?: Record<string, string>;
}

export const MUTATING_REQUESTS = new Set([
  "SetCurrentProgramScene",
  "SetSourceFilterSettings",
  "SetSourceFilterEnabled",
  "SetSourceFilterIndex",
  "StartRecord",
  "StopRecord",
  "SetInputSettings",
  "StartStream",
  "StopStream",
]);

export function defaultState(): FakeState {
  return {
    scenes: [
      {
        name: "Main",
        items: [
          { sourceName: "Camera", id: 1, enabled: true, inputKind: "dshow_input" },
          { sourceName: "Screen", id: 2, enabled: true, inputKind: "monitor_capture" },
          { sourceName: "Mic", id: 3, enabled: true, inputKind: "wasapi_input_capture" },
          { sourceName: "Alerts", id: 4, enabled: true, inputKind: "browser_source" },
        ],
      },
      { name: "BRB", items: [{ sourceName: "Screen", id: 1, enabled: true, inputKind: "monitor_capture" }] },
    ],
    program: "Main",
    inputs: [
      { name: "Camera", kind: "dshow_input", settings: { video_device_id: "cam-1" } },
      { name: "Screen", kind: "monitor_capture", settings: { monitor: 0 } },
      { name: "Mic", kind: "wasapi_input_capture", settings: { device_id: "default" }, muted: false },
      {
        name: "Alerts",
        kind: "browser_source",
        settings: { url: "https://alerts.example.com/widget/SECRET-WIDGET-TOKEN-123?x=1", width: 800 },
      },
    ],
    inputDefaults: {
      dshow_input: { deactivate_when_not_showing: false, active: true },
      monitor_capture: { capture_cursor: true },
      wasapi_input_capture: {},
      browser_source: { width: 800, height: 600, fps: 30 },
    },
    filters: {
      Camera: [
        {
          name: "Record cam",
          kind: "source_record_filter",
          enabled: true,
          settings: { record_mode: 2, encoder: "h264_texture_amf", rate_control: "CQP", filename_formatting: "cam %CCYY-%MM-%DD %hh-%mm-%ss", different_audio: true, audio_source: "Mic", key: "fake_sr_key_abc" },
        },
        { name: "Rounded", kind: "mask_filter_v2", enabled: true, settings: {} },
      ],
      Screen: [
        {
          name: "Record screen",
          kind: "source_record_filter",
          enabled: true,
          settings: { record_mode: 2, encoder: "h264_texture_amf", rate_control: "CQP", filename_formatting: "screen %CCYY-%MM-%DD %hh-%mm-%ss" },
        },
      ],
    },
    filterDefaults: {
      source_record_filter: {
        path: "C:/Users/example/Videos",
        filename_formatting: "%CCYY-%MM-%DD %hh-%mm-%ss",
        rec_format: "hybrid_mp4",
        encoder: "obs_x264",
        rate_control: "CBR",
        bitrate: 6000,
        crf: 23,
        max_time_sec: 900,
        max_size_mb: 2048,
      },
      mask_filter_v2: { type: 0 },
      crop_filter: { left: 0 },
    },
    streaming: false,
    recording: false,
    video: { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 },
    stats: { activeFps: 30, availableDiskSpace: 200 * 1024, renderSkippedFrames: 0, renderTotalFrames: 1000 },
    recordDirectory: "C:\\Users\\example\\Videos",
    streamService: { type: "rtmp_custom", settings: { server: "rtmp://live.example.com/app", key: "fake_stream_key_987" } },
  };
}

class RequestError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class FakeObs {
  state: FakeState;
  readonly password: string | undefined;
  readonly requests: Array<{ type: string; data: Json }> = [];
  authFailures = 0;
  private wss: WebSocketServer | undefined;
  private readonly clients = new Set<WebSocket>();

  constructor(opts: { password?: string; state?: FakeState } = {}) {
    this.password = opts.password;
    this.state = opts.state ?? defaultState();
  }

  get port(): number {
    return (this.wss!.address() as AddressInfo).port;
  }

  get mutations(): Array<{ type: string; data: Json }> {
    return this.requests.filter((r) => MUTATING_REQUESTS.has(r.type));
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) => (protocols.has("obswebsocket.json") ? "obswebsocket.json" : false),
    });
    await new Promise<void>((resolve) => this.wss!.once("listening", () => resolve()));
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  /** Sends an event to every identified client. */
  emit(eventType: string, eventData: Json = {}): void {
    for (const c of this.clients) c.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } }));
  }

  /** Drops every connection, as if OBS closed. */
  dropClients(): void {
    for (const c of this.clients) c.close(1001, "OBS closed");
  }

  private onConnection(ws: WebSocket): void {
    const salt = randomBytes(16).toString("base64");
    const challenge = randomBytes(16).toString("base64");
    ws.send(
      JSON.stringify({
        op: 0,
        d: { obsWebSocketVersion: "5.7.4", rpcVersion: 1, ...(this.password ? { authentication: { challenge, salt } } : {}) },
      }),
    );
    let identified = false;
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { op: number; d: Json };
      if (msg.op === 1) {
        if (this.password) {
          const secret = createHash("sha256").update(this.password + salt).digest("base64");
          const expected = createHash("sha256").update(secret + challenge).digest("base64");
          if (msg.d.authentication !== expected) {
            this.authFailures++;
            ws.close(4009, "Authentication failed.");
            return;
          }
        }
        identified = true;
        this.clients.add(ws);
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (msg.op === 6 && identified) {
        const { requestType, requestId, requestData } = msg.d as { requestType: string; requestId: string; requestData?: Json };
        this.requests.push({ type: requestType, data: requestData ?? {} });
        let d: Json;
        try {
          const responseData = this.handle(requestType, requestData ?? {});
          d = { requestType, requestId, requestStatus: { result: true, code: 100 }, ...(responseData ? { responseData } : {}) };
        } catch (err) {
          const e = err instanceof RequestError ? err : new RequestError(500, String(err));
          d = { requestType, requestId, requestStatus: { result: false, code: e.code, comment: e.message } };
        }
        ws.send(JSON.stringify({ op: 7, d }));
      }
    });
    ws.on("close", () => this.clients.delete(ws));
  }

  private input(name: unknown): FakeInput {
    const i = this.state.inputs.find((x) => x.name === name);
    if (!i) throw new RequestError(600, `No source was found by the name of \`${String(name)}\`.`);
    return i;
  }
  private filtersOf(sourceName: unknown): FakeFilter[] {
    const name = String(sourceName);
    if (!this.state.inputs.some((i) => i.name === name) && !this.state.scenes.some((s) => s.name === name))
      throw new RequestError(600, `No source was found by the name of \`${name}\`.`);
    return (this.state.filters[name] ??= []);
  }
  private filter(sourceName: unknown, filterName: unknown): FakeFilter {
    const f = this.filtersOf(sourceName).find((x) => x.name === filterName);
    if (!f) throw new RequestError(600, `No filter was found by the name of \`${String(filterName)}\`.`);
    return f;
  }

  private handle(type: string, d: Json): Json | undefined {
    const s = this.state;
    switch (type) {
      case "GetVersion":
        return { obsVersion: "32.0.0", obsWebSocketVersion: "5.7.4", rpcVersion: 1, platform: "windows", platformDescription: "Test", availableRequests: [], supportedImageFormats: [] };
      case "GetStats":
        return { cpuUsage: 3, memoryUsage: 200, outputSkippedFrames: 0, outputTotalFrames: 0, averageFrameRenderTime: 2, webSocketSessionIncomingMessages: 1, webSocketSessionOutgoingMessages: 1, ...s.stats };
      case "GetStreamStatus":
        return { outputActive: s.streaming, outputReconnecting: false, outputTimecode: "00:00:00.000", outputDuration: 0, outputCongestion: 0, outputBytes: 0, outputSkippedFrames: 0, outputTotalFrames: 0 };
      case "GetRecordStatus":
        return { outputActive: s.recording, outputPaused: false, outputTimecode: s.recording ? "00:10:00.000" : "00:00:00.000", outputDuration: 0, outputBytes: 0 };
      case "GetVirtualCamStatus":
        return { outputActive: false };
      case "GetReplayBufferStatus":
        throw new RequestError(604, "Replay buffer is not available.");
      case "GetCurrentProgramScene":
        return { currentProgramSceneName: s.program, sceneName: s.program };
      case "GetStudioModeEnabled":
        return { studioModeEnabled: false };
      case "GetVideoSettings":
        return { ...s.video };
      case "GetRecordDirectory":
        return { recordDirectory: s.recordDirectory };
      case "GetProfileList":
        return { currentProfileName: "Default", profiles: ["Default"] };
      case "GetSceneCollectionList":
        return { currentSceneCollectionName: "Default", sceneCollections: ["Default"] };
      case "GetSceneList":
        return {
          currentProgramSceneName: s.program,
          currentPreviewSceneName: null,
          scenes: s.scenes.map((sc, i) => ({ sceneName: sc.name, sceneIndex: s.scenes.length - 1 - i })),
        };
      case "GetSceneItemList": {
        const sc = s.scenes.find((x) => x.name === d.sceneName);
        if (!sc) throw new RequestError(600, "No scene.");
        return {
          sceneItems: sc.items.map((it, i) => ({
            sourceName: it.sourceName,
            sceneItemId: it.id,
            sceneItemEnabled: it.enabled,
            sceneItemIndex: sc.items.length - 1 - i,
            inputKind: it.inputKind ?? null,
            isGroup: it.isGroup ?? false,
            sourceType: it.sourceType ?? "OBS_SOURCE_TYPE_INPUT",
          })),
        };
      }
      case "GetGroupSceneItemList":
        throw new RequestError(600, "No group.");
      case "GetInputList":
        return {
          inputs: s.inputs
            .filter((i) => !d.inputKind || i.kind === d.inputKind)
            .map((i) => ({ inputName: i.name, inputKind: i.kind, unversionedInputKind: i.kind })),
        };
      case "GetInputSettings": {
        const i = this.input(d.inputName);
        return { inputKind: i.kind, inputSettings: structuredClone(i.settings) };
      }
      case "GetInputDefaultSettings":
        return { defaultInputSettings: structuredClone(s.inputDefaults[String(d.inputKind)] ?? {}) };
      case "GetInputMute":
        return { inputMuted: this.input(d.inputName).muted ?? false };
      case "GetMediaInputStatus": {
        const i = this.input(d.inputName);
        return { mediaState: s.media?.[i.name] ?? "OBS_MEDIA_STATE_NONE", mediaDuration: -1, mediaCursor: 0 };
      }
      case "SetInputSettings": {
        const i = this.input(d.inputName);
        i.settings = d.overlay === false ? (d.inputSettings as Json) : { ...i.settings, ...(d.inputSettings as Json) };
        return undefined;
      }
      case "GetSourceFilterList":
        return {
          filters: this.filtersOf(d.sourceName).map((f, i) => ({
            filterName: f.name,
            filterKind: f.kind,
            filterIndex: i,
            filterEnabled: f.enabled,
            filterSettings: structuredClone(f.settings),
          })),
        };
      case "GetSourceFilter": {
        const list = this.filtersOf(d.sourceName);
        const f = this.filter(d.sourceName, d.filterName);
        return { filterEnabled: f.enabled, filterIndex: list.indexOf(f), filterKind: f.kind, filterSettings: structuredClone(f.settings) };
      }
      case "GetSourceFilterDefaultSettings":
        return { defaultFilterSettings: structuredClone(s.filterDefaults[String(d.filterKind)] ?? {}) };
      case "SetSourceFilterSettings": {
        const f = this.filter(d.sourceName, d.filterName);
        f.settings = d.overlay === false ? (d.filterSettings as Json) : { ...f.settings, ...(d.filterSettings as Json) };
        return undefined;
      }
      case "SetSourceFilterEnabled":
        this.filter(d.sourceName, d.filterName).enabled = Boolean(d.filterEnabled);
        return undefined;
      case "SetSourceFilterIndex": {
        const list = this.filtersOf(d.sourceName);
        const f = this.filter(d.sourceName, d.filterName);
        list.splice(list.indexOf(f), 1);
        list.splice(Number(d.filterIndex), 0, f);
        return undefined;
      }
      case "SetCurrentProgramScene":
        if (!s.scenes.some((x) => x.name === d.sceneName)) throw new RequestError(600, "No scene.");
        s.program = String(d.sceneName);
        return undefined;
      case "StartRecord":
        s.recording = true;
        return undefined;
      case "StopRecord":
        s.recording = false;
        return { outputPath: "C:/Users/example/Videos/rec.mkv" };
      case "GetOutputList":
        return { outputs: [{ outputName: "adv_file_output", outputKind: "mp4_output", outputActive: s.recording }] };
      case "GetStreamServiceSettings":
        return { streamServiceType: s.streamService.type, streamServiceSettings: structuredClone(s.streamService.settings) };
      default:
        throw new RequestError(204, `Unknown request type ${type}`);
    }
  }
}
