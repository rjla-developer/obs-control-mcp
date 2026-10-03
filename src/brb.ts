import { runGuarded } from "./guard.ts";
import type { Logger } from "./log.ts";
import type { ObsClient } from "./obs.ts";

/**
 * BRB auto-switcher for IRL streams (NOALBS-style).
 *
 * OBS at home receives the phone/camera feed in a Media Source. When that feed
 * drops, viewers see a frozen or black frame; this switcher puts a «be right
 * back» scene on program and brings the live scene back when the signal is
 * good again.
 *
 * The decision is a pure function (`decideBrb`) with hysteresis on both sides:
 * the feed must be bad for `downAfterSec` before going to BRB, good for
 * `upAfterSec` before returning, and no automatic switch happens within
 * `minDwellSec` of the previous one. The signal comes from OBS itself
 * (`GetMediaInputStatus`: is the Media Source playing?) and, optionally, from
 * a bitrate probe (a mediamtx-style stats endpoint) so a feed that is still
 * "playing" at 200 kbps also counts as bad.
 *
 * Safety: the runner is a dry run unless `apply` is true; it only ever moves
 * between the two scenes it was given; it stands by while any other scene is
 * on program; and a BRB the person switched to by hand is left alone unless
 * `returnFromManualBrb` is set.
 */

export interface BrbThresholds {
  /** Seconds the feed must be bad before switching to BRB. */
  downAfterSec: number;
  /** Seconds the feed must be good before switching back to the live scene. */
  upAfterSec: number;
  /** Below this bitrate (kbps) the feed counts as bad. Only used when a probe reports a bitrate. */
  lowKbps: number;
  /** At or above this bitrate (kbps) the feed counts as good. Between low and ok, nothing changes. */
  okKbps: number;
  /** Minimum seconds between two automatic switches. */
  minDwellSec: number;
}

export const DEFAULT_THRESHOLDS: BrbThresholds = {
  downAfterSec: 3,
  upAfterSec: 5,
  lowKbps: 400,
  okKbps: 1000,
  minDwellSec: 10,
};

export interface BrbScenes {
  liveScene: string;
  brbScene: string;
}

export interface Sample {
  /** Milliseconds (Date.now()). */
  t: number;
  /** Is the Media Source playing right now? */
  playing: boolean;
  /** Measured incoming bitrate, when a probe is configured. */
  kbps?: number | undefined;
  /** Scene on program right now. */
  program: string;
}

export type FeedQuality = "good" | "bad" | "between";

export interface BrbState {
  goodSince: number | undefined;
  badSince: number | undefined;
  lastAutoSwitchAt: number | undefined;
  /** True while the BRB scene on program is one this switcher put there. */
  autoBrb: boolean;
}

export function initialBrbState(): BrbState {
  return { goodSince: undefined, badSince: undefined, lastAutoSwitchAt: undefined, autoBrb: false };
}

export interface Decision {
  /** Scene to put on program, or undefined to do nothing. */
  switchTo: string | undefined;
  quality: FeedQuality;
  reason: string;
}

export function classify(sample: Sample, th: BrbThresholds): FeedQuality {
  if (!sample.playing) return "bad";
  if (sample.kbps === undefined) return "good";
  if (sample.kbps < th.lowKbps) return "bad";
  if (sample.kbps >= th.okKbps) return "good";
  return "between";
}

