/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/mp4-frame-feed.ts: Feeds an fMP4 stream to a writer one video frame at a time.
 */

/**
 * Feeds an fMP4 stream to a {@link backpressure!BackpressureWriter | BackpressureWriter} one video frame at a time.
 *
 * FFmpeg passes each frame on as its bytes arrive, so a fragment written into its stdin whole leaves FFmpeg as a burst of frames and then a gap, and a viewer sees
 * the motion stutter at every fragment. {@link Mp4FrameFeed} joins the reader and the paced write that fix it:
 * {@link ffmpeg/fmp4!splitVideoFrames | splitVideoFrames} cuts each fragment at its video frames, and
 * {@link backpressure!BackpressureWriter.writePaced | BackpressureWriter.writePaced} writes the pieces a frame's duration apart, the first after a start delay the
 * feed reads from the video's own time.
 *
 * @module
 */
import { findVideoTrack, splitVideoFrames } from "./fmp4.ts";
import type { BackpressureWriter } from "../backpressure.ts";
import type { Clock } from "../clock.ts";
import type { FMp4Track } from "./fmp4.ts";
import type { Nullable } from "../util.ts";
import { systemClock } from "../clock.ts";

/* How long an arrival's lateness counts toward the floor, in milliseconds: the floor is the smallest lateness of the arrivals this recent, the one in hand
 * included, and the target's ceiling stands a fixed height above it. An arrival this old or more has left the window. A longer window keeps the ceiling on the
 * lateness the stream had before a stall through a longer stall, and a shorter one lets the ceiling follow sooner a stream whose every arrival has grown later,
 * at the cost of letting a shorter stall's lateness hold the stream back after it.
 */
const FLOOR_WINDOW_MS = 2000;

/* How fast the target falls while arrivals come in earlier than it, in milliseconds of lateness for each second between one arrival and the next. A slow fall
 * keeps first frames held to a late arrival's lateness through the jitter that recurs after it, so more first frames keep their spacing, at the cost of giving
 * that added delay back only gradually. A faster fall gives the delay back sooner and paces less of the jitter.
 */
const TARGET_FALL_MS_PER_SECOND = 2;

/* How far above the floor the target may stand, in milliseconds, which is the most delay the feed ever adds to a fragment's first frame. It bounds how long a
 * stall's catch-up can hold the stream back, and so how many fragments can queue behind one that is holding. A higher ceiling paces more of a long stall's
 * catch-up at the cost of a longer added delay. The class doc states this figure, in milliseconds, as the feed's contract with a plugin.
 */
const ADDED_DELAY_CEILING_MS = 200;

/**
 * The part of a {@link backpressure!BackpressureWriter | BackpressureWriter} an {@link Mp4FrameFeed} writes through: the plain write and the paced write.
 *
 * @category FFmpeg
 */
export type Mp4FrameFeedWriter = Pick<BackpressureWriter, "write" | "writePaced">;

/**
 * Why an {@link Mp4FrameFeed} wrote a fragment whole although the header before it named a video track, as its `onUnpaced` report states it.
 *
 * - `"no-video"` - no track fragment in the fragment names the header's video track, as in a fragment of audio alone. A `moof` whose walk of its track fragments
 *   meets a box the reader cannot read reads this way too, because the walk ends there with no track fragment naming the track.
 * - `"unreadable"` - the fragment has no `moof` or no `mdat` after it, or the track fragment that names the video track is in a layout the frame reader does not
 *   know, so it cannot be cut at its frames.
 *
 * @category FFmpeg
 */
export type Mp4UnpacedReason = "no-video" | "unreadable";

/**
 * Construction options for {@link Mp4FrameFeed}.
 *
 * @category FFmpeg
 */
export interface Mp4FrameFeedInit {

  /**
   * The time source the feed reads each fragment's arrival from. Pass the writer's clock: the feed measures a fragment's start delay on this clock and the writer
   * holds it on its own, so the two have to read the same time. Defaults to {@link systemClock}, which is the writer's default too.
   */
  clock?: Clock;

  /**
   * Called with a fragment the feed is about to write whole although the header named a video track, and why. It fires once per header for each
   * {@link Mp4UnpacedReason}, for the first such fragment after it, before that fragment's write is issued, so a plugin decides which reasons earn a log line and
   * writes each once rather than once per fragment.
   *
   * It must not throw. It runs before the fragment's write is issued, so a throw rejects that fragment's {@link Mp4FrameFeed.writeFragment} with the write never
   * issued.
   */
  onUnpaced?: (fragment: Buffer, reason: Mp4UnpacedReason) => void;
}

// A lateness and the arrival it belongs to, on the feed's clock: each arrival in the floor's window with its own lateness, the arrival less the video time its
// first frame falls at, and the target with the arrival it was last set at.
interface Arrival {

  readonly at: number;
  readonly lateness: number;
}

