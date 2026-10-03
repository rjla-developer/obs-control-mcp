import type { JsonObject } from "type-fest";
import type { ObsClient } from "./obs.ts";
import { DefaultsCache, getFilters, getLiveState, getMergedInputSettings, type FilterInfo, type LiveState } from "./obsData.ts";
import { SOURCE_RECORD_KIND, type Check, type CheckStatus } from "./sourceRecord.ts";

/**
 * Readiness check for an IRL setup: «¿listo para salir a la calle?».
 *
 * The phone/camera feed arrives in a Media Source (`ffmpeg_source`) inside a
 * live scene; a BRB scene covers the dropouts; a switcher (`brb.ts`) moves
 * between the two. This checks that OBS is wired so that the switcher can do
 * its job and nothing is lost. Collection is read-only; analysis is pure.
 *
 * Only the protocol of the feed URL is ever reported, never the URL itself
 * (it carries the relay host and, with SRT, the passphrase).
 */

export interface IrlNames {
  liveScene: string;
  brbScene: string;
  feedInput: string;
}

export const DEFAULT_IRL_NAMES: IrlNames = { liveScene: "IRL", brbScene: "Ahorita regreso", feedInput: "Señal IRL" };

export const MEDIA_SOURCE_KINDS = new Set(["ffmpeg_source"]);
export const NETWORK_PROTOCOLS = new Set(["srt", "rtmp", "rtmps", "rist", "udp", "rtsp", "rtsps"]);

export interface IrlSceneInfo {
  sceneName: string;
  items: Array<{ sourceName: string; enabled: boolean; inputKind: string | null }>;
}

export interface IrlFeedInfo {
  inputKind: string;
  /** Merged settings (OBS defaults filled in). */
  settings: JsonObject;
  filters: Array<Pick<FilterInfo, "filterName" | "filterKind" | "filterEnabled">>;
  /** OBS media state right now (OBS_MEDIA_STATE_*), when OBS answered. */
  mediaState: string | undefined;
}

export interface IrlContext {
  names: IrlNames;
  scenes: IrlSceneInfo[];
  programScene: string | undefined;
  feed: IrlFeedInfo | undefined;
  live: LiveState;
  video: { baseWidth: number; baseHeight: number; fpsNumerator: number; fpsDenominator: number };
  stats: { availableDiskSpace: number; activeFps: number };
  streamService: { type: string; server: string } | undefined;
}

export async function collectIrlContext(obs: ObsClient, names: IrlNames): Promise<IrlContext> {
  const defaults = new DefaultsCache(obs);
  const [list, live, video, stats, service] = await Promise.all([
    obs.call("GetSceneList"),
    getLiveState(obs),
    obs.call("GetVideoSettings"),
    obs.call("GetStats"),
    obs.call("GetStreamServiceSettings").catch(() => undefined),
  ]);
  const scenes: IrlSceneInfo[] = await Promise.all(
    [...list.scenes]
      .sort((a, b) => Number(b.sceneIndex) - Number(a.sceneIndex))
      .map(async (s) => {
        const sceneName = String(s.sceneName);
        const { sceneItems } = await obs.call("GetSceneItemList", { sceneName });
        return {
          sceneName,
          items: sceneItems.map((it) => ({
            sourceName: String(it.sourceName),
            enabled: Boolean(it.sceneItemEnabled),
            inputKind: typeof it.inputKind === "string" ? it.inputKind : null,
          })),
        };
      }),
  );
  let feed: IrlFeedInfo | undefined;
  const { inputs } = await obs.call("GetInputList");
  if (inputs.some((i) => i.inputName === names.feedInput)) {
    const merged = await getMergedInputSettings(obs, names.feedInput, defaults);
    const [filters, media] = await Promise.all([
      getFilters(obs, names.feedInput, defaults).catch(() => [] as FilterInfo[]),
      obs.call("GetMediaInputStatus", { inputName: names.feedInput }).catch(() => undefined),
    ]);
    feed = {
      inputKind: merged.inputKind,
      settings: merged.settings,
      filters: filters.map((f) => ({ filterName: f.filterName, filterKind: f.filterKind, filterEnabled: f.filterEnabled })),
      mediaState: media?.mediaState,
    };
  }
  const serverRaw = service?.streamServiceSettings.server;
  return {
    names,
    scenes,
    programScene: list.currentProgramSceneName,
    feed,
    live,
    video: { baseWidth: video.baseWidth, baseHeight: video.baseHeight, fpsNumerator: video.fpsNumerator, fpsDenominator: video.fpsDenominator },
    stats: { availableDiskSpace: stats.availableDiskSpace, activeFps: stats.activeFps },
    streamService: service ? { type: service.streamServiceType, server: typeof serverRaw === "string" ? serverRaw : "" } : undefined,
  };
}

export type IrlVerdict = "ready" | "ready_with_warnings" | "not_ready";

