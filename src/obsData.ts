import type { JsonObject } from "type-fest";
import type { ObsClient } from "./obs.ts";
import { redactSettings } from "./redact.ts";

/** Helpers that turn raw obs-websocket answers into what the tools report. */

export interface LiveState {
  streaming: boolean;
  recording: boolean;
  recordingPaused: boolean;
  virtualCam: boolean | undefined;
  replayBuffer: boolean | undefined;
}

async function optional<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export async function getLiveState(obs: ObsClient): Promise<LiveState> {
  const [stream, record, vcam, replay] = await Promise.all([
    obs.call("GetStreamStatus"),
    obs.call("GetRecordStatus"),
    optional(obs.call("GetVirtualCamStatus")),
    optional(obs.call("GetReplayBufferStatus")),
  ]);
  return {
    streaming: stream.outputActive,
    recording: record.outputActive,
    recordingPaused: record.outputPaused,
    virtualCam: vcam?.outputActive,
    replayBuffer: replay?.outputActive,
  };
}

export function isLive(s: LiveState): boolean {
  return s.streaming || s.recording;
}

export interface SourceRef {
  sourceName: string;
  /** "scene" or the input kind (e.g. "dshow_input"). */
  kind: string;
  isScene: boolean;
}

/** All inputs and scenes: everything that can carry filters. */
export async function listAllSources(obs: ObsClient): Promise<SourceRef[]> {
  const [{ inputs }, { scenes }] = await Promise.all([obs.call("GetInputList"), obs.call("GetSceneList")]);
  const out: SourceRef[] = [];
  for (const s of scenes) out.push({ sourceName: String(s.sceneName), kind: "scene", isScene: true });
  for (const i of inputs) out.push({ sourceName: String(i.inputName), kind: String(i.inputKind), isScene: false });
  return out;
}

export interface FilterInfo {
  sourceName: string;
  filterName: string;
  filterKind: string;
  filterIndex: number;
  filterEnabled: boolean;
  /** Settings with OBS defaults filled in (obs-websocket only returns changed values). */
  settings: JsonObject;
  /** Names of the settings that were explicitly set (the rest are defaults). */
  explicitKeys: string[];
}

/** Caches default settings per filter/input kind for the lifetime of one tool call. */
export class DefaultsCache {
  private readonly filters = new Map<string, Promise<JsonObject>>();
  private readonly inputs = new Map<string, Promise<JsonObject>>();
  private readonly obs: ObsClient;
  constructor(obs: ObsClient) {
    this.obs = obs;
  }

  filterDefaults(kind: string): Promise<JsonObject> {
    let p = this.filters.get(kind);
    if (!p) {
      p = this.obs
        .call("GetSourceFilterDefaultSettings", { filterKind: kind })
        .then((r) => r.defaultFilterSettings)
        .catch(() => ({}));
      this.filters.set(kind, p);
    }
    return p;
  }

  inputDefaults(kind: string): Promise<JsonObject> {
    let p = this.inputs.get(kind);
    if (!p) {
      p = this.obs
        .call("GetInputDefaultSettings", { inputKind: kind })
        .then((r) => r.defaultInputSettings)
        .catch(() => ({}));
      this.inputs.set(kind, p);
    }
    return p;
  }
}

export async function getFilters(obs: ObsClient, sourceName: string, defaults: DefaultsCache): Promise<FilterInfo[]> {
  const { filters } = await obs.call("GetSourceFilterList", { sourceName });
  return Promise.all(
    filters.map(async (f) => {
      const kind = String(f.filterKind);
      const own = (f.filterSettings ?? {}) as JsonObject;
      const defs = await defaults.filterDefaults(kind);
      return {
        sourceName,
        filterName: String(f.filterName),
        filterKind: kind,
        filterIndex: Number(f.filterIndex),
        filterEnabled: Boolean(f.filterEnabled),
        settings: { ...defs, ...own },
        explicitKeys: Object.keys(own),
      };
    }),
  );
}

export async function getMergedInputSettings(
  obs: ObsClient,
  inputName: string,
  defaults: DefaultsCache,
): Promise<{ inputKind: string; settings: JsonObject; explicitKeys: string[] }> {
  const r = await obs.call("GetInputSettings", { inputName });
  const defs = await defaults.inputDefaults(r.inputKind);
  return { inputKind: r.inputKind, settings: { ...defs, ...r.inputSettings }, explicitKeys: Object.keys(r.inputSettings) };
}

/** Names of every source visible in a scene, walking nested scenes and groups. */
export async function sourcesInScene(obs: ObsClient, sceneName: string, seen = new Set<string>()): Promise<Set<string>> {
  const out = new Set<string>();
  if (seen.has(sceneName)) return out;
  seen.add(sceneName);
  let items: JsonObject[];
  try {
    items = (await obs.call("GetSceneItemList", { sceneName })).sceneItems;
  } catch {
    try {
      items = (await obs.call("GetGroupSceneItemList", { sceneName })).sceneItems;
    } catch {
      return out;
    }
  }
  for (const it of items) {
    if (!it.sceneItemEnabled) continue;
    const name = String(it.sourceName);
    out.add(name);
    if (it.sourceType === "OBS_SOURCE_TYPE_SCENE" || it.isGroup === true) {
      for (const n of await sourcesInScene(obs, name, seen)) out.add(n);
    }
  }
  return out;
}

/**
 * Shallow diff of two settings objects, for dry runs. Values of secret fields
 * are redacted here, because the field name sits in `field`, not as a key.
 */
export function diffSettings(
  before: JsonObject,
  after: JsonObject,
): Array<{ field: string; before: unknown; after: unknown }> {
  const red = (k: string, v: unknown): unknown => (redactSettings({ [k]: v }) as Record<string, unknown>)[k];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push({ field: k, before: red(k, before[k]), after: red(k, after[k]) });
  }
  return out;
}
