import { afterEach, describe, expect, it } from "vitest";
import {
  BrbSwitcher,
  classify,
  DEFAULT_THRESHOLDS,
  decideBrb,
  initialBrbState,
  kbps,
  MediamtxProbe,
  parseBrbArgs,
  type BrbThresholds,
  type Decision,
  type Sample,
} from "../src/brb.ts";
import { createLogger } from "../src/log.ts";
import { ObsConnection } from "../src/obs.ts";
import { SecretRegistry } from "../src/redact.ts";
import { defaultState, FakeObs, type FakeState } from "./fakeObs.ts";

const SCENES = { liveScene: "IRL", brbScene: "Ahorita regreso" };
const TH: BrbThresholds = { downAfterSec: 3, upAfterSec: 5, lowKbps: 400, okKbps: 1000, minDwellSec: 10 };

function sample(over: Partial<Sample> = {}): Sample {
  return { t: 0, playing: true, program: "IRL", ...over };
}

describe("classify", () => {
  it("not playing is bad whatever the bitrate", () => {
    expect(classify(sample({ playing: false, kbps: 5000 }), TH)).toBe("bad");
  });
  it("playing without a probe is good", () => {
    expect(classify(sample({ playing: true }), TH)).toBe("good");
  });
  it("bitrate on both sides of low and ok", () => {
    expect(classify(sample({ kbps: 399 }), TH)).toBe("bad");
    expect(classify(sample({ kbps: 400 }), TH)).toBe("between");
    expect(classify(sample({ kbps: 999 }), TH)).toBe("between");
    expect(classify(sample({ kbps: 1000 }), TH)).toBe("good");
  });
});

describe("decideBrb", () => {
  function run(samples: Sample[], opts: { returnFromManualBrb?: boolean } = {}): Decision[] {
    const state = initialBrbState();
    return samples.map((s) => decideBrb(state, s, SCENES, TH, opts));
  }

  it("goes to BRB only once the feed has been bad for downAfterSec (both sides)", () => {
    const d = run([sample({ t: 0, playing: false }), sample({ t: 2999, playing: false }), sample({ t: 3000, playing: false })]);
    expect(d[0]!.switchTo).toBeUndefined();
    expect(d[1]!.switchTo).toBeUndefined();
    expect(d[2]!.switchTo).toBe("Ahorita regreso");
  });

  it("a good sample in between resets the bad timer", () => {
    const d = run([sample({ t: 0, playing: false }), sample({ t: 2000, playing: true }), sample({ t: 4000, playing: false }), sample({ t: 6999, playing: false }), sample({ t: 7000, playing: false })]);
    expect(d.map((x) => x.switchTo)).toEqual([undefined, undefined, undefined, undefined, "Ahorita regreso"]);
  });

  it("a between sample keeps the timers running", () => {
    const d = run([sample({ t: 0, kbps: 100 }), sample({ t: 1500, kbps: 500 }), sample({ t: 3000, kbps: 100 })]);
    expect(d[2]!.switchTo).toBe("Ahorita regreso");
  });

  it("returns from an automatic BRB after upAfterSec of good feed (both sides) and respects the dwell", () => {
    const state = initialBrbState();
    const brb = decideBrb(state, sample({ t: 3000, playing: false }), SCENES, TH);
    expect(brb.switchTo).toBeUndefined(); // bad since 3000
    expect(decideBrb(state, sample({ t: 6000, playing: false }), SCENES, TH).switchTo).toBe("Ahorita regreso");
    // good from 6001: upAfter reached at 11001, but dwell (10 s from 6000) allows from 16000
    const onBrb = (t: number, playing = true) => decideBrb(state, sample({ t, playing, program: "Ahorita regreso" }), SCENES, TH);
    expect(onBrb(6001).switchTo).toBeUndefined();
    expect(onBrb(11000).switchTo).toBeUndefined();
    expect(onBrb(11001).switchTo).toBeUndefined(); // feed good 5 s, but dwell not over
    expect(onBrb(11001).reason).toMatch(/dwell/);
    expect(onBrb(15999).switchTo).toBeUndefined();
    expect(onBrb(16000).switchTo).toBe("IRL");
  });

  it("the dwell also delays going to BRB right after returning", () => {
    const state = initialBrbState();
    state.lastAutoSwitchAt = 20000;
    state.autoBrb = false;
    const d1 = decideBrb(state, sample({ t: 20001, playing: false }), SCENES, TH);
    expect(d1.switchTo).toBeUndefined();
    const d2 = decideBrb(state, sample({ t: 23001, playing: false }), SCENES, TH); // bad 3 s, 3 s since switch
    expect(d2.switchTo).toBeUndefined();
    expect(d2.reason).toMatch(/dwell/);
    const d3 = decideBrb(state, sample({ t: 30000, playing: false }), SCENES, TH);
    expect(d3.switchTo).toBe("Ahorita regreso");
  });

  it("leaves a BRB the person selected by hand, unless returnFromManualBrb", () => {
    const manual = run([sample({ t: 0, program: "Ahorita regreso" }), sample({ t: 5000, program: "Ahorita regreso" })]);
    expect(manual[1]!.switchTo).toBeUndefined();
    expect(manual[1]!.reason).toMatch(/by hand/);
    const auto = run([sample({ t: 0, program: "Ahorita regreso" }), sample({ t: 4999, program: "Ahorita regreso" }), sample({ t: 5000, program: "Ahorita regreso" })], { returnFromManualBrb: true });
    expect(auto[1]!.switchTo).toBeUndefined();
    expect(auto[2]!.switchTo).toBe("IRL");
  });

  it("stands by while another scene is on program, even with a bad feed", () => {
    const d = run([sample({ t: 0, playing: false, program: "Solo pantalla" }), sample({ t: 10000, playing: false, program: "Solo pantalla" })]);
    expect(d[1]!.switchTo).toBeUndefined();
    expect(d[1]!.reason).toMatch(/standing by/);
  });

  it("a BRB the switcher set stops being automatic once the person goes back to live by hand", () => {
    const state = initialBrbState();
    decideBrb(state, sample({ t: 0, playing: false }), SCENES, TH);
    expect(decideBrb(state, sample({ t: 3000, playing: false }), SCENES, TH).switchTo).toBe("Ahorita regreso");
    expect(state.autoBrb).toBe(true);
    decideBrb(state, sample({ t: 4000, playing: false, program: "IRL" }), SCENES, TH);
    expect(state.autoBrb).toBe(false);
  });
});