// What a header said and what the fragments since it have added, set afresh by every header: the floor's window of recent arrivals, the video time handed to
// the writer since, in milliseconds, the reasons reported since, the target with the arrival it was last set at, null until the first paced fragment, and the
// header's video track, null when it named none.
interface HeaderState {

  readonly floor: Arrival[];
  mediaTime: number;
  readonly reported: Set<Mp4UnpacedReason>;
  target: Nullable<Arrival>;
  readonly track: Nullable<FMp4Track>;
}

/* Add an arrival to the floor's window and answer the smallest lateness the window holds with it. The window is kept as a sliding-window minimum: its arrivals
 * are in the order they came, each with a lateness below every one after it, so its first holds its smallest. An arrival leaves from the front once the newest is
 * the window's length or more after it, and from the back once a newer one is no later, because the newer one stays in the window longer and so the older one can
 * never be the smallest again.
 */
function joinFloor(window: Arrival[], at: number, lateness: number): number {

  for(let oldest = window.at(0); oldest && ((at - oldest.at) >= FLOOR_WINDOW_MS); oldest = window.at(0)) {

    window.shift();
  }

  for(let newest = window.at(-1); newest && (newest.lateness >= lateness); newest = window.at(-1)) {

    window.pop();
  }

  // Every arrival left holds a smaller lateness than this one, so the oldest left holds the smallest, and an empty window leaves this arrival the smallest itself.
  const smallest = window.at(0)?.lateness ?? lateness;

  window.push({ at, lateness });

  return smallest;
}

/**
 * Feeds an fMP4 stream to a writer: the stream's header whole, and each fragment as its video frames, the first when the video's own time says it is due and each
 * later one a frame's duration after the one before it.
 *
 * The feed is handed a writer and never builds one, so the writer's stream, lifetime, queue limit and clock stay the plugin's own. A fragment arrives once its last
 * frame is captured, so how late its first frame reaches the feed varies with how many frames it holds and with the network, and writing each first frame as it
 * arrives would bunch some frames and leave gaps after others. The feed keeps a clock of the video's own time instead: the sum of the video durations it has handed
 * to the writer since the last header, which is when the next fragment's first frame falls on the video's timeline. A fragment's lateness is its arrival less that
 * sum, and the feed holds its first frame by a target lateness less its own, so first frames leave the feed at one lateness and every frame keeps the spacing it
 * was recorded with. The target rises at once to an arrival later than it and falls slowly while arrivals come in earlier, never below the lateness in hand,
 * and all of that is held to a ceiling above the floor, the smallest lateness of a short window of recent arrivals: an arrival later than the ceiling is held by
 * nothing and leaves the target at the ceiling. So jitter that recurs is paced at the lateness of the latest late arrival, and a stall leaves the stream no more
 * than the ceiling behind its floor. The sum, the target and the floor count every fragment handed
 * to the paced write, so one the writer refuses, drops or rejects has entered each of them, because its frames' time passed in the stream whether or not they
 * reached FFmpeg.
 *
 * A fragment the reader cuts goes to the writer's paced write with its start delay. A fragment with no video in it, and one the reader cannot cut, go to its plain
 * write whole, enter none of the sum, the target and the floor, and are reported through `onUnpaced` once per header for each reason. A fragment before any
 * header, or after a header that names no video track, goes to the plain write whole and is not reported. So a fragment always reaches FFmpeg, paced or not, as
 * long as `onUnpaced` does not throw. A fragment written whole is a plain write, so one queued behind a held fragment waits for that fragment's start, and the
 * held fragment then sends the frames it has left at once, ahead of it. The feed holds no timer, signal or queue of its own and has nothing to dispose.
 *
 * Every new FFmpeg process needs the stream's header before any fragment, so a plugin hands the feed the header again whenever it starts one, and each header
 * starts the video's clock, the target and the floor afresh. Fragments already queued when a header is written go out ahead of it, each after its hold, so a
 * plugin that needs a new process to open on its header builds that process a writer of its own. The fragments' layout is their producer's: a layout the reader
 * does not know ends the pacing but never the stream, and `onUnpaced` is how a plugin learns that has happened.
 *
 * The feed never asks for more than 200 ms of added delay: no fragment's first frame is held longer than that. Write each fragment without awaiting the one
 * before it, because the frames a fragment has left go out at once when the next one is due, and that catch-up is what keeps a late fragment from making every
 * later one late too. A writer's queue limit therefore needs room for every fragment that arrives within 200 ms, with the one holding and the next, because a
 * lower limit refuses fragments, and their frames are lost. Saved video a plugin opens a process on goes in with the header, which may carry fragments after it,
 * or through the writer's plain write, because `writeFragment` reads every arrival as live.
 *
 * @example
 *
 * ```ts
 * import { BackpressureWriter, Mp4FrameFeed } from "homebridge-plugin-utils";
 *
 * const writer = new BackpressureWriter(() => ffmpegProcess.stdin ?? null, { signal: session.signal });
 * const feed = new Mp4FrameFeed(writer, { onUnpaced: (fragment, reason) => log.warn("A fragment is written whole.", { bytes: fragment.length, reason }) });
 *
 * // The header goes to every new FFmpeg process first.
 * feed.writeHeader(initSegment).catch((error: unknown) => log.debug("The header write ended early.", { error }));
 *
 * // Each fragment is issued as it arrives, without awaiting the one before it.
 * camera.on("fragment", (fragment: Buffer) => {
 *
 *   feed.writeFragment(fragment).catch((error: unknown) => log.debug("A fragment write ended early.", { error }));
 * });
 * ```
 *
 * @category FFmpeg
 */
