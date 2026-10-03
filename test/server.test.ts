import { afterEach, describe, expect, it } from "vitest";
import { defaultState } from "./fakeObs.ts";
import { PASSWORD, startHarness, type Harness } from "./harness.ts";

const WRITE_TOOLS = [
  "switch_scene",
  "set_filter_settings",
  "set_filter_enabled",
  "set_filter_index",
  "start_record",
  "stop_record",
  "set_input_settings",
];
const READ_TOOLS = [
  "get_overview",
  "list_scenes",
  "list_inputs",
  "get_input_settings",
  "list_filters",
  "get_outputs",
  "get_video_settings",
  "check_source_record",
  "check_irl",
  "read_timeline",
];

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("tool list", () => {
  it("registers read and guarded write tools", async () => {
    h = await startHarness();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const t of tools) {
      if (WRITE_TOOLS.includes(t.name)) {
        expect(t.annotations?.readOnlyHint).toBe(false);
        const props = (t.inputSchema as { properties: Record<string, { default?: unknown }> }).properties;
        expect(props.dry_run?.default, `${t.name} dry_run default`).toBe(true);
        expect(props.confirmLive?.default, `${t.name} confirmLive default`).toBe(false);
      } else {
        expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
  });

  it("OBS_READ_ONLY registers only the read tools", async () => {
    h = await startHarness({ readOnly: true });
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });
});

describe("read tools", () => {
  it("get_overview reports version, scene, live state and disk", async () => {
    h = await startHarness();
    const r = await h.call("get_overview");
    expect(r.isError).toBe(false);
    expect(r.json.obs.obsWebSocketVersion).toBe("5.7.4");
    expect(r.json.programScene).toBe("Main");
    expect(r.json.live).toMatchObject({ streaming: false, recording: false });
    expect(r.json.stats.freeDiskGb).toBe(200);
    expect(r.json.video.fps).toBe(30);
    expect(h.fake.mutations).toEqual([]);
  });

  it("list_scenes lists scenes top-first with their items", async () => {
    h = await startHarness();
    const r = await h.call("list_scenes");
    expect(r.json.scenes.map((s: { sceneName: string }) => s.sceneName)).toEqual(["Main", "BRB"]);
    expect(r.json.scenes[0].items.map((i: { sourceName: string }) => i.sourceName)).toEqual(["Camera", "Screen", "Mic", "Alerts"]);
  });

  it("merges OBS defaults into input settings and says which were changed", async () => {
    h = await startHarness();
    const r = await h.call("get_input_settings", { inputName: "Camera" });
    expect(r.json.settings).toMatchObject({ deactivate_when_not_showing: false, video_device_id: "cam-1" });
    expect(r.json.changedFromDefault).toEqual(["video_device_id"]);
  });

  it("redacts URL paths of browser sources", async () => {
    h = await startHarness();
    const r = await h.call("list_inputs", { includeSettings: true });
    const alerts = r.json.inputs.find((i: { inputName: string }) => i.inputName === "Alerts");
    expect(alerts.settings.url).toBe("https://alerts.example.com/[redacted]");
    expect(r.text).not.toContain("SECRET-WIDGET-TOKEN");
  });

  it("redacts the stream key of the service and of Source Record filters", async () => {
    h = await startHarness();
    const outputs = await h.call("get_outputs");
    expect(outputs.json.streamService.settings).toEqual({ server: "rtmp://live.example.com/app", key: "[redacted]" });
    const filters = await h.call("list_filters", { kind: "source_record_filter" });
    expect(filters.text).not.toContain("fake_sr_key_abc");
    expect(filters.text).not.toContain("fake_stream_key_987");
    const cam = filters.json.sources.find((s: { sourceName: string }) => s.sourceName === "Camera");
    expect(cam.filters[0].settings.key).toBe("[redacted]");
    // defaults filled in
    expect(cam.filters[0].settings.rec_format).toBe("hybrid_mp4");
  });

  it("reports a missing source as an error with OBS's reason", async () => {
    h = await startHarness();
    const r = await h.call("get_input_settings", { inputName: "Nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No source was found/);
  });
});

describe("dry_run and the live guard", () => {
  it("dry_run is the default: describes the change and sends nothing", async () => {
    h = await startHarness();
    const r = await h.call("switch_scene", { sceneName: "BRB" });
    expect(r.isError).toBe(false);
    expect(r.json.status).toBe("dry_run");
    expect(r.json.changes).toEqual({ from: "Main", to: "BRB" });
    expect(h.fake.mutations).toEqual([]);
    expect(h.fake.state.program).toBe("Main");
  });

  it("applies with dry_run=false when OBS is not live", async () => {
    h = await startHarness();
    const r = await h.call("switch_scene", { sceneName: "BRB", dry_run: false });
    expect(r.json.status).toBe("done");
    expect(h.fake.state.program).toBe("BRB");
  });

  it.each([
    ["streaming", { streaming: true, recording: false }],
    ["recording", { streaming: false, recording: true }],
  ])("refuses a real change while %s unless confirmLive=true", async (_label, live) => {
    const state = { ...defaultState(), ...live };
    h = await startHarness({ state });
    const refused = await h.call("switch_scene", { sceneName: "BRB", dry_run: false });
    expect(refused.isError).toBe(true);
    expect(refused.json.status).toBe("refused");
    expect(h.fake.mutations).toEqual([]);

    const dry = await h.call("switch_scene", { sceneName: "BRB" });
    expect(dry.json.status).toBe("dry_run");
    expect(dry.json.liveGuard).toBe(true);
    expect(dry.json.message).toMatch(/confirmLive=true/);

    const done = await h.call("switch_scene", { sceneName: "BRB", dry_run: false, confirmLive: true });
    expect(done.json.status).toBe("done");
    expect(h.fake.state.program).toBe("BRB");
  });

  it("guards every write tool the same way while live", async () => {
    const state = { ...defaultState(), streaming: true, recording: true };
    h = await startHarness({ state });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["switch_scene", { sceneName: "BRB" }],
      ["set_filter_settings", { sourceName: "Camera", filterName: "Record cam", settings: { record_mode: 3 } }],
      ["set_filter_enabled", { sourceName: "Camera", filterName: "Rounded", enabled: false }],
      ["set_filter_index", { sourceName: "Camera", filterName: "Rounded", filterIndex: 0 }],
      ["stop_record", {}],
      ["set_input_settings", { inputName: "Camera", settings: { deactivate_when_not_showing: true } }],
    ];
    for (const [name, args] of calls) {
      const r = await h.call(name, { ...args, dry_run: false });
      expect(r.json?.status, name).toBe("refused");
    }
    expect(h.fake.mutations).toEqual([]);
  });

  it("set_filter_settings shows a diff and applies only the given fields", async () => {
    h = await startHarness();
    const dry = await h.call("set_filter_settings", { sourceName: "Camera", filterName: "Record cam", settings: { record_mode: 4 } });
    expect(dry.json.changes).toEqual([{ field: "record_mode", before: 2, after: 4 }]);
    const done = await h.call("set_filter_settings", { sourceName: "Camera", filterName: "Record cam", settings: { record_mode: 4 }, dry_run: false });
    expect(done.json.status).toBe("done");
    expect(h.fake.state.filters.Camera![0]!.settings.record_mode).toBe(4);
    expect(h.fake.state.filters.Camera![0]!.settings.key).toBe("fake_sr_key_abc");
  });

  it("refuses settings that carry a [redacted] placeholder back", async () => {
    h = await startHarness();
    const r = await h.call("set_filter_settings", {
      sourceName: "Camera",
      filterName: "Record cam",
      settings: { key: "[redacted]", record_mode: 4 },
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/placeholder/);
    expect(h.fake.mutations).toEqual([]);
  });

  it("set_filter_index previews the new order", async () => {
    h = await startHarness();
    const r = await h.call("set_filter_index", { sourceName: "Camera", filterName: "Rounded", filterIndex: 0 });
    expect(r.json.changes).toEqual({ before: ["Record cam", "Rounded"], after: ["Rounded", "Record cam"] });
    expect(h.fake.mutations).toEqual([]);
  });

  it("stop_record always needs confirmLive (it only acts while recording)", async () => {
    h = await startHarness({ state: { ...defaultState(), recording: true } });
    expect((await h.call("stop_record", { dry_run: false })).json.status).toBe("refused");
    const done = await h.call("stop_record", { dry_run: false, confirmLive: true });
    expect(done.json.status).toBe("done");
    expect(h.fake.state.recording).toBe(false);
  });

  it("start_record is a no-op when already recording", async () => {
    h = await startHarness({ state: { ...defaultState(), recording: true } });
    const r = await h.call("start_record", { dry_run: false, confirmLive: true });
    expect(r.json.status).toBe("no_change");
    expect(h.fake.mutations).toEqual([]);
  });
});

describe("secrets never leave the process", () => {
  it("no tool output or log line contains the password", async () => {
    h = await startHarness();
    const outputs: string[] = [];
    for (const [name, args] of [
      ["get_overview", {}],
      ["list_scenes", {}],
      ["list_inputs", { includeSettings: true }],
      ["list_filters", {}],
      ["get_outputs", {}],
      ["check_source_record", {}],
      ["get_input_settings", { inputName: "Nope" }],
      ["switch_scene", { sceneName: "Nope" }],
    ] as const) {
      outputs.push((await h.call(name, args)).text);
    }
    const all = outputs.join("\n") + h.logs.join("");
    expect(all).not.toContain(PASSWORD);
    expect(h.logs.join("")).toMatch(/Connected to OBS/);
  });

  it("a wrong password produces a clear error that does not echo it", async () => {
    const wrong = "Wrong-Password-1234";
    h = await startHarness({ clientPassword: wrong });
    const r = await h.call("get_overview");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rejected the password/);
    expect(r.text + h.logs.join("")).not.toContain(wrong);
    expect(r.text + h.logs.join("")).not.toContain(PASSWORD);
    expect(h.fake.authFailures).toBeGreaterThan(0);
  });

  it("scrubs the password even if OBS echoes it back in a value", async () => {
    const state = defaultState();
    state.inputs[1]!.settings.window_title = `note: ${PASSWORD}`;
    h = await startHarness({ state });
    const r = await h.call("get_input_settings", { inputName: "Screen" });
    expect(r.text).not.toContain(PASSWORD);
    expect(r.json.settings.window_title).toBe("note: [redacted]");
  });
});

describe("dry-run diffs of secret fields", () => {
  it("never shows the old or new value of a secret field", async () => {
    h = await startHarness();
    const r = await h.call("set_filter_settings", { sourceName: "Camera", filterName: "Record cam", settings: { key: "new_fake_key_42" } });
    expect(r.json.changes).toEqual([{ field: "key", before: "[redacted]", after: "[redacted]" }]);
    expect(r.text).not.toContain("fake_sr_key_abc");
    expect(r.text).not.toContain("new_fake_key_42");
  });
});
