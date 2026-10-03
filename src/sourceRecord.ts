import type { JsonObject } from "type-fest";
import type { ObsClient } from "./obs.ts";
import {
  DefaultsCache,
  getFilters,
  getLiveState,
  getMergedInputSettings,
  listAllSources,
  sourcesInScene,
  type FilterInfo,
  type LiveState,
} from "./obsData.ts";

/**
 * Readiness check for the Source Record plugin (exeldro/obs-source-record,
 * filter kind `source_record_filter`): «¿listo para grabar?».
 *
 * Collection talks to OBS (read-only requests); analysis is a pure function so
 * every rule is unit-tested against fixed inputs.
 */

export const SOURCE_RECORD_KIND = "source_record_filter";

/** record_mode / stream_mode values, from source-record.c. */
export const OUTPUT_MODES: Record<number, string> = {
  0: "none",
  1: "always",
  2: "streaming",
  3: "recording",
  4: "streaming_or_recording",
  5: "virtual_camera",
};

/** Filters that change what the image looks like (crop, masks, keys). Above Source Record they end up in the file. */
const SHAPING_FILTER =
  /^(mask_filter(_v2)?|crop_filter|chroma_key_filter(_v2)?|color_key_filter(_v2)?|luma_key_filter(_v2)?|advanced_masks_filter|shape_filter|blur_filter|composite_blur_filter|scale_filter|scroll_filter|gpu_delay|async_delay_filter|move_.*)$/;
const MASK_LIKE = /(mask|crop|key|blur)/;

/** Video capture devices: the ones with "deactivate when not showing". */
const CAPTURE_DEVICE_KINDS = new Set([
  "dshow_input",
  "av_capture_input",
  "av_capture_input_v2",
  "macos-avcapture",
  "macos-avcapture-fast",
  "v4l2_input",
  "decklink-input",
]);

/** Inputs that carry no audio of their own. */
const SILENT_KINDS = new Set([
  "monitor_capture",
  "image_source",
  "color_source",
  "color_source_v3",
  "text_gdiplus",
  "text_gdiplus_v2",
  "text_gdiplus_v3",
  "text_ft2_source",
  "text_ft2_source_v2",
  "slideshow",
  "slideshow_v2",
  "xshm_input",
  "xcomposite_input",
  "display_capture",
]);

/** OBS defaults for the quality value when the filter does not set it (from the OBS encoder sources). */
const DEFAULT_QP: Array<{ match: RegExp; key: string; value: number }> = [
  { match: /amf|^amd/, key: "cqp", value: 20 },
  { match: /nvenc/, key: "cqp", value: 20 },
  { match: /qsv/, key: "cqp", value: 23 },
  { match: /x264/, key: "crf", value: 23 },
];

export type CheckStatus = "ok" | "info" | "warn" | "fail";
export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
}

export interface SourceRecordFilterContext {
  filter: FilterInfo;
  sourceKind: string;
  isScene: boolean;
  siblings: Array<Pick<FilterInfo, "filterName" | "filterKind" | "filterIndex" | "filterEnabled">>;
  /** Merged input settings of the source the filter is on (inputs only). */
  sourceSettings: JsonObject | undefined;
  inProgramScene: boolean;
  audioSourceExists: boolean | undefined;
  audioSourceMuted: boolean | undefined;
}

export interface SourceRecordContext {
  filters: SourceRecordFilterContext[];
  live: LiveState;
  video: { baseWidth: number; baseHeight: number; outputWidth: number; outputHeight: number; fpsNumerator: number; fpsDenominator: number };
  stats: { activeFps: number; availableDiskSpace: number; renderSkippedFrames: number; renderTotalFrames: number; outputSkippedFrames: number; outputTotalFrames: number };
  recordDirectory: string | undefined;
  programScene: string | undefined;
}

