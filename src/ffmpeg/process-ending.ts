/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/process-ending.ts: The ending a failed or timed-out FFmpeg process hands its callbacks, the verdict they answer, the one rule for who is asked, and the
 * hardware decoder's refusal that ends a GPU decode ahead of them.
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
import type { FfmpegOptions } from "./options.ts";
import type { FfmpegProcessInit } from "./process.ts";
import { GPU_FRAMES_ARG } from "./settings.ts";

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

// The hardware decoder's refusal is decided here as well, beside the asking it comes ahead of: the text of FFmpeg's refusal line, the step that reads a stderr line
// for it and marks the options, and the rule that a failed process whose decoded frames were asked on the GPU and that read the refusal asks no callback at all.
// Each is internal, shared by the real process and the shipped doubles, so the published page for this module shows none of them. The test line built on that
// text is the exception: a plugin's suite hands it to a double, so it is published, through the testing entry point.

/**
 * What deciding a failed or timed-out ending answers: `"refused"` for a refused GPU decode, which asks no callback, and otherwise the {@link FfmpegEndingVerdict}
 * the callbacks answered.
 *
 * @category FFmpeg
 *
 * @internal
 */
export type FfmpegEndingOutcome = FfmpegEndingVerdict | "refused";

// The callback each reason's name selects. A name with no entry here selects none, so an orderly or self-inflicted ending asks nothing.
const SELECTED_CALLBACK: Readonly<Partial<Record<HbpuAbortReason, "onFailed" | "onTimeout">>> = {

  failed: "onFailed",
  timeout: "onTimeout"
};

// FFmpeg's own words when the host's hardware decoder could not be set up for the stream it was handed, the close of its "Failed setup for format <format>:" line.
// The line reports a refusal whether or not the process then fails: with its frames asked in system memory, FFmpeg goes on to decode in software by itself.
const HARDWARE_DECODER_REFUSAL = "hwaccel initialisation returned error";

/**
 * A stderr line that reports the hardware decoder's refusal, for a suite to hand a process double's `stderrLog`. It is an invented line in the form FFmpeg prints
 * one, the decoder's context prefix with an invented address and then the setup failure that closes on the refusal's words, and it is built on the text the
 * package reads the refusal by, so a double handed it reads the refusal as the real process reads it from its child.
 *
 * @example
 *
 * ```ts
 * import { TestStreamingProcess, hardwareDecoderRefusalLine } from "homebridge-plugin-utils/testing";
 *
 * // The double marks the options it was handed, as the real process does on the line that reports the refusal.
 * const proc = new TestStreamingProcess({}, options);
 *
 * proc.stderrLog = [hardwareDecoderRefusalLine];
 * ```
 *
 * @category Testing
 */
export const hardwareDecoderRefusalLine = "[h264 @ 0x0123456789ab] Failed setup for format videotoolbox_vld: " + HARDWARE_DECODER_REFUSAL + ".";

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
// The rules in this module live here rather than beside the process class because a shipped test double has to read the refusal and ask a plugin's callbacks
// exactly as the real process does, and a double reaches its subject by type alone. This module imports nothing at runtime but the shared FFmpeg constants, so the
// real process and a double can each import the rules by value without the double loading the process's spawn machinery, and the two cannot disagree about which
// line marks the refusal, which failure the refusal ends ahead of every callback, which callback an ending asks or when the asking stops.
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

/**
 * Read one stderr line for the hardware decoder's refusal, and mark `options` when the line carries it.
 *
 * A refusal is FFmpeg reporting that its hardware decoder could not be set up for the stream it was handed. It marks the options the moment it is read, whether
 * or not the process then fails, so every pipeline built over them from then on decodes in software. FFmpeg's words are matched whole, so a line carrying part of
 * them marks nothing. A caller reads its lines until the first refusal and none after it, so a long-running process's drain costs one flag read per line from then
 * on, and a mark a consumer resets is not set again by the same process.
 *
 * @param line    - The stderr line to read.
 * @param options - The options to mark. A caller with none to mark passes nothing and still learns whether the line carried the refusal.
 *
 * @returns `true` when the line carried the refusal, the options having been marked when they were handed, and `false` otherwise.
 *
 * @category FFmpeg
 *
 * @internal
 */
export function ffmpegMarkRefusal(line: string, options?: Pick<FfmpegOptions, "markHardwareDecoderRefusal">): boolean {

  if(!line.includes(HARDWARE_DECODER_REFUSAL)) {

    return false;
  }

  options?.markHardwareDecoderRefusal();

  return true;
}

/**
 * Decide a failed or timed-out ending: `"refused"`, asking no callback, for a refused GPU decode, and otherwise what {@link ffmpegEndingVerdict} answers over the
 * callback sets.
 *
 * A refused GPU decode is a failed ending of a process that read the hardware decoder's refusal on its own stderr and whose args asked for its decoded frames on the
 * GPU (`-hwaccel_output_format`). Such a process fails when the decoder refuses the stream, because the frames its chain then receives are not the GPU frames it was
 * built for, so the refusal is what ended it, and its options already decode every later pipeline in software, so no callback is asked about it. One that took its
 * frames in system memory decodes on in software after a refusal, so the refusal cannot explain its failure, and its ending is asked about as any other is. The
 * sighting is the process's own, never the options' mark, which another process over them may already have set, because only a refusal this process read can
 * explain its failure. A timeout is asked about whatever the stderr carried.
 *
 * Nothing is caught here: a callback's throw leaves this function, as it leaves {@link ffmpegEndingVerdict}.
 *
 * @param ending             - The ending to decide.
 * @param process            - What the process ran and read.
 * @param process.args       - The arguments the process was spawned with.
 * @param process.sawRefusal - Whether the process read the hardware decoder's refusal on its own stderr.
 * @param callbacks          - The callback sets to ask, in order, about any ending other than a refused GPU decode.
 *
 * @returns `"refused"` for a refused GPU decode, and otherwise `"handled"` or `"default"` as {@link ffmpegEndingVerdict} answers.
 *
 * @category FFmpeg
 *
 * @internal
 */
export function ffmpegEndingOutcome(ending: FfmpegEnding, { args, sawRefusal }: { readonly args: readonly string[]; readonly sawRefusal: boolean },
  ...callbacks: readonly Pick<FfmpegProcessInit, "onFailed" | "onTimeout">[]): FfmpegEndingOutcome {

  if((ending.reason.name === "failed") && sawRefusal && args.includes(GPU_FRAMES_ARG)) {

    return "refused";
  }

  return ffmpegEndingVerdict(ending, ...callbacks);
}
