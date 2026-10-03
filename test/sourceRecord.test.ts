import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeSourceRecord,
  type Check,
  type SourceRecordContext,
  type SourceRecordFilterContext,
} from "../src/sourceRecord.ts";
import { defaultState } from "./fakeObs.ts";
import { startHarness, type Harness } from "./harness.ts";

function srFilter(over: Partial<SourceRecordFilterContext> & { settings?: Record<string, unknown> } = {}): SourceRecordFilterContext {
  const { settings, ...rest } = over;
  return {
    filter: {
      sourceName: "Camera",
      filterName: "SR",
      filterKind: "source_record_filter",
      filterIndex: 0,
      filterEnabled: true,
      settings: {
        record_mode: 2,
        path: "C:/Videos",
        filename_formatting: "cam %CCYY-%MM-%DD %hh-%mm-%ss",
        rec_format: "hybrid_mp4",
        encoder: "h264_texture_amf",
        rate_control: "CQP",
        cqp: 20,
        ...(settings as Record<string, never>),
      },
      explicitKeys: [],
    },
    sourceKind: "dshow_input",
    isScene: false,
    siblings: [{ filterName: "SR", filterKind: "source_record_filter", filterIndex: 0, filterEnabled: true }],
    sourceSettings: { deactivate_when_not_showing: false },
    inProgramScene: true,
    audioSourceExists: undefined,
    audioSourceMuted: undefined,
    ...rest,
  };
}

function ctx(filters: SourceRecordFilterContext[], over: Partial<SourceRecordContext> = {}): SourceRecordContext {
  return {
    filters,
    live: { streaming: false, recording: false, recordingPaused: false, virtualCam: false, replayBuffer: undefined },
    video: { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 },
    stats: { activeFps: 30, availableDiskSpace: 300 * 1024, renderSkippedFrames: 0, renderTotalFrames: 1000, outputSkippedFrames: 0, outputTotalFrames: 0 },
    recordDirectory: "C:/Videos",
    programScene: "Main",
    ...over,
  };
}