export async function collectSourceRecordContext(obs: ObsClient): Promise<SourceRecordContext> {
  const defaults = new DefaultsCache(obs);
  const [sources, live, video, stats, recDir, program] = await Promise.all([
    listAllSources(obs),
    getLiveState(obs),
    obs.call("GetVideoSettings"),
    obs.call("GetStats"),
    obs.call("GetRecordDirectory").then((r) => r.recordDirectory).catch(() => undefined),
    obs.call("GetCurrentProgramScene").then((r) => r.currentProgramSceneName ?? r.sceneName).catch(() => undefined),
  ]);
  const inputNames = new Set(sources.filter((s) => !s.isScene).map((s) => s.sourceName));
  const allNames = new Set(sources.map((s) => s.sourceName));
  const visible = program ? await sourcesInScene(obs, String(program)) : new Set<string>();
  if (program) visible.add(String(program));

  const filters: SourceRecordFilterContext[] = [];
  for (const src of sources) {
    let list: FilterInfo[];
    try {
      list = await getFilters(obs, src.sourceName, defaults);
    } catch {
      continue;
    }
    const srs = list.filter((f) => f.filterKind === SOURCE_RECORD_KIND);
    if (srs.length === 0) continue;
    const sourceSettings = src.isScene ? undefined : (await getMergedInputSettings(obs, src.sourceName, defaults)).settings;
    for (const f of srs) {
      const differentAudio = f.settings.different_audio === true;
      const audioName = typeof f.settings.audio_source === "string" ? f.settings.audio_source : "";
      let audioSourceExists: boolean | undefined;
      let audioSourceMuted: boolean | undefined;
      if (differentAudio && audioName) {
        audioSourceExists = allNames.has(audioName);
        if (inputNames.has(audioName)) {
          audioSourceMuted = await obs
            .call("GetInputMute", { inputName: audioName })
            .then((r) => r.inputMuted)
            .catch(() => undefined);
        }
      }
      filters.push({
        filter: f,
        sourceKind: src.kind,
        isScene: src.isScene,
        siblings: list.map(({ filterName, filterKind, filterIndex, filterEnabled }) => ({ filterName, filterKind, filterIndex, filterEnabled })),
        sourceSettings,
        inProgramScene: visible.has(src.sourceName),
        audioSourceExists,
        audioSourceMuted,
      });
    }
  }
  return {
    filters,
    live,
    video,
    stats,
    recordDirectory: recDir,
    programScene: program === undefined ? undefined : String(program),
  };
}

export interface FilterReport {
  source: string;
  sourceKind: string;
  filter: string;
  /** Will this filter be writing a file right now, given the current outputs? */
  recordingNow: boolean;
  /** Full path pattern of the files it writes. */
  output: string;
  checks: Check[];
}

export type Verdict = "ready" | "ready_with_warnings" | "not_ready" | "no_source_record_filters";

export interface SourceRecordReport {
  verdict: Verdict;
  /** Spanish one-liner: «¿listo para grabar?». */
  veredicto: string;
  summary: string;
  live: LiveState;
  filters: FilterReport[];
  global: Check[];
}