/** Pure: updates `state` in place and says whether to switch. */
export function decideBrb(
  state: BrbState,
  sample: Sample,
  scenes: BrbScenes,
  th: BrbThresholds,
  opts: { returnFromManualBrb?: boolean } = {},
): Decision {
  const quality = classify(sample, th);
  if (quality === "bad") {
    state.badSince ??= sample.t;
    state.goodSince = undefined;
  } else if (quality === "good") {
    state.goodSince ??= sample.t;
    state.badSince = undefined;
  }
  const badFor = state.badSince === undefined ? 0 : (sample.t - state.badSince) / 1000;
  const goodFor = state.goodSince === undefined ? 0 : (sample.t - state.goodSince) / 1000;
  const sinceSwitch = state.lastAutoSwitchAt === undefined ? Infinity : (sample.t - state.lastAutoSwitchAt) / 1000;
  const dwellOk = sinceSwitch >= th.minDwellSec;

  if (sample.program === scenes.liveScene) {
    state.autoBrb = false;
    if (badFor >= th.downAfterSec) {
      if (!dwellOk) return { switchTo: undefined, quality, reason: `feed bad for ${badFor.toFixed(1)} s but last switch was ${sinceSwitch.toFixed(1)} s ago (dwell ${th.minDwellSec} s)` };
      state.lastAutoSwitchAt = sample.t;
      state.autoBrb = true;
      return { switchTo: scenes.brbScene, quality, reason: `feed bad for ${badFor.toFixed(1)} s` };
    }
    return { switchTo: undefined, quality, reason: quality === "bad" ? `feed bad for ${badFor.toFixed(1)} s (switching at ${th.downAfterSec} s)` : "live and feed ok" };
  }

  if (sample.program === scenes.brbScene) {
    if (!state.autoBrb && !opts.returnFromManualBrb) {
      return { switchTo: undefined, quality, reason: "BRB was put on program by hand; leaving it (returnFromManualBrb is off)" };
    }
    if (goodFor >= th.upAfterSec) {
      if (!dwellOk) return { switchTo: undefined, quality, reason: `feed good for ${goodFor.toFixed(1)} s but last switch was ${sinceSwitch.toFixed(1)} s ago (dwell ${th.minDwellSec} s)` };
      state.lastAutoSwitchAt = sample.t;
      state.autoBrb = false;
      return { switchTo: scenes.liveScene, quality, reason: `feed good for ${goodFor.toFixed(1)} s` };
    }
    return { switchTo: undefined, quality, reason: quality === "good" ? `feed good for ${goodFor.toFixed(1)} s (returning at ${th.upAfterSec} s)` : "on BRB, feed still bad" };
  }

  state.autoBrb = false;
  return { switchTo: undefined, quality, reason: `«${sample.program}» is on program (neither live nor BRB scene): standing by` };
}

// ---------------------------------------------------------------- bitrate probe

export interface BitrateProbe {
  /** Returns the incoming bitrate in kbps, or undefined when it cannot be measured. */
  sample(now: number): Promise<number | undefined>;
}

/**
 * Reads `bytesReceived` of one path from a mediamtx control API
 * (`GET <baseUrl>/v3/paths/get/<path>`) and turns the delta into kbps.
 * Any other endpoint that answers `{ "bytesReceived": <number> }` works too.
 */
export class MediamtxProbe implements BitrateProbe {
  private last: { t: number; bytes: number } | undefined;
  private readonly url: string;
  private readonly timeoutMs: number;
  constructor(baseUrl: string, path: string, timeoutMs = 1500) {
    this.url = `${baseUrl.replace(/\/+$/, "")}/v3/paths/get/${encodeURIComponent(path)}`;
    this.timeoutMs = timeoutMs;
  }
  async sample(now: number): Promise<number | undefined> {
    const r = await fetch(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new Error(`probe answered ${r.status}`);
    const body = (await r.json()) as { bytesReceived?: unknown; ready?: unknown };
    if (body.ready === false) {
      this.last = undefined;
      return 0;
    }
    const bytes = typeof body.bytesReceived === "number" ? body.bytesReceived : undefined;
    if (bytes === undefined) throw new Error("probe answer has no bytesReceived");
    const prev = this.last;
    this.last = { t: now, bytes };
    if (!prev || now <= prev.t) return undefined;
    if (bytes < prev.bytes) return undefined; // counter reset
    return kbps(bytes - prev.bytes, now - prev.t);
  }
}

export function kbps(bytes: number, ms: number): number {
  return ms <= 0 ? 0 : Math.round((bytes * 8) / ms);
}

// ---------------------------------------------------------------- runner

export interface BrbRunnerOptions extends BrbScenes {
  feedInput: string;
  thresholds: BrbThresholds;
  intervalSec: number;
  /** false (default): only log what would happen. true: switch scenes for real (confirmLive is implied). */
  apply: boolean;
  returnFromManualBrb: boolean;
  probe?: BitrateProbe | undefined;
  /** Called after every sample (tests). */
  onSample?: ((sample: Sample, decision: Decision) => void) | undefined;
}

export const PLAYING_STATE = "OBS_MEDIA_STATE_PLAYING";

export class BrbSwitcher {
  readonly state = initialBrbState();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private probeWarned = false;
  private readonly obs: ObsClient;
  private readonly opts: BrbRunnerOptions;
  private readonly logger: Logger;