export interface IrlReport {
  verdict: IrlVerdict;
  /** Spanish one-liner: «¿listo para salir a la calle?». */
  veredicto: string;
  summary: string;
  names: IrlNames;
  programScene: string | undefined;
  live: LiveState;
  checks: Check[];
}

const VEREDICTO: Record<IrlVerdict, string> = {
  ready: "Sí, OBS está listo para el IRL.",
  ready_with_warnings: "Sí, pero revisa los avisos antes de salir.",
  not_ready: "No está listo: hay que corregir lo marcado como «fail».",
};

/** Protocol of a URL-like string ("srt", "rtmp", ...), or undefined. */
export function protocolOf(input: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input.trim());
  return m ? m[1]!.toLowerCase() : undefined;
}

export const MIN_FREE_DISK_MB = 5 * 1024;
export const MAX_RECONNECT_DELAY_SEC = 5;

/** Pure analysis: every rule lives here. */
export function analyzeIrl(ctx: IrlContext): IrlReport {
  const { names, feed } = ctx;
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, message: string): void => {
    checks.push({ id, status, message });
  };

  const liveScene = ctx.scenes.find((s) => s.sceneName === names.liveScene);
  const brbScene = ctx.scenes.find((s) => s.sceneName === names.brbScene);
  const sceneList = ctx.scenes.map((s) => s.sceneName).join(", ") || "none";

  if (liveScene) add("live_scene", "ok", `Live scene «${names.liveScene}» exists.`);
  else add("live_scene", "fail", `No scene named «${names.liveScene}». Scenes: ${sceneList}.`);
  if (brbScene) add("brb_scene", "ok", `BRB scene «${names.brbScene}» exists.`);
  else add("brb_scene", "fail", `No scene named «${names.brbScene}». Scenes: ${sceneList}.`);
  if (names.liveScene === names.brbScene) add("scenes_differ", "fail", "The live and BRB scenes are the same scene.");

  if (brbScene) {
    const content = brbScene.items.filter((i) => i.enabled);
    if (content.length === 0) add("brb_content", "warn", `«${names.brbScene}» has no enabled sources: viewers would see black while you are away.`);
    else add("brb_content", "ok", `«${names.brbScene}» shows ${content.length} source(s).`);
  }

  if (!feed) {
    add("feed_input", "fail", `No input named «${names.feedInput}». Create a Media Source with that name (or pass feedInput).`);
  } else {
    add("feed_input", "ok", `Feed input «${names.feedInput}» exists (${feed.inputKind}).`);
    if (MEDIA_SOURCE_KINDS.has(feed.inputKind)) add("feed_kind", "ok", "It is a Media Source.");
    else add("feed_kind", "fail", `«${names.feedInput}» is a ${feed.inputKind}, not a Media Source (ffmpeg_source): the switcher reads the media state and only a Media Source has one.`);

    if (liveScene) {
      const item = liveScene.items.find((i) => i.sourceName === names.feedInput);
      if (item?.enabled) add("feed_in_live", "ok", `«${names.feedInput}» is visible in «${names.liveScene}».`);
      else if (item) add("feed_in_live", "fail", `«${names.feedInput}» is in «${names.liveScene}» but hidden.`);
      else add("feed_in_live", "fail", `«${names.feedInput}» is not in «${names.liveScene}»: nobody would see the feed.`);
    }
    if (brbScene) {
      const item = brbScene.items.find((i) => i.sourceName === names.feedInput);
      if (item?.enabled) add("feed_not_in_brb", "warn", `«${names.feedInput}» is also visible in «${names.brbScene}»: a dropped feed would show its frozen or black frame there too.`);
      else add("feed_not_in_brb", "ok", `«${names.feedInput}» is not shown in «${names.brbScene}».`);
    }

    const s = feed.settings;
    if (s.is_local_file === false) {
      add("feed_network", "ok", "The Media Source reads a network input, not a local file.");
      const input = typeof s.input === "string" ? s.input : "";
      const protocol = protocolOf(input);
      if (!input) add("feed_url", "fail", "The Media Source has no input URL.");
      else if (!protocol) add("feed_url", "fail", "The input is not a URL (no scheme).");
      else if (!NETWORK_PROTOCOLS.has(protocol)) add("feed_url", "warn", `The input uses ${protocol}://, which is not a live-stream protocol (expected srt, rtmp, rtmps, rist or udp).`);
      else add("feed_url", "ok", `The input is a ${protocol}:// URL.`);
      if (protocol === "srt") {
        if (/[?&]passphrase=[^&]+/.test(input)) add("srt_passphrase", "ok", "The SRT URL carries a passphrase (encrypted).");
        else add("srt_passphrase", "warn", "The SRT URL has no passphrase: the feed travels unencrypted and anyone who finds the port can publish into it.");
      }
      if (protocol === "rtmp") add("rtmp_plain", "info", "RTMP is unencrypted; the stream key travels in the clear. Prefer SRT with a passphrase or RTMPS when the sender supports it.");
    } else {
      add("feed_network", "fail", "The Media Source is set to a local file: it must receive the network feed (uncheck «Local File»).");
    }

    const reconnect = typeof s.reconnect_delay_sec === "number" ? s.reconnect_delay_sec : undefined;
    if (reconnect === undefined) add("feed_reconnect", "info", "Reconnect delay not reported.");
    else if (reconnect > MAX_RECONNECT_DELAY_SEC) add("feed_reconnect", "warn", `Reconnect delay is ${reconnect} s: after every dropout OBS waits that long before trying again. 1–${MAX_RECONNECT_DELAY_SEC} s brings the feed back sooner.`);
    else add("feed_reconnect", "ok", `Reconnect delay is ${reconnect} s.`);

    if (s.close_when_inactive === true) add("feed_close_when_inactive", "fail", "«Close file when inactive» is on: while the BRB scene is on program the Media Source is closed, so it never reports the feed coming back and the switcher could never return to the live scene.");
    else add("feed_close_when_inactive", "ok", "The Media Source stays open while the BRB scene is on program.");
    if (s.restart_on_activate === true) add("feed_restart_on_activate", "info", "«Restart playback when source becomes active» is on: returning to the live scene re-opens the feed (a short gap). Fine for live inputs.");
    if (s.clear_on_media_end === false) add("feed_clear_on_end", "info", "«Show nothing when playback ends» is off: when the feed drops, the last frame stays frozen until the switcher reacts.");
    if (typeof s.hw_decode === "boolean") add("feed_hw_decode", "info", `Hardware decoding ${s.hw_decode ? "on" : "off"}.`);

    const iso = feed.filters.find((f) => f.filterKind === SOURCE_RECORD_KIND && f.filterEnabled);
    if (iso) add("feed_iso_record", "ok", `Source Record filter «${iso.filterName}» keeps a clean copy of the incoming feed.`);
    else add("feed_iso_record", "warn", "No enabled Source Record filter on the feed: the only recording would be the program with overlays baked in. A clean copy is what clips are cut from.");

    if (feed.mediaState === undefined) add("feed_now", "info", "OBS did not report the media state.");
    else if (feed.mediaState === "OBS_MEDIA_STATE_PLAYING") add("feed_now", "ok", "The feed is playing right now.");
    else add("feed_now", "info", `The feed is not playing right now (${feed.mediaState.replace("OBS_MEDIA_STATE_", "").toLowerCase()}). Normal before the sender starts.`);
  }

  if (!ctx.streamService) add("stream_service", "warn", "Could not read the stream service.");
  else if (!ctx.streamService.server) add("stream_service", "fail", "No stream server configured: OBS has nowhere to send the stream.");
  else add("stream_service", "ok", `Stream service: ${ctx.streamService.type}, ${protocolOf(ctx.streamService.server) ?? "?"}://… (key not shown).`);

  const fps = ctx.video.fpsDenominator > 0 ? ctx.video.fpsNumerator / ctx.video.fpsDenominator : 0;
  add("canvas", "info", `Canvas ${ctx.video.baseWidth}x${ctx.video.baseHeight} at ${fps.toFixed(fps % 1 === 0 ? 0 : 2)} fps.`);
  if (fps > 0 && ctx.stats.activeFps < fps * 0.9) add("render_fps", "warn", `OBS renders ${ctx.stats.activeFps.toFixed(1)} fps out of ${fps.toFixed(0)}: the PC is not keeping up.`);
  else add("render_fps", "ok", `OBS renders ${ctx.stats.activeFps.toFixed(1)} fps.`);

  const freeGb = ctx.stats.availableDiskSpace / 1024;
  if (ctx.stats.availableDiskSpace < MIN_FREE_DISK_MB) add("free_disk", "fail", `Only ${freeGb.toFixed(1)} GB free on the recording disk (minimum ${MIN_FREE_DISK_MB / 1024} GB).`);
  else add("free_disk", "ok", `${freeGb.toFixed(1)} GB free on the recording disk.`);

  if (ctx.programScene === names.liveScene || ctx.programScene === names.brbScene) add("program", "info", `«${ctx.programScene}» is on program: the switcher would act.`);
  else add("program", "info", `«${ctx.programScene ?? "?"}» is on program: the switcher stands by until «${names.liveScene}» or «${names.brbScene}» is selected.`);
  add("outputs", "info", `Now: ${ctx.live.streaming ? "streaming" : "not streaming"}, ${ctx.live.recording ? "recording" : "not recording"}.`);

  const counts = (st: CheckStatus): number => checks.filter((c) => c.status === st).length;
  const verdict: IrlVerdict = counts("fail") > 0 ? "not_ready" : counts("warn") > 0 ? "ready_with_warnings" : "ready";
  const summary = `${counts("fail")} fail, ${counts("warn")} warn, ${counts("ok")} ok.`;
  return { verdict, veredicto: VEREDICTO[verdict], summary, names, programScene: ctx.programScene, live: ctx.live, checks };
}