const VEREDICTO: Record<Verdict, string> = {
  ready: "Sí, listo para grabar.",
  ready_with_warnings: "Sí, pero revisa los avisos antes de empezar.",
  not_ready: "No está listo: hay que corregir lo marcado como «fail».",
  no_source_record_filters: "No hay ningún filtro Source Record en OBS.",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function extensionFor(format: string): string {
  switch (format) {
    case "hybrid_mp4":
    case "fragmented_mp4":
      return "mp4";
    case "hybrid_mov":
    case "fragmented_mov":
      return "mov";
    case "":
      return "?";
    default:
      return format;
  }
}

function modeIsActive(mode: number, live: LiveState): boolean {
  switch (mode) {
    case 1:
      return true;
    case 2:
      return live.streaming;
    case 3:
      return live.recording;
    case 4:
      return live.streaming || live.recording;
    case 5:
      return live.virtualCam === true;
    default:
      return false;
  }
}

function drive(path: string): string | undefined {
  const m = /^([A-Za-z]):[\\/]/.exec(path);
  return m ? m[1]!.toUpperCase() : undefined;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Pure analysis: every rule lives here. */
export function analyzeSourceRecord(ctx: SourceRecordContext): SourceRecordReport {
  const { live, video, stats } = ctx;
  const fps = video.fpsDenominator > 0 ? video.fpsNumerator / video.fpsDenominator : 0;
  const reports: FilterReport[] = [];
  const global: Check[] = [];

  // Collisions are judged across all filters that write files.
  const outputKey = (f: SourceRecordFilterContext): string =>
    `${normalizePath(str(f.filter.settings.path))}|${str(f.filter.settings.filename_formatting)}|${extensionFor(str(f.filter.settings.rec_format))}`;
  const byOutput = new Map<string, string[]>();
  for (const f of ctx.filters) {
    if (!f.filter.filterEnabled || num(f.filter.settings.record_mode) === 0) continue;
    const k = outputKey(f);
    byOutput.set(k, [...(byOutput.get(k) ?? []), `${f.filter.sourceName} / ${f.filter.filterName}`]);
  }

  for (const f of ctx.filters) {
    const s = f.filter.settings;
    const checks: Check[] = [];
    const mode = num(s.record_mode) ?? 0;
    const modeName = OUTPUT_MODES[mode] ?? `unknown (${mode})`;
    const recordingNow = f.filter.filterEnabled && modeIsActive(mode, live);

    // 1. Enabled
    checks.push(
      f.filter.filterEnabled
        ? { id: "enabled", status: "ok", message: "Filter is enabled." }
        : { id: "enabled", status: "fail", message: "Filter is disabled: Source Record does not write anything while its filter is off." },
    );

    // 2. Record mode
    const when: Record<string, string> = {
      always: "records whenever OBS is open",
      streaming: "records while you stream",
      recording: "records while the main recording runs",
      streaming_or_recording: "records while you stream or record",
      virtual_camera: "records while the virtual camera is on",
    };
    if (mode === 0) {
      const other = num(s.stream_mode) || s.replay_buffer === true;
      checks.push({
        id: "record_mode",
        status: other ? "warn" : "fail",
        message: other
          ? "Record mode is «None»: no file is written (only its stream/replay buffer is used)."
          : "Record mode is «None»: this filter never writes a file.",
      });
    } else if (OUTPUT_MODES[mode]) {
      const state = recordingNow ? "It is recording right now." : "It is not recording right now.";
      checks.push({
        id: "record_mode",
        status: mode === 1 ? "warn" : "ok",
        message:
          `Record mode «${modeName}»: ${when[modeName]}. ${state}` +
          (mode === 1 ? " «Always» keeps writing files even when you are not live; disk fills up unnoticed." : ""),
      });
    } else {
      checks.push({ id: "record_mode", status: "warn", message: `Unknown record mode ${mode}.` });
    }

    // 3. Encoder, rate control and quality
    const encoder = str(s.encoder) || "(OBS default)";
    const rc = str(s.rate_control).toUpperCase();
    const isQualityMode = /^(CQP|CRF|ICQ|LA_ICQ|CQ|QVBR|CONSTANT_QP)$/.test(rc);
    if (isQualityMode) {
      const known = DEFAULT_QP.find((d) => d.match.test(encoder.toLowerCase()));
      // Read the quality field that this encoder uses: Source Record's own defaults
      // include x264's crf even when another encoder is selected.
      const explicitQ = known ? num(s[known.key]) : (num(s.cqp) ?? num(s.crf) ?? num(s.icq_quality) ?? num(s.cq) ?? num(s.qpi));
      const q = explicitQ ?? known?.value;
      const where = explicitQ !== undefined ? "" : known ? ` (not set in the filter: OBS default for this encoder, ${known.key}=${known.value})` : " (value not set; encoder default)";
      if (q === undefined) {
        checks.push({ id: "encoder", status: "info", message: `Encoder ${encoder}, ${rc}${where}.` });
      } else if (q > 28) {
        checks.push({ id: "encoder", status: "warn", message: `Encoder ${encoder}, ${rc} ${q}${where}: high value means visibly lower quality; 16–23 is typical for footage you will edit.` });
      } else if (q < 14) {
        checks.push({ id: "encoder", status: "warn", message: `Encoder ${encoder}, ${rc} ${q}${where}: very low value means very large files.` });
      } else {
        checks.push({ id: "encoder", status: "ok", message: `Encoder ${encoder}, ${rc} ${q}${where}.` });
      }
    } else if (rc === "LOSSLESS") {
      checks.push({ id: "encoder", status: "warn", message: `Encoder ${encoder}, lossless: files are huge (tens of GB per hour).` });
    } else {
      const kbps = num(s.bitrate);
      const h = s.scale === true ? num(s.height) ?? 0 : video.baseHeight;
      if (kbps !== undefined && h >= 1080 && kbps < 8000) {
        checks.push({ id: "encoder", status: "warn", message: `Encoder ${encoder}, ${rc || "CBR"} ${kbps} kbps: low for ${h}p footage you will edit; use CQP/CRF or ≥ 12000 kbps.` });
      } else {
        checks.push({ id: "encoder", status: "ok", message: `Encoder ${encoder}, ${rc || "CBR"}${kbps !== undefined ? ` ${kbps} kbps` : ""}.` });
      }
    }
    const keyint = num(s.keyint_sec);
    if (keyint !== undefined && keyint > 0) checks.push({ id: "keyframes", status: "info", message: `Keyframe every ${keyint} s.` });

    // 4. Resolution / scaling
    if (s.scale === true) {
      const w = num(s.width) ?? 0;
      const hh = num(s.height) ?? 0;
      const scaleTypes: Record<number, string> = { 0: "disabled", 1: "point", 2: "bicubic", 3: "bilinear", 4: "lanczos", 5: "area" };
      const st = num(s.scale_type);
      const algo = st !== undefined ? scaleTypes[st] ?? String(st) : "default";
      if (w <= 0 || hh <= 0) {
        checks.push({ id: "resolution", status: "warn", message: `Scaling is on but no resolution is set (${str(s.resolution) || "empty"}); the source size is used.` });
      } else if (w > video.baseWidth || hh > video.baseHeight) {
        checks.push({ id: "resolution", status: "warn", message: `Scaled to ${w}x${hh} (${algo}), larger than the ${video.baseWidth}x${video.baseHeight} canvas: upscaling adds size, not detail.` });
      } else {
        checks.push({ id: "resolution", status: "ok", message: `Scaled to ${w}x${hh} (${algo}).` });
      }
    } else {
      checks.push({ id: "resolution", status: "ok", message: "Not scaled: records at the source's own size." });
    }

    // 5. Frame rate
    const div = num(s.frame_rate_divisor) ?? 0;
    if (div > 1) {
      checks.push({ id: "fps", status: "info", message: `Frame rate divisor ${div}: ${(fps / div).toFixed(2)} fps (canvas ${fps.toFixed(2)} fps).` });
    } else {
      checks.push({ id: "fps", status: "ok", message: `Records at the canvas frame rate, ${fps.toFixed(2)} fps.` });
    }

    // 6. Output: path, file name, container
    const path = str(s.path);
    const format = str(s.filename_formatting);
    const ext = extensionFor(str(s.rec_format));
    const output = `${path}/${format}.${ext}`;
    if (!path) {
      checks.push({ id: "path", status: "fail", message: "No output folder set." });
    } else {
      const same = ctx.recordDirectory && normalizePath(ctx.recordDirectory) === normalizePath(path);
      const otherDrive = ctx.recordDirectory && drive(path) && drive(ctx.recordDirectory) && drive(path) !== drive(ctx.recordDirectory);
      checks.push({
        id: "path",
        status: "ok",
        message:
          `Writes to ${path}` +
          (same ? " (same folder as the main recording)." : ".") +
          (otherDrive ? ` Different drive from the main recording folder: the free-space figure below is for ${drive(ctx.recordDirectory!)}:, not ${drive(path)}:.` : ""),
      });
    }
    if (!format) {
      checks.push({ id: "filename", status: "fail", message: "Empty file name format." });
    } else if (!/%[A-Za-z]/.test(format)) {
      checks.push({ id: "filename", status: "warn", message: `File name «${format}» has no date/time codes: every session reuses the same name.` });
    } else {
      const twins = byOutput.get(outputKey(f)) ?? [];
      if (f.filter.filterEnabled && mode !== 0 && twins.length > 1) {
        checks.push({
          id: "filename",
          status: "fail",
          message: `Same folder and file name format «${format}» as ${twins.filter((t) => t !== `${f.filter.sourceName} / ${f.filter.filterName}`).join(", ")}: both start in the same second and collide. Give each one a distinct prefix.`,
        });
      } else {
        checks.push({ id: "filename", status: "ok", message: `File name «${format}» is unique among Source Record filters.` });
      }
    }
    const recFormat = str(s.rec_format);
    if (recFormat === "mp4" || recFormat === "mov") {
      checks.push({ id: "container", status: "warn", message: `Container ${recFormat}: if OBS or the PC crashes the file cannot be opened. Use hybrid_mp4, mkv or fragmented_mp4.` });
    } else if (recFormat === "m3u8") {
      checks.push({ id: "container", status: "warn", message: "Container m3u8 writes many small segments; awkward for editing." });
    } else {
      checks.push({ id: "container", status: "ok", message: `Container ${recFormat || "(default)"}.` });
    }
    if (s.split_file === true) {
      checks.push({ id: "split", status: "info", message: `Splits files every ${num(s.max_time_sec) ?? 0} s or ${num(s.max_size_mb) ?? 0} MB.` });
    }

    // 7. Audio
    const differentAudio = s.different_audio === true;
    const track = num(s.audio_track) ?? 0;
    const audioName = str(s.audio_source);
    if (differentAudio && track === -1) {
      checks.push({ id: "audio", status: "ok", message: "Audio: all mixer tracks." });
    } else if (differentAudio && track > 0) {
      checks.push({ id: "audio", status: "ok", message: `Audio: mixer track ${track}.` });
    } else if (differentAudio && audioName) {
      if (f.audioSourceExists === false) {
        checks.push({ id: "audio", status: "warn", message: `Audio source «${audioName}» does not exist; Source Record falls back to the source's own audio.` });
      } else if (f.audioSourceMuted) {
        checks.push({ id: "audio", status: "warn", message: `Audio from «${audioName}», which is muted in the mixer right now.` });
      } else {
        checks.push({ id: "audio", status: "ok", message: `Audio from «${audioName}».` });
      }
    } else if (!f.isScene && SILENT_KINDS.has(f.sourceKind)) {
      checks.push({ id: "audio", status: "warn", message: `No audio: a ${f.sourceKind} source has no sound of its own and no other audio is selected, so the file is silent.` });
    } else {
      checks.push({ id: "audio", status: "ok", message: "Audio: the source's own sound." });
    }

    // 8. Filter order: what ends up in the file
    const above = f.siblings.filter((x) => x.filterIndex < f.filter.filterIndex && x.filterEnabled && x.filterKind !== SOURCE_RECORD_KIND);
    const below = f.siblings.filter((x) => x.filterIndex > f.filter.filterIndex && x.filterKind !== SOURCE_RECORD_KIND);
    const shapingAbove = above.filter((x) => SHAPING_FILTER.test(x.filterKind) || MASK_LIKE.test(x.filterKind));
    if (shapingAbove.length > 0) {
      checks.push({
        id: "filter_order",
        status: "warn",
        message: `Above Source Record, so baked into the file: ${shapingAbove.map((x) => `«${x.filterName}» (${x.filterKind})`).join(", ")}. Move Source Record above them for a clean recording.`,
      });
    } else {
      const masksBelow = below.filter((x) => SHAPING_FILTER.test(x.filterKind) || MASK_LIKE.test(x.filterKind));
      checks.push({
        id: "filter_order",
        status: "ok",
        message:
          (above.length ? `Filters baked in: ${above.map((x) => `«${x.filterName}»`).join(", ")}.` : "First in the chain: records the untouched source.") +
          (masksBelow.length ? ` Masks/crops after it stay out of the file: ${masksBelow.map((x) => `«${x.filterName}»`).join(", ")}.` : ""),
      });
    }

    // 9. Capture devices that switch off when hidden
    if (!f.isScene && CAPTURE_DEVICE_KINDS.has(f.sourceKind)) {
      const deactivate = f.sourceSettings?.deactivate_when_not_showing === true;
      if (deactivate) {
        checks.push({
          id: "deactivate_when_not_showing",
          status: "warn",
          message: `«Deactivate when not showing» is on for this capture device${f.inProgramScene ? "" : " and it is not in the current program scene"}: the camera can switch off or restart, leaving black frames or a frozen image in the file. Turn it off for sources you record with Source Record.`,
        });
      } else {
        checks.push({ id: "deactivate_when_not_showing", status: "ok", message: "«Deactivate when not showing» is off: the device keeps running when hidden." });
      }
    }

    reports.push({
      source: f.filter.sourceName,
      sourceKind: f.sourceKind,
      filter: f.filter.filterName,
      recordingNow,
      output,
      checks,
    });
  }

  // Global checks
  const diskMb = stats.availableDiskSpace;
  const diskGb = diskMb / 1024;
  const where = ctx.recordDirectory ? ` on the drive of ${ctx.recordDirectory}` : "";
  const cbrKbps = ctx.filters
    .filter((f) => f.filter.filterEnabled && num(f.filter.settings.record_mode) !== 0)
    .map((f) => (/^(CBR|VBR|ABR)$/i.test(str(f.filter.settings.rate_control)) ? num(f.filter.settings.bitrate) : undefined));
  const estimate =
    cbrKbps.length > 0 && cbrKbps.every((k) => k !== undefined)
      ? ` At the configured bitrates that is about ${((diskMb * 1024 * 1024 * 8) / ((cbrKbps as number[]).reduce((a, b) => a + b, 0) * 1000) / 3600).toFixed(1)} h of Source Record footage.`
      : "";
  if (diskGb < 10) global.push({ id: "disk", status: "fail", message: `Only ${diskGb.toFixed(1)} GB free${where}.${estimate}` });
  else if (diskGb < 50) global.push({ id: "disk", status: "warn", message: `${diskGb.toFixed(1)} GB free${where}.${estimate}` });
  else global.push({ id: "disk", status: "ok", message: `${diskGb.toFixed(1)} GB free${where}.${estimate}` });

  global.push({
    id: "canvas",
    status: "info",
    message: `Canvas ${video.baseWidth}x${video.baseHeight}, output ${video.outputWidth}x${video.outputHeight}, ${fps.toFixed(2)} fps.`,
  });
  if (fps > 0 && stats.activeFps > 0 && stats.activeFps < fps * 0.95) {
    global.push({ id: "render_fps", status: "warn", message: `OBS renders ${stats.activeFps.toFixed(1)} fps out of ${fps.toFixed(2)}: the PC is not keeping up and every Source Record file will stutter.` });
  } else {
    global.push({ id: "render_fps", status: "ok", message: `OBS renders ${stats.activeFps.toFixed(1)} fps.` });
  }
  if (stats.renderTotalFrames > 0) {
    const pct = (100 * stats.renderSkippedFrames) / stats.renderTotalFrames;
    if (pct > 1) global.push({ id: "render_lag", status: "warn", message: `${pct.toFixed(1)} % of frames lagged in rendering since OBS started.` });
  }
  const encoders = ctx.filters.filter((f) => f.filter.filterEnabled && num(f.filter.settings.record_mode) !== 0).length;
  if (encoders > 0) {
    global.push({
      id: "encoders",
      status: encoders >= 4 ? "warn" : "info",
      message: `${encoders} Source Record encoder(s) run next to the stream/recording encoders${encoders >= 4 ? "; consumer GPUs limit simultaneous hardware encoder sessions" : ""}.`,
    });
  }
  global.push({
    id: "outputs",
    status: "info",
    message: `Now: ${live.streaming ? "streaming" : "not streaming"}, ${live.recording ? (live.recordingPaused ? "recording (paused)" : "recording") : "not recording"}.`,
  });

  const all = [...reports.flatMap((r) => r.checks), ...global];
  let verdict: Verdict;
  if (ctx.filters.length === 0) verdict = "no_source_record_filters";
  else if (all.some((c) => c.status === "fail")) verdict = "not_ready";
  else if (all.some((c) => c.status === "warn")) verdict = "ready_with_warnings";
  else verdict = "ready";

  const counts = (st: CheckStatus): number => all.filter((c) => c.status === st).length;
  const summary =
    ctx.filters.length === 0
      ? "No Source Record filters found."
      : `${ctx.filters.length} Source Record filter(s); ${counts("fail")} fail, ${counts("warn")} warn. ` +
        reports.map((r) => `${r.source}: ${r.recordingNow ? "recording now" : "idle"}`).join("; ") +
        ".";

  return { verdict, veredicto: VEREDICTO[verdict], summary, live, filters: reports, global };
}