export class Mp4FrameFeed {

  // The time source each fragment's arrival is read from.
  readonly #clock: Clock;

  // The plugin's report of a fragment written whole, when it asked for one.
  readonly #onUnpaced: ((fragment: Buffer, reason: Mp4UnpacedReason) => void) | undefined;

  // What the last header said and what the fragments since it have added. Null until the first header, so a fragment before any header is written whole and
  // reports nothing.
  #state: Nullable<HeaderState> = null;

  // The writer every byte goes through.
  readonly #writer: Mp4FrameFeedWriter;

  /**
   * Build a feed over a writer.
   *
   * @param writer - The writer the feed writes through, typically a {@link backpressure!BackpressureWriter | BackpressureWriter} over an FFmpeg process's stdin.
   * @param init   - Optional init options. See {@link Mp4FrameFeedInit}.
   */
  public constructor(writer: Mp4FrameFeedWriter, { clock = systemClock, onUnpaced }: Mp4FrameFeedInit = {}) {

    this.#clock = clock;
    this.#onUnpaced = onUnpaced;
    this.#writer = writer;
  }

  /**
   * Write the stream's header whole, read its video track for the fragments that follow it, and start the video's clock, the target and the floor afresh.
   *
   * @param header - The stream's initialization segment, alone or followed by fragments.
   *
   * @returns The writer's plain write of the header.
   */
  public async writeHeader(header: Buffer): Promise<void> {

    this.#state = { floor: [], mediaTime: 0, reported: new Set(), target: null, track: findVideoTrack(header) };

    return this.#writer.write(header);
  }

  /**
   * Write a fragment as its video frames, the first after the start delay the video's own time gives it and each later one when it is due, or whole when there is
   * no video track to cut it at, when it holds no video, or when the reader cannot cut it.
   *
   * @param fragment - One complete fragment of the stream.
   *
   * @returns The writer's paced write of the fragment's pieces, or its plain write of the whole fragment.
   */
  public async writeFragment(fragment: Buffer): Promise<void> {

    const state = this.#state;

    // No header yet, or a header with no video track: there is nothing to cut the fragment at, and nothing to report.
    if(!state?.track) {

      return this.#writer.write(fragment);
    }

    const pieces = splitVideoFrames(fragment, state.track);

    // The reader answers an empty list when no track fragment names the video track and null when it cannot cut the one that does. In each case the fragment
    // goes whole, reads no clock and touches none of the sum, the target and the floor, and each reason is reported once per header, before the write is issued.
    if((pieces === null) || (pieces.length === 0)) {

      const reason = (pieces === null) ? "unreadable" : "no-video";

      if(!state.reported.has(reason)) {

        state.reported.add(reason);
        this.#onUnpaced?.(fragment, reason);
      }

      return this.#writer.write(fragment);
    }

    // The fragment's lateness is its arrival less the video time its first frame falls at, read on the monotonic clock, which a wall-clock change never moves.
    // The ceiling stands its fixed height above the floor, which this arrival joins.
    const arrival = this.#clock.monotonic();
    const lateness = arrival - state.mediaTime;
    const ceiling = joinFloor(state.floor, arrival, lateness) + ADDED_DELAY_CEILING_MS;

    /* The target falls at its fixed rate for the time since the arrival it was last set at, never below this fragment's lateness, so a lateness at or above it
     * raises it at once. It is held to the ceiling, and the held value is what the next arrival falls from, so a stall's lateness is never remembered above the
     * ceiling. The first frame waits the target less its own lateness, which a lateness past the ceiling leaves at nothing. Every part of the rule reads the
     * arrival before the write is issued, so a fragment the writer refuses or drops has already entered the target and the floor, as its duration enters the sum.
     */
    const fallen = state.target ? Math.max(lateness, state.target.lateness - (((arrival - state.target.at) * TARGET_FALL_MS_PER_SECOND) / 1000)) : lateness;

    state.target = { at: arrival, lateness: Math.min(fallen, ceiling) };
    state.mediaTime += pieces.reduce((total, { duration }) => total + duration, 0);

    return this.#writer.writePaced(pieces, { startDelay: Math.max(0, state.target.lateness - lateness) });
  }
}