  constructor(obs: ObsClient, opts: BrbRunnerOptions, logger: Logger) {
    this.obs = obs;
    this.opts = opts;
    this.logger = logger;
  }

  /** Checks that both scenes and the feed exist, then starts polling. */
  async start(): Promise<void> {
    const { liveScene, brbScene, feedInput } = this.opts;
    const [{ scenes }, { inputs }] = await Promise.all([this.obs.call("GetSceneList"), this.obs.call("GetInputList")]);
    const names = scenes.map((s) => String(s.sceneName));
    for (const s of [liveScene, brbScene]) {
      if (!names.includes(s)) throw new Error(`No scene named «${s}». Scenes: ${names.join(", ")}`);
    }
    if (!inputs.some((i) => i.inputName === feedInput)) {
      throw new Error(`No input named «${feedInput}». Inputs: ${inputs.map((i) => i.inputName).join(", ")}`);
    }
    const program = await this.obs.call("GetCurrentProgramScene");
    const current = program.currentProgramSceneName ?? program.sceneName;
    this.logger.info(
      `BRB switcher ${this.opts.apply ? "ARMED (will switch scenes)" : "in dry run (logs only)"}: live «${liveScene}», BRB «${brbScene}», feed «${feedInput}», ` +
        `down after ${this.opts.thresholds.downAfterSec} s, up after ${this.opts.thresholds.upAfterSec} s, dwell ${this.opts.thresholds.minDwellSec} s` +
        (this.opts.probe ? `, bitrate low < ${this.opts.thresholds.lowKbps} kbps / ok ≥ ${this.opts.thresholds.okKbps} kbps` : ", no bitrate probe") +
        `. On program now: «${current}».`,
    );
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  async tick(): Promise<void> {
    const started = Date.now();
    try {
      await this.once(started);
    } catch (err) {
      this.logger.warn(`BRB sample failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const elapsed = Date.now() - started;
    this.schedule(Math.max(0, this.opts.intervalSec * 1000 - elapsed));
  }

  private async once(now: number): Promise<void> {
    const [program, media] = await Promise.all([
      this.obs.call("GetCurrentProgramScene"),
      this.obs.call("GetMediaInputStatus", { inputName: this.opts.feedInput }),
    ]);
    let bitrate: number | undefined;
    if (this.opts.probe) {
      try {
        bitrate = await this.opts.probe.sample(now);
        this.probeWarned = false;
      } catch (err) {
        if (!this.probeWarned) this.logger.warn(`Bitrate probe failed (${err instanceof Error ? err.message : String(err)}); deciding on the OBS media state only until it answers again.`);
        this.probeWarned = true;
      }
    }
    const sample: Sample = {
      t: now,
      playing: media.mediaState === PLAYING_STATE,
      kbps: bitrate,
      program: String(program.currentProgramSceneName ?? program.sceneName),
    };
    const decision = decideBrb(this.state, sample, this.opts, this.opts.thresholds, { returnFromManualBrb: this.opts.returnFromManualBrb });
    this.opts.onSample?.(sample, decision);
    if (!decision.switchTo) {
      this.logger.debug(`${sample.program} · ${media.mediaState}${bitrate === undefined ? "" : ` · ${bitrate} kbps`} · ${decision.reason}`);
      return;
    }
    const r = await runGuarded(this.obs, { dryRun: !this.opts.apply, confirmLive: this.opts.apply }, {
      action: `Switch program scene from «${sample.program}» to «${decision.switchTo}» (${decision.reason}).`,
      apply: () => this.obs.call("SetCurrentProgramScene", { sceneName: decision.switchTo! }),
    });
    if (r.status === "done") this.logger.info(`Switched to «${decision.switchTo}»: ${decision.reason}.`);
    else this.logger.info(`${r.status === "dry_run" ? "Would switch" : "Refused to switch"} to «${decision.switchTo}»: ${decision.reason}. ${r.message}`);
  }
}

// ---------------------------------------------------------------- command line

export interface BrbArgs extends BrbScenes {
  feedInput: string;
  thresholds: BrbThresholds;
  intervalSec: number;
  apply: boolean;
  returnFromManualBrb: boolean;
  statsUrl: string | undefined;
  statsPath: string;
}

export const BRB_USAGE = `obs-control-mcp brb [options]

  --live <scene>      Scene with the incoming feed (default "IRL")
  --brb <scene>       Scene to show while the feed is down (default "Ahorita regreso")
  --feed <input>      Media Source input that receives the feed (default "Señal IRL")
  --apply             Switch scenes for real. Without it: dry run, logs only.
  --interval <s>      Seconds between samples (default 2)
  --down <s>          Feed bad for this long → BRB (default ${DEFAULT_THRESHOLDS.downAfterSec})
  --up <s>            Feed good for this long → back to live (default ${DEFAULT_THRESHOLDS.upAfterSec})
  --dwell <s>         Minimum seconds between automatic switches (default ${DEFAULT_THRESHOLDS.minDwellSec})
  --low <kbps>        Below this the feed is bad (default ${DEFAULT_THRESHOLDS.lowKbps}; needs --stats-url)
  --ok <kbps>         At or above this the feed is good (default ${DEFAULT_THRESHOLDS.okKbps}; needs --stats-url)
  --stats-url <url>   mediamtx control API base URL, e.g. http://192.0.2.10:9997
  --stats-path <name> mediamtx path name to read (default "irl")
  --return-from-manual-brb   Also return to live when BRB was selected by hand`;

export function parseBrbArgs(argv: string[]): BrbArgs {
  const out: BrbArgs = {
    liveScene: "IRL",
    brbScene: "Ahorita regreso",
    feedInput: "Señal IRL",
    thresholds: { ...DEFAULT_THRESHOLDS },
    intervalSec: 2,
    apply: false,
    returnFromManualBrb: false,
    statsUrl: undefined,
    statsPath: "irl",
  };
  const num = (flag: string, v: string | undefined, min: number): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < min) throw new Error(`${flag} needs a number ≥ ${min}`);
    return n;
  };
  const str = (flag: string, v: string | undefined): string => {
    if (!v) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    switch (a) {
      case "--live":
        out.liveScene = str(a, v);
        i++;
        break;
      case "--brb":
        out.brbScene = str(a, v);
        i++;
        break;
      case "--feed":
        out.feedInput = str(a, v);
        i++;
        break;
      case "--apply":
        out.apply = true;
        break;
      case "--return-from-manual-brb":
        out.returnFromManualBrb = true;
        break;
      case "--interval":
        out.intervalSec = num(a, v, 0.5);
        i++;
        break;
      case "--down":
        out.thresholds.downAfterSec = num(a, v, 0);
        i++;
        break;
      case "--up":
        out.thresholds.upAfterSec = num(a, v, 0);
        i++;
        break;
      case "--dwell":
        out.thresholds.minDwellSec = num(a, v, 0);
        i++;
        break;
      case "--low":
        out.thresholds.lowKbps = num(a, v, 0);
        i++;
        break;
      case "--ok":
        out.thresholds.okKbps = num(a, v, 0);
        i++;
        break;
      case "--stats-url":
        out.statsUrl = str(a, v);
        i++;
        break;
      case "--stats-path":
        out.statsPath = str(a, v);
        i++;
        break;
      default:
        throw new Error(`Unknown option ${a}\n\n${BRB_USAGE}`);
    }
  }
  if (out.liveScene === out.brbScene) throw new Error("--live and --brb must be different scenes");
  if (out.thresholds.okKbps < out.thresholds.lowKbps) throw new Error("--ok must be ≥ --low");
  if (out.statsUrl !== undefined && !/^https?:\/\//.test(out.statsUrl)) throw new Error("--stats-url must start with http:// or https://");
  return out;
}
