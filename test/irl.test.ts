import { afterEach, describe, expect, it } from "vitest";
import { analyzeIrl, DEFAULT_IRL_NAMES, MAX_RECONNECT_DELAY_SEC, MIN_FREE_DISK_MB, protocolOf, type IrlContext, type IrlFeedInfo } from "../src/irl.ts";
import type { Check } from "../src/sourceRecord.ts";
import { defaultState, type FakeState } from "./fakeObs.ts";
import { PASSWORD, startHarness, type Harness } from "./harness.ts";

const SRT = "srt://relay.example.com:8890?streamid=read:irl&passphrase=s3cretpass";

function feed(over: Partial<IrlFeedInfo> & { settings?: Record<string, unknown> } = {}): IrlFeedInfo {
  const { settings, ...rest } = over;
  return {
    inputKind: "ffmpeg_source",
    settings: { is_local_file: false, input: SRT, reconnect_delay_sec: 2, close_when_inactive: false, restart_on_activate: false, clear_on_media_end: true, hw_decode: true, ...settings },
    filters: [{ filterName: "ISO", filterKind: "source_record_filter", filterEnabled: true }],
    mediaState: "OBS_MEDIA_STATE_PLAYING",
    ...rest,
  };
}

function ctx(over: Partial<IrlContext> = {}): IrlContext {
  return {
    names: DEFAULT_IRL_NAMES,
    scenes: [
      { sceneName: "IRL", items: [{ sourceName: "Señal IRL", enabled: true, inputKind: "ffmpeg_source" }, { sourceName: "Chat", enabled: true, inputKind: "browser_source" }] },
      { sceneName: "Ahorita regreso", items: [{ sourceName: "BRB loop", enabled: true, inputKind: "ffmpeg_source" }] },
      { sceneName: "Solo pantalla", items: [] },
    ],
    programScene: "IRL",
    feed: feed(),
    live: { streaming: false, recording: false, recordingPaused: false, virtualCam: false, replayBuffer: undefined },
    video: { baseWidth: 1920, baseHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 },
    stats: { availableDiskSpace: 100 * 1024, activeFps: 30 },
    streamService: { type: "rtmp_custom", server: "rtmps://ingest.example.com/app" },
    ...over,
  };
}

