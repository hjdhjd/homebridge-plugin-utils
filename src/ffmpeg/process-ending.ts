/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/process-ending.ts: The ending a failed or timed-out FFmpeg process hands its callbacks, the verdict they answer, and the one rule for who is asked.
 */

/**
 * The ending an FFmpeg process hands its `onFailed` and `onTimeout` callbacks, and the verdict each answers.
 *
 * A failed or timed-out process hands the matching callback an {@link FfmpegEnding}: the reason it ended for and the stderr lines it read. The callback
 * answers an {@link FfmpegEndingVerdict}: `"handled"` once it has reported the ending itself, or chosen to report nothing, or `"default"` to leave the ending to
 * whatever is asked next and, in the end, to the process's own report.
 *
 * @module
 */
import type { HbpuAbortError, HbpuAbortReason } from "../util.ts";
import type { FfmpegProcessInit } from "./process.ts";

/**
 * What an `onFailed` or `onTimeout` callback answers. `"handled"` means the callback reported the ending itself, or chose to report nothing, and the process logs
 * nothing further for it. `"default"` leaves the ending to whatever is asked next, and in the end to the process's own report.
 *
 * @category FFmpeg
 */
export type FfmpegEndingVerdict = "default" | "handled";

/**
 * The ending a failed or timed-out FFmpeg process hands its `onFailed` or `onTimeout` callback.
 *
 * @property reason    - The reason the process ended for, final by the time a callback is asked: `"failed"` for `onFailed`, `"timeout"` for `onTimeout`. A failure's
 *                       `cause` carries the exit information (`{ exitCode, exitSignal }`) for an exit other than with code 0, the underlying `Error` for a
 *                       spawn failure, or whatever cause the code that aborted the process attached.
 * @property stderrLog - The stderr lines the process has read so far. The real process hands the same readonly view its `stderrLog` getter returns, not a copy.
 *
 * @category FFmpeg
 */
export interface FfmpegEnding {

  readonly reason: HbpuAbortError;
  readonly stderrLog: readonly string[];
}

// The callback each reason's name selects. A name with no entry here selects none, so an orderly or self-inflicted ending asks nothing.
const SELECTED_CALLBACK: Readonly<Partial<Record<HbpuAbortReason, "onFailed" | "onTimeout">>> = {

  failed: "onFailed",
  timeout: "onTimeout"
};

/**
 * Ask the callbacks an ending selects, in order, and answer the first `"handled"` among them, or `"default"` when none handles it.
 *
 * The reason's name selects the callback: `onFailed` for `"failed"`, `onTimeout` for `"timeout"`, and none for any other name. Each set is asked in the order given,
 * a set without the selected callback is passed over, and the first callback to answer `"handled"` ends the asking. A process kind that answers some endings itself
 * hands its plugin's set first and its own after it, so a plugin's `"default"` passes to the kind's own answer and from there to the base's report.
 *
 * Nothing is caught here: a callback's throw leaves this function. The real process guards its call and logs the throw, and a test double leaves it to surface so a
 * suite sees the bug in its own callback.
 *
 * @param ending    - The ending to ask about.
 * @param callbacks - The callback sets to ask, in order.
 *
 * @returns `"handled"` when a selected callback handled the ending, otherwise `"default"`.
 *
 * @category FFmpeg
 *
 * @internal
 */
// The rule lives here rather than beside the process class because a shipped test double has to ask a plugin's callbacks exactly as the real process does, and a
// double reaches its subject by type alone. This module imports nothing at runtime, so the real process and a double can each import the rule by value without the
// double loading the process's spawn machinery, and the two cannot disagree about which callback an ending asks or when the asking stops.
export function ffmpegEndingVerdict(ending: FfmpegEnding, ...callbacks: readonly Pick<FfmpegProcessInit, "onFailed" | "onTimeout">[]): FfmpegEndingVerdict {

  const selected = SELECTED_CALLBACK[ending.reason.name];

  if(selected === undefined) {

    return "default";
  }

  for(const set of callbacks) {

    if(set[selected]?.(ending) === "handled") {

      return "handled";
    }
  }

  return "default";
}
