import type { ObsClient } from "./obs.ts";
import { getLiveState, isLive, type LiveState } from "./obsData.ts";
import { REDACTED } from "./redact.ts";

/**
 * Every tool that changes OBS goes through `runGuarded`:
 *
 * - dry_run defaults to true: the first call only describes the change.
 * - Live guard: while OBS is streaming or recording, a real change is refused
 *   unless the caller also passes confirmLive=true. The state is read from OBS
 *   right before applying, not cached.
 */

export interface GuardOptions {
  dryRun: boolean;
  confirmLive: boolean;
}

export interface MutationPlan {
  /** One sentence: what would happen. */
  action: string;
  /** What changes (diff, before/after). Redacted by the caller's output layer. */
  changes?: unknown;
  apply: () => Promise<unknown>;
}

export type GuardResult =
  | { status: "dry_run"; action: string; changes?: unknown; live: LiveState; liveGuard: boolean; message: string }
  | { status: "refused"; action: string; changes?: unknown; live: LiveState; liveGuard: true; message: string }
  | { status: "done"; action: string; changes?: unknown; live: LiveState; result?: unknown; message: string };

export function liveDescription(live: LiveState): string {
  const parts: string[] = [];
  if (live.streaming) parts.push("streaming");
  if (live.recording) parts.push(live.recordingPaused ? "recording (paused)" : "recording");
  return parts.join(" and ");
}

export async function runGuarded(obs: ObsClient, opts: GuardOptions, plan: MutationPlan): Promise<GuardResult> {
  const live = await getLiveState(obs);
  const liveNow = isLive(live);
  if (opts.dryRun) {
    return {
      status: "dry_run",
      action: plan.action,
      changes: plan.changes,
      live,
      liveGuard: liveNow,
      message:
        "Dry run: nothing was changed. To apply it, call again with dry_run=false" +
        (liveNow ? ` and confirmLive=true, because OBS is ${liveDescription(live)} right now.` : "."),
    };
  }
  if (liveNow && !opts.confirmLive) {
    return {
      status: "refused",
      action: plan.action,
      changes: plan.changes,
      live,
      liveGuard: true,
      message: `Refused: OBS is ${liveDescription(live)}. This change would be seen live. Ask the person first, then call again with confirmLive=true.`,
    };
  }
  const result = await plan.apply();
  return {
    status: "done",
    action: plan.action,
    changes: plan.changes,
    live,
    ...(result === undefined ? {} : { result }),
    message: "Done.",
  };
}

/**
 * Settings echoed back from a read tool contain "[redacted]" placeholders.
 * Sending them back would overwrite a real stream key or URL with the
 * placeholder, so they are rejected.
 */
export function findRedactedPlaceholders(settings: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(settings)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string" && v.includes(REDACTED)) out.push(path);
    else if (v && typeof v === "object" && !Array.isArray(v)) out.push(...findRedactedPlaceholders(v as Record<string, unknown>, path));
  }
  return out;
}