function check(report: ReturnType<typeof analyzeIrl>, id: string): Check {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}: ${report.checks.map((x) => x.id).join(", ")}`);
  return c;
}

describe("protocolOf", () => {
  it("extracts the scheme and nothing else", () => {
    expect(protocolOf(SRT)).toBe("srt");
    expect(protocolOf("RTMP://x/y")).toBe("rtmp");
    expect(protocolOf("C:/Videos/a.mp4")).toBeUndefined();
    expect(protocolOf("")).toBeUndefined();
  });
});

describe("analyzeIrl", () => {
  it("a well-wired setup is ready, and the report never contains the feed URL", () => {
    const r = analyzeIrl(ctx());
    expect(r.verdict).toBe("ready");
    expect(r.veredicto).toMatch(/listo/);
    const text = JSON.stringify(r);
    expect(text).not.toContain("relay.example.com");
    expect(text).not.toContain("s3cretpass");
    expect(text).not.toContain("ingest.example.com");
  });

  it("missing live or BRB scene is a fail", () => {
    const r = analyzeIrl(ctx({ scenes: [{ sceneName: "Solo pantalla", items: [] }] }));
    expect(check(r, "live_scene").status).toBe("fail");
    expect(check(r, "brb_scene").status).toBe("fail");
    expect(r.verdict).toBe("not_ready");
  });

  it("same scene for live and BRB is a fail", () => {
    const r = analyzeIrl(ctx({ names: { liveScene: "IRL", brbScene: "IRL", feedInput: "Señal IRL" } }));
    expect(check(r, "scenes_differ").status).toBe("fail");
  });

  it("an empty BRB scene warns", () => {
    const c = ctx();
    c.scenes[1] = { sceneName: "Ahorita regreso", items: [{ sourceName: "BRB loop", enabled: false, inputKind: "ffmpeg_source" }] };
    expect(check(analyzeIrl(c), "brb_content").status).toBe("warn");
    expect(check(analyzeIrl(ctx()), "brb_content").status).toBe("ok");
  });

  it("missing feed input is a fail; a non-Media-Source kind is a fail", () => {
    expect(check(analyzeIrl(ctx({ feed: undefined })), "feed_input").status).toBe("fail");
    expect(check(analyzeIrl(ctx({ feed: feed({ inputKind: "vlc_source" }) })), "feed_kind").status).toBe("fail");
    expect(check(analyzeIrl(ctx()), "feed_kind").status).toBe("ok");
  });

  it("feed must be visible in the live scene and should not be in the BRB scene", () => {
    const hidden = ctx();
    hidden.scenes[0] = { sceneName: "IRL", items: [{ sourceName: "Señal IRL", enabled: false, inputKind: "ffmpeg_source" }] };
    expect(check(analyzeIrl(hidden), "feed_in_live").status).toBe("fail");
    const absent = ctx();
    absent.scenes[0] = { sceneName: "IRL", items: [] };
    expect(check(analyzeIrl(absent), "feed_in_live").status).toBe("fail");
    const inBrb = ctx();
    inBrb.scenes[1] = { sceneName: "Ahorita regreso", items: [{ sourceName: "Señal IRL", enabled: true, inputKind: "ffmpeg_source" }] };
    expect(check(analyzeIrl(inBrb), "feed_not_in_brb").status).toBe("warn");
    expect(check(analyzeIrl(ctx()), "feed_not_in_brb").status).toBe("ok");
  });

  it("local file or missing URL is a fail; odd protocol warns; known protocols are ok", () => {
    expect(check(analyzeIrl(ctx({ feed: feed({ settings: { is_local_file: true } }) })), "feed_network").status).toBe("fail");
    expect(check(analyzeIrl(ctx({ feed: feed({ settings: { input: "" } }) })), "feed_url").status).toBe("fail");
    expect(check(analyzeIrl(ctx({ feed: feed({ settings: { input: "relay:8890" } }) })), "feed_url").status).toBe("fail");
    expect(check(analyzeIrl(ctx({ feed: feed({ settings: { input: "https://relay.example.com/x.m3u8" } }) })), "feed_url").status).toBe("warn");
    expect(check(analyzeIrl(ctx({ feed: feed({ settings: { input: "rtmp://relay.example.com/live/irl" } }) })), "feed_url").status).toBe("ok");
  });

  it("SRT without passphrase warns; RTMP gets an info", () => {
    const noPass = analyzeIrl(ctx({ feed: feed({ settings: { input: "srt://relay.example.com:8890?streamid=read:irl" } }) }));
    expect(check(noPass, "srt_passphrase").status).toBe("warn");
    expect(check(analyzeIrl(ctx()), "srt_passphrase").status).toBe("ok");
    const rtmp = analyzeIrl(ctx({ feed: feed({ settings: { input: "rtmp://relay.example.com/live/irl" } }) }));
    expect(check(rtmp, "rtmp_plain").status).toBe("info");
    expect(rtmp.checks.some((c) => c.id === "srt_passphrase")).toBe(false);
  });

  it("reconnect delay on both sides of the limit", () => {
    expect(check(analyzeIrl(ctx({ feed: feed({ settings: { reconnect_delay_sec: MAX_RECONNECT_DELAY_SEC } }) })), "feed_reconnect").status).toBe("ok");
    expect(check(analyzeIrl(ctx({ feed: feed({ settings: { reconnect_delay_sec: MAX_RECONNECT_DELAY_SEC + 1 } }) })), "feed_reconnect").status).toBe("warn");
  });

  it("close_when_inactive blinds the switcher: fail", () => {
    expect(check(analyzeIrl(ctx({ feed: feed({ settings: { close_when_inactive: true } }) })), "feed_close_when_inactive").status).toBe("fail");
    expect(check(analyzeIrl(ctx()), "feed_close_when_inactive").status).toBe("ok");
  });

  it("no Source Record filter on the feed warns", () => {
    expect(check(analyzeIrl(ctx({ feed: feed({ filters: [] }) })), "feed_iso_record").status).toBe("warn");
    expect(check(analyzeIrl(ctx({ feed: feed({ filters: [{ filterName: "ISO", filterKind: "source_record_filter", filterEnabled: false }] }) })), "feed_iso_record").status).toBe("warn");
    expect(check(analyzeIrl(ctx()), "feed_iso_record").status).toBe("ok");
  });

  it("stream service missing server is a fail", () => {
    expect(check(analyzeIrl(ctx({ streamService: { type: "rtmp_custom", server: "" } })), "stream_service").status).toBe("fail");
    expect(check(analyzeIrl(ctx({ streamService: undefined })), "stream_service").status).toBe("warn");
  });

  it("free disk on both sides of the minimum", () => {
    expect(check(analyzeIrl(ctx({ stats: { availableDiskSpace: MIN_FREE_DISK_MB, activeFps: 30 } })), "free_disk").status).toBe("ok");
    expect(check(analyzeIrl(ctx({ stats: { availableDiskSpace: MIN_FREE_DISK_MB - 1, activeFps: 30 } })), "free_disk").status).toBe("fail");
  });

  it("render fps below 90 % warns", () => {
    expect(check(analyzeIrl(ctx({ stats: { availableDiskSpace: 100_000, activeFps: 27 } })), "render_fps").status).toBe("ok");
    expect(check(analyzeIrl(ctx({ stats: { availableDiskSpace: 100_000, activeFps: 26.9 } })), "render_fps").status).toBe("warn");
  });

  it("says whether the switcher would act given the program scene", () => {
    expect(check(analyzeIrl(ctx({ programScene: "Solo pantalla" })), "program").message).toMatch(/stands by/);
    expect(check(analyzeIrl(ctx({ programScene: "Ahorita regreso" })), "program").message).toMatch(/would act/);
  });

  it("verdict: warnings make ready_with_warnings", () => {
    expect(analyzeIrl(ctx({ feed: feed({ filters: [] }) })).verdict).toBe("ready_with_warnings");
  });
});

describe("check_irl over the MCP server", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  function irlState(): FakeState {
    const s = defaultState();
    s.scenes = [
      { name: "IRL", items: [{ sourceName: "Señal IRL", id: 1, enabled: true, inputKind: "ffmpeg_source" }] },
      { name: "Ahorita regreso", items: [{ sourceName: "Screen", id: 1, enabled: true, inputKind: "monitor_capture" }] },
      ...s.scenes,
    ];
    s.inputs.push({ name: "Señal IRL", kind: "ffmpeg_source", settings: { is_local_file: false, input: SRT, reconnect_delay_sec: 2 } });
    s.inputDefaults.ffmpeg_source = { is_local_file: true, reconnect_delay_sec: 10, close_when_inactive: false, clear_on_media_end: true, hw_decode: false };
    s.filters["Señal IRL"] = [{ name: "ISO", kind: "source_record_filter", enabled: true, settings: { record_mode: 2 } }];
    s.media = { "Señal IRL": "OBS_MEDIA_STATE_PLAYING" };
    return s;
  }

  it("collects from OBS, reads the media state and hides the URL and the stream key", async () => {
    h = await startHarness({ state: irlState() });
    const r = await h.call("check_irl");
    expect(r.isError).toBe(false);
    expect(r.json.verdict).toBe("ready");
    const ids = r.json.checks.map((c: Check) => c.id);
    expect(ids).toContain("feed_now");
    expect(r.json.checks.find((c: Check) => c.id === "feed_now").status).toBe("ok");
    expect(r.text).not.toContain("relay.example.com");
    expect(r.text).not.toContain("s3cretpass");
    expect(r.text).not.toContain("fake_stream_key_987");
    expect(r.text).not.toContain(PASSWORD);
    expect(h.fake.mutations).toEqual([]);
  });

  it("with the default OBS (no IRL scenes) it is not ready and names what is missing", async () => {
    h = await startHarness();
    const r = await h.call("check_irl");
    expect(r.json.verdict).toBe("not_ready");
    expect(r.json.checks.find((c: Check) => c.id === "live_scene").status).toBe("fail");
    expect(r.json.checks.find((c: Check) => c.id === "feed_input").status).toBe("fail");
  });

  it("accepts other scene and input names", async () => {
    const s = irlState();
    s.scenes[0]!.name = "Calle";
    h = await startHarness({ state: s });
    const r = await h.call("check_irl", { liveScene: "Calle" });
    expect(r.json.checks.find((c: Check) => c.id === "live_scene").status).toBe("ok");
  });
});