function check(report: ReturnType<typeof analyzeSourceRecord>, id: string, filterIdx = 0): Check {
  const c = report.filters[filterIdx]?.checks.find((x) => x.id === id) ?? report.global.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

describe("verdict", () => {
  it("ready when every check passes", () => {
    const r = analyzeSourceRecord(ctx([srFilter()]));
    expect(r.verdict).toBe("ready");
    expect(r.veredicto).toBe("Sí, listo para grabar.");
  });

  it("no filters", () => {
    expect(analyzeSourceRecord(ctx([])).verdict).toBe("no_source_record_filters");
  });

  it("a disabled filter makes it not ready", () => {
    const f = srFilter();
    f.filter.filterEnabled = false;
    const r = analyzeSourceRecord(ctx([f]));
    expect(check(r, "enabled").status).toBe("fail");
    expect(r.verdict).toBe("not_ready");
  });
});

describe("record mode", () => {
  it.each([
    [0, "fail", false],
    [1, "warn", true],
    [2, "ok", false],
    [3, "ok", false],
    [4, "ok", false],
  ])("mode %i → %s, recording now: %s (not live)", (mode, status, now) => {
    const r = analyzeSourceRecord(ctx([srFilter({ settings: { record_mode: mode } })]));
    expect(check(r, "record_mode").status).toBe(status);
    expect(r.filters[0]!.recordingNow).toBe(now);
  });

  it("streaming mode is recording now while streaming", () => {
    const r = analyzeSourceRecord(ctx([srFilter()], { live: { streaming: true, recording: false, recordingPaused: false, virtualCam: false, replayBuffer: undefined } }));
    expect(r.filters[0]!.recordingNow).toBe(true);
  });
});

describe("encoder quality (both sides of each limit)", () => {
  it.each([
    [14, "ok"],
    [13, "warn"],
    [28, "ok"],
    [29, "warn"],
  ])("CQP %i → %s", (cqp, status) => {
    const r = analyzeSourceRecord(ctx([srFilter({ settings: { cqp } })]));
    expect(check(r, "encoder").status).toBe(status);
  });

  it("uses the encoder's own default when the filter does not set the QP (not x264's crf)", () => {
    const f = srFilter();
    delete (f.filter.settings as Record<string, unknown>).cqp;
    (f.filter.settings as Record<string, unknown>).crf = 35; // Source Record's x264 default, irrelevant for AMF
    const c = check(analyzeSourceRecord(ctx([f])), "encoder");
    expect(c.status).toBe("ok");
    expect(c.message).toMatch(/cqp=20/);
  });

  it.each([
    [7999, "warn"],
    [8000, "ok"],
  ])("CBR %i kbps at 1080p → %s", (bitrate, status) => {
    const r = analyzeSourceRecord(ctx([srFilter({ settings: { rate_control: "CBR", bitrate } })]));
    expect(check(r, "encoder").status).toBe(status);
  });
});

describe("file names and containers", () => {
  it("two filters with the same folder and format collide", () => {
    const a = srFilter({ settings: { filename_formatting: "%CCYY-%MM-%DD %hh-%mm-%ss" } });
    const b = srFilter({ settings: { filename_formatting: "%CCYY-%MM-%DD %hh-%mm-%ss" } });
    b.filter.sourceName = "Screen";
    const r = analyzeSourceRecord(ctx([a, b]));
    expect(check(r, "filename", 0).status).toBe("fail");
    expect(check(r, "filename", 1).status).toBe("fail");
    expect(r.verdict).toBe("not_ready");
  });

  it("same format in different folders does not collide", () => {
    const a = srFilter({ settings: { filename_formatting: "%CCYY %hh-%mm-%ss" } });
    const b = srFilter({ settings: { filename_formatting: "%CCYY %hh-%mm-%ss", path: "D:/Other" } });
    b.filter.sourceName = "Screen";
    expect(check(analyzeSourceRecord(ctx([a, b])), "filename").status).toBe("ok");
  });

  it("a disabled twin does not count as a collision", () => {
    const a = srFilter({ settings: { filename_formatting: "x %hh-%mm-%ss" } });
    const b = srFilter({ settings: { filename_formatting: "x %hh-%mm-%ss" } });
    b.filter.filterEnabled = false;
    expect(check(analyzeSourceRecord(ctx([a, b])), "filename", 0).status).toBe("ok");
  });

  it("a format without date/time codes is a warning", () => {
    expect(check(analyzeSourceRecord(ctx([srFilter({ settings: { filename_formatting: "camera" } })])), "filename").status).toBe("warn");
  });

  it.each([
    ["mp4", "warn"],
    ["mov", "warn"],
    ["hybrid_mp4", "ok"],
    ["mkv", "ok"],
  ])("container %s → %s", (rec_format, status) => {
    expect(check(analyzeSourceRecord(ctx([srFilter({ settings: { rec_format } })])), "container").status).toBe(status);
  });

  it("empty path fails", () => {
    expect(check(analyzeSourceRecord(ctx([srFilter({ settings: { path: "" } })])), "path").status).toBe("fail");
  });
});

describe("filter order", () => {
  it("a mask above Source Record is baked into the file", () => {
    const f = srFilter();
    f.filter.filterIndex = 1;
    f.siblings = [
      { filterName: "Round", filterKind: "mask_filter_v2", filterIndex: 0, filterEnabled: true },
      { filterName: "SR", filterKind: "source_record_filter", filterIndex: 1, filterEnabled: true },
    ];
    const c = check(analyzeSourceRecord(ctx([f])), "filter_order");
    expect(c.status).toBe("warn");
    expect(c.message).toMatch(/Round/);
  });

  it("a mask below Source Record stays out of the file", () => {
    const f = srFilter();
    f.siblings = [
      { filterName: "SR", filterKind: "source_record_filter", filterIndex: 0, filterEnabled: true },
      { filterName: "Round", filterKind: "mask_filter_v2", filterIndex: 1, filterEnabled: true },
    ];
    const c = check(analyzeSourceRecord(ctx([f])), "filter_order");
    expect(c.status).toBe("ok");
    expect(c.message).toMatch(/stay out of the file: «Round»/);
  });

  it("a disabled mask above does not count", () => {
    const f = srFilter();
    f.filter.filterIndex = 1;
    f.siblings = [
      { filterName: "Round", filterKind: "mask_filter_v2", filterIndex: 0, filterEnabled: false },
      { filterName: "SR", filterKind: "source_record_filter", filterIndex: 1, filterEnabled: true },
    ];
    expect(check(analyzeSourceRecord(ctx([f])), "filter_order").status).toBe("ok");
  });
});

describe("capture devices and audio", () => {
  it.each([
    [true, "warn"],
    [false, "ok"],
  ])("deactivate_when_not_showing=%s → %s", (deactivate, status) => {
    const f = srFilter({ sourceSettings: { deactivate_when_not_showing: deactivate } });
    expect(check(analyzeSourceRecord(ctx([f])), "deactivate_when_not_showing").status).toBe(status);
  });

  it("screen capture without another audio source is silent", () => {
    const f = srFilter({ sourceKind: "monitor_capture" });
    expect(check(analyzeSourceRecord(ctx([f])), "audio").status).toBe("warn");
  });

  it("a missing audio source is a warning; a muted one too", () => {
    const missing = srFilter({ settings: { different_audio: true, audio_source: "Gone" }, audioSourceExists: false });
    expect(check(analyzeSourceRecord(ctx([missing])), "audio").status).toBe("warn");
    const muted = srFilter({ settings: { different_audio: true, audio_source: "Mic" }, audioSourceExists: true, audioSourceMuted: true });
    expect(check(analyzeSourceRecord(ctx([muted])), "audio").status).toBe("warn");
    const fine = srFilter({ settings: { different_audio: true, audio_source: "Mic" }, audioSourceExists: true, audioSourceMuted: false });
    expect(check(analyzeSourceRecord(ctx([fine])), "audio").status).toBe("ok");
  });
});

describe("global checks (both sides of each limit)", () => {
  it.each([
    [9.9, "fail"],
    [10, "warn"],
    [49.9, "warn"],
    [50, "ok"],
  ])("%s GB free → %s", (gb, status) => {
    const r = analyzeSourceRecord(ctx([srFilter()], { stats: { ...ctx([]).stats, availableDiskSpace: gb * 1024 } }));
    expect(check(r, "disk").status).toBe(status);
  });

  it("estimates hours when every filter has a bitrate", () => {
    const r = analyzeSourceRecord(
      ctx([srFilter({ settings: { rate_control: "CBR", bitrate: 20000 } })], { stats: { ...ctx([]).stats, availableDiskSpace: 100 * 1024 } }),
    );
    // 100 GiB = 858,993,459,200 bits; at 20,000,000 bit/s that is 42,950 s ≈ 11.9 h
    expect(check(r, "disk").message).toMatch(/about 11\.9 h/);
  });

  it.each([
    [28.5, "ok"],
    [28.4, "warn"],
  ])("rendering %s of 30 fps → %s", (activeFps, status) => {
    const r = analyzeSourceRecord(ctx([srFilter()], { stats: { ...ctx([]).stats, activeFps } }));
    expect(check(r, "render_fps").status).toBe(status);
  });
});

describe("check_source_record against the fake OBS", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("reads everything with read-only requests and reports per filter", async () => {
    h = await startHarness();
    const r = await h.call("check_source_record");
    expect(r.isError).toBe(false);
    expect(r.json.filters.map((f: { source: string }) => f.source).sort()).toEqual(["Camera", "Screen"]);
    // screen capture has no audio of its own → warning, nothing failing
    expect(r.json.verdict).toBe("ready_with_warnings");
    expect(r.text).not.toContain("fake_sr_key_abc");
    expect(h.fake.mutations).toEqual([]);
  });

  it("finds the problems of a badly set up OBS", async () => {
    const state = defaultState();
    state.filters.Camera = [
      { name: "Crop", kind: "crop_filter", enabled: true, settings: {} },
      { name: "Record cam", kind: "source_record_filter", enabled: true, settings: { record_mode: 2 } },
    ];
    state.filters.Screen = [{ name: "Record screen", kind: "source_record_filter", enabled: true, settings: { record_mode: 2 } }];
    state.inputs[0]!.settings.deactivate_when_not_showing = true;
    state.stats.availableDiskSpace = 5 * 1024;
    h = await startHarness({ state });
    const r = await h.call("check_source_record");
    expect(r.json.verdict).toBe("not_ready");
    const cam = r.json.filters.find((f: { source: string }) => f.source === "Camera");
    const status = (id: string) => cam.checks.find((c: Check) => c.id === id).status;
    expect(status("filename")).toBe("fail"); // both use the default format in the same folder
    expect(status("filter_order")).toBe("warn");
    expect(status("deactivate_when_not_showing")).toBe("warn");
    expect(r.json.global.find((c: Check) => c.id === "disk").status).toBe("fail");
  });
});