describe("kbps and the mediamtx probe", () => {
  it("converts bytes over milliseconds to kbps", () => {
    expect(kbps(250_000, 1000)).toBe(2000);
    expect(kbps(100, 0)).toBe(0);
  });

  it("reads bytesReceived deltas and reports 0 when the path is not ready", async () => {
    const answers: unknown[] = [{ ready: true, bytesReceived: 1_000_000 }, { ready: true, bytesReceived: 1_250_000 }, { ready: false }, { ready: true, bytesReceived: 10 }];
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    }) as typeof fetch;
    try {
      const probe = new MediamtxProbe("http://relay.example.com:9997/", "irl");
      expect(await probe.sample(1000)).toBeUndefined(); // first sample: no delta yet
      expect(await probe.sample(2000)).toBe(2000);
      expect(await probe.sample(3000)).toBe(0);
      expect(await probe.sample(4000)).toBeUndefined(); // restarted counter: first sample again
      expect(urls[0]).toBe("http://relay.example.com:9997/v3/paths/get/irl");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("throws on a non-200 answer", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    try {
      await expect(new MediamtxProbe("http://relay.example.com:9997", "irl").sample(1)).rejects.toThrow(/404/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("parseBrbArgs", () => {
  it("has safe defaults: dry run, default scene names", () => {
    const a = parseBrbArgs([]);
    expect(a.apply).toBe(false);
    expect(a.liveScene).toBe("IRL");
    expect(a.brbScene).toBe("Ahorita regreso");
    expect(a.feedInput).toBe("Señal IRL");
    expect(a.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(a.statsUrl).toBeUndefined();
  });
  it("parses every option", () => {
    const a = parseBrbArgs(["--live", "Calle", "--brb", "Vuelvo", "--feed", "Cel", "--apply", "--interval", "1", "--down", "2", "--up", "4", "--dwell", "8", "--low", "300", "--ok", "900", "--stats-url", "http://relay.example.com:9997", "--stats-path", "cel", "--return-from-manual-brb"]);
    expect(a).toEqual({
      liveScene: "Calle",
      brbScene: "Vuelvo",
      feedInput: "Cel",
      apply: true,
      intervalSec: 1,
      thresholds: { downAfterSec: 2, upAfterSec: 4, minDwellSec: 8, lowKbps: 300, okKbps: 900 },
      statsUrl: "http://relay.example.com:9997",
      statsPath: "cel",
      returnFromManualBrb: true,
    });
  });
  it.each([
    [["--bogus"], /Unknown option/],
    [["--live"], /needs a value/],
    [["--interval", "0.4"], /≥ 0.5/],
    [["--down", "x"], /number/],
    [["--live", "A", "--brb", "A"], /different/],
    [["--low", "900", "--ok", "300"], /--ok must be/],
    [["--stats-url", "relay:9997"], /http/],
  ])("rejects %j", (argv, re) => {
    expect(() => parseBrbArgs(argv as string[])).toThrow(re);
  });
});

describe("BrbSwitcher against the fake OBS", () => {
  let fake: FakeObs | undefined;
  let conn: ObsConnection | undefined;
  let switcher: BrbSwitcher | undefined;
  afterEach(async () => {
    switcher?.stop();
    await conn?.close();
    await fake?.stop();
    fake = undefined;
  });

  function irlState(): FakeState {
    const s = defaultState();
    s.scenes = [
      { name: "IRL", items: [{ sourceName: "Señal IRL", id: 1, enabled: true, inputKind: "ffmpeg_source" }] },
      { name: "Ahorita regreso", items: [{ sourceName: "Screen", id: 1, enabled: true, inputKind: "monitor_capture" }] },
      ...s.scenes,
    ];
    s.program = "IRL";
    s.inputs.push({ name: "Señal IRL", kind: "ffmpeg_source", settings: { is_local_file: false, input: "srt://relay.example.com:8890?streamid=read:irl&passphrase=x" } });
    s.media = { "Señal IRL": "OBS_MEDIA_STATE_PLAYING" };
    s.streaming = true;
    return s;
  }

  async function start(opts: { apply: boolean; state?: FakeState; returnFromManualBrb?: boolean }) {
    fake = new FakeObs({ password: "Pw-Test-9f8e7d6c5b4a", state: opts.state ?? irlState() });
    await fake.start();
    const secrets = new SecretRegistry();
    const logs: string[] = [];
    const logger = createLogger(secrets, "debug", (l) => logs.push(l));
    conn = new ObsConnection({ config: { host: "127.0.0.1", port: fake.port, password: "Pw-Test-9f8e7d6c5b4a", connectTimeoutMs: 2000 }, secrets, logger });
    const seen: Array<{ sample: Sample; decision: Decision }> = [];
    switcher = new BrbSwitcher(
      conn,
      {
        liveScene: "IRL",
        brbScene: "Ahorita regreso",
        feedInput: "Señal IRL",
        thresholds: { downAfterSec: 0.1, upAfterSec: 0.1, lowKbps: 400, okKbps: 1000, minDwellSec: 0.2 },
        intervalSec: 0.5, // overridden: tests call tick() by hand
        apply: opts.apply,
        returnFromManualBrb: opts.returnFromManualBrb ?? false,
        onSample: (sample, decision) => seen.push({ sample, decision }),
      },
      logger,
    );
    await switcher.start();
    switcher.stop(); // no timer: the tests drive the samples
    return { seen, logs };
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("refuses to start when a scene or the feed is missing", async () => {
    const s = irlState();
    s.scenes = s.scenes.filter((x) => x.name !== "Ahorita regreso");
    await expect(start({ apply: false, state: s })).rejects.toThrow(/No scene named «Ahorita regreso»/);
    switcher = undefined;
    await conn?.close();
    await fake?.stop();
    const s2 = irlState();
    s2.inputs = s2.inputs.filter((i) => i.name !== "Señal IRL");
    await expect(start({ apply: false, state: s2 })).rejects.toThrow(/No input named «Señal IRL»/);
  });

  it("dry run: decides but never sends a scene change, even while streaming", async () => {
    const { seen, logs } = await start({ apply: false });
    await switcher!.tick();
    switcher!.stop();
    fake!.state.media = { "Señal IRL": "OBS_MEDIA_STATE_ENDED" };
    await switcher!.tick();
    switcher!.stop();
    await wait(120);
    await switcher!.tick();
    switcher!.stop();
    expect(seen.at(-1)!.decision.switchTo).toBe("Ahorita regreso");
    expect(fake!.mutations).toEqual([]);
    expect(fake!.state.program).toBe("IRL");
    expect(logs.join("\n")).toMatch(/Would switch to «Ahorita regreso»/);
  });

  it("--apply: switches to BRB when the feed ends and back when it plays again", async () => {
    const { logs } = await start({ apply: true });
    fake!.state.media = { "Señal IRL": "OBS_MEDIA_STATE_ERROR" };
    await switcher!.tick();
    switcher!.stop();
    await wait(120);
    await switcher!.tick();
    switcher!.stop();
    expect(fake!.state.program).toBe("Ahorita regreso");
    expect(fake!.mutations.map((m) => m.type)).toEqual(["SetCurrentProgramScene"]);
    // feed back: up after 0.1 s, dwell 0.2 s
    fake!.state.media = { "Señal IRL": "OBS_MEDIA_STATE_PLAYING" };
    await switcher!.tick();
    switcher!.stop();
    await wait(220);
    await switcher!.tick();
    switcher!.stop();
    expect(fake!.state.program).toBe("IRL");
    expect(fake!.mutations.length).toBe(2);
    expect(logs.join("\n")).toMatch(/ARMED/);
    expect(logs.join("\n")).not.toContain("Pw-Test-9f8e7d6c5b4a");
  });

  it("--apply: a BRB selected by hand stays until the person returns", async () => {
    const s = irlState();
    s.program = "Ahorita regreso";
    await start({ apply: true, state: s });
    await switcher!.tick();
    switcher!.stop();
    await wait(250);
    await switcher!.tick();
    switcher!.stop();
    expect(fake!.state.program).toBe("Ahorita regreso");
    expect(fake!.mutations).toEqual([]);
  });

  it("keeps sampling when OBS answers an error for one sample", async () => {
    const { seen, logs } = await start({ apply: false });
    fake!.state.inputs = fake!.state.inputs.filter((i) => i.name !== "Señal IRL");
    await switcher!.tick();
    switcher!.stop();
    expect(logs.join("\n")).toMatch(/BRB sample failed/);
    expect(seen.length).toBe(0);
  });
});
