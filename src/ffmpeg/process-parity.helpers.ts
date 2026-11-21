/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/process-parity.helpers.ts: Shared test helpers for the FFmpeg suites that hold a shipped double to its subject - the parity runner and its readings, the
 * ending spies, and the uncaught-exception hold.
 */

/**
 * The helpers the FFmpeg suites share when they hold a shipped double to the subject it stands in for: the runner that takes one scenario through the double and
 * through the real subject and asserts the double reads as the subject does, the readings a parity row compares, the spy callbacks a row hands each subject, and
 * the hold on Node's uncaught-exception channel a row takes to see what an ending callback threw.
 *
 * Each suite keeps its own starters, the functions that bring a subject to a row's starting point, and hands them to {@link assertEachSubject}, so the runner and the
 * readings are stated once while what each subject starts from stays beside the rows that start from it.
 *
 * Files matching `*.helpers.ts` are excluded from the compiled `dist/` build emit (see `tsconfig.build.json`) and from the TypeDoc API docs output (see
 * `typedoc.json`), so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import type { FfmpegEnding, FfmpegEndingVerdict } from "./process-ending.ts";
import { HbpuAbortError } from "../util.ts";
import type { Mock } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

/**
 * A parity row's spy callbacks, each answering `"handled"` and recording every asking.
 */
export interface EndingSpies {

  readonly onFailed: Mock<(ending: FfmpegEnding) => FfmpegEndingVerdict>;
  readonly onTimeout: Mock<(ending: FfmpegEnding) => FfmpegEndingVerdict>;
}

/**
 * Fresh spy callbacks. A row takes one pair per subject, since a scenario runs once on each.
 *
 * @returns An `onFailed` and an `onTimeout` that each answer `"handled"` and record every asking.
 */
export function endingSpies(): EndingSpies {

  return { onFailed: mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled"), onTimeout: mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => "handled") };
}

/**
 * Run one scenario against a shipped double and against the real subject it stands in for, and assert each reported the expected reading. One assertion over the
 * readings means a failure shows which subject disagreed, and with what.
 *
 * @typeParam Start - A starter, the suite's own function that brings a subject to the stage a row starts from.
 * @typeParam T     - The reading a scenario takes.
 *
 * @param starters - The suite's starters: the double's and the real subject's.
 * @param expected - The reading each subject must report.
 * @param scenario - The row's body, run once with each starter, the double's first.
 */
export async function assertEachSubject<Start, T>(starters: { double: Start; real: Start }, expected: T, scenario: (start: Start) => Promise<T>): Promise<void> {

  assert.deepEqual({ double: await scenario(starters.double), real: await scenario(starters.real) }, { double: expected, real: expected });
}

/**
 * The name of an abort reason. A row compares names, because each subject constructs its own reason objects for the same cause.
 *
 * @param reason - The reason to name.
 *
 * @returns The reason's name when it is an `HbpuAbortError`, and a fixed phrase otherwise.
 */
export function reasonName(reason: unknown): string {

  return (reason instanceof HbpuAbortError) ? reason.name : "a reason other than an HbpuAbortError";
}

/**
 * The state of a lifetime: `"live"`, or the name of the reason it ended for.
 *
 * @param signal - The lifetime to read.
 *
 * @returns `"live"` while the signal has not aborted, and the name of its reason once it has.
 */
export function lifetimeState(signal: AbortSignal): string {

  return signal.aborted ? reasonName(signal.reason) : "live";
}

/**
 * How a promise settled: `"resolved"`, or `"rejected"` with the name of its reason. Awaiting the promise here is also what observes it.
 *
 * @param promise - The promise to read.
 *
 * @returns `"resolved"`, or `"rejected "` followed by the name of the reason it rejected with.
 */
export async function settlement(promise: Promise<unknown>): Promise<string> {

  try {

    await promise;

    return "resolved";
  } catch(error: unknown) {

    return "rejected " + reasonName(error);
  }
}

/* Hold one of Node's process-wide failure channels for the length of `body` and hand it back afterwards, giving the body what the channel carried. The test runner
 * keeps its own listener on each channel and fails the running test on anything it sees, so a row that asserts what reached a channel, or that nothing did, has to
 * own it while it looks.
 */
async function captureChannel<T>(channel: "uncaughtException" | "unhandledRejection", body: (captured: readonly unknown[]) => Promise<T>): Promise<T> {

  const captured: unknown[] = [];
  const runnerListeners = process.listeners(channel);
  const onCarried = (carried: unknown): void => {

    captured.push(carried);
  };

  process.removeAllListeners(channel);
  process.on(channel, onCarried);

  try {

    return await body(captured);
  } finally {

    process.off(channel, onCarried);

    for(const listener of runnerListeners) {

      process.on(channel, listener);
    }
  }
}

/**
 * Hold Node's uncaught-exception channel for the length of `body`, giving the body the errors the channel carried.
 *
 * @typeParam T - What the body answers.
 *
 * @param body - The row's work, handed the errors the channel has carried so far.
 *
 * @returns What the body answers.
 */
export async function captureUncaughtExceptions<T>(body: (captured: readonly unknown[]) => Promise<T>): Promise<T> {

  return captureChannel("uncaughtException", body);
}

/**
 * Hold Node's unhandled-rejection channel for the length of `body`, giving the body the reasons the channel carried.
 *
 * @typeParam T - What the body answers.
 *
 * @param body - The row's work, handed the reasons the channel has carried so far.
 *
 * @returns What the body answers.
 */
export async function captureUnhandledRejections<T>(body: (captured: readonly unknown[]) => Promise<T>): Promise<T> {

  return captureChannel("unhandledRejection", body);
}
