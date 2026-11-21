/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/process-ending.test.ts: Unit tests for ffmpegEndingVerdict - the callback a reason's name selects, the order the callback sets are asked in, the answer when
 * none handles the ending, and a throwing callback leaving the function.
 */
import type { FfmpegEnding, FfmpegEndingVerdict } from "./process-ending.ts";
import { describe, mock, test } from "node:test";
import { HbpuAbortError } from "../util.ts";
import type { HbpuAbortReason } from "../util.ts";
import type { Mock } from "node:test";
import assert from "node:assert/strict";
import { expectAt } from "../testing/index.ts";
import { ffmpegEndingVerdict } from "./process-ending.ts";

// An ending for a reason of the given name, carrying an invented stderr line.
function endingFor(name: HbpuAbortReason): FfmpegEnding {

  return { reason: new HbpuAbortError(name), stderrLog: ["an invented stderr line"] };
}

// A callback that answers `verdict` and records every ending it is asked with.
function answering(verdict: FfmpegEndingVerdict): Mock<(ending: FfmpegEnding) => FfmpegEndingVerdict> {

  return mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => verdict);
}

describe("ffmpegEndingVerdict - the callback a reason's name selects", () => {

  test("a failed ending asks onFailed alone, handing it the ending", () => {

    const ending = endingFor("failed");
    const onFailed = answering("handled");
    const onTimeout = answering("handled");

    assert.equal(ffmpegEndingVerdict(ending, { onFailed, onTimeout }), "handled", "onFailed's handled is the answer");
    assert.deepEqual({ onFailed: onFailed.mock.callCount(), onTimeout: onTimeout.mock.callCount() }, { onFailed: 1, onTimeout: 0 }, "onFailed alone is asked");
    assert.equal(expectAt(onFailed.mock.calls, 0, "the asking").arguments[0], ending, "and it is handed the ending itself");
  });

  test("a timed-out ending asks onTimeout alone, handing it the ending", () => {

    const ending = endingFor("timeout");
    const onFailed = answering("handled");
    const onTimeout = answering("handled");

    assert.equal(ffmpegEndingVerdict(ending, { onFailed, onTimeout }), "handled", "onTimeout's handled is the answer");
    assert.deepEqual({ onFailed: onFailed.mock.callCount(), onTimeout: onTimeout.mock.callCount() }, { onFailed: 0, onTimeout: 1 }, "onTimeout alone is asked");
    assert.equal(expectAt(onTimeout.mock.calls, 0, "the asking").arguments[0], ending, "and it is handed the ending itself");
  });

  for(const name of [ "closed", "replaced", "shutdown" ] as const) {

    test("a " + name + " ending asks neither callback and answers default", () => {

      const onFailed = answering("handled");
      const onTimeout = answering("handled");

      assert.equal(ffmpegEndingVerdict(endingFor(name), { onFailed, onTimeout }), "default", "no callback is selected, so the default stands");
      assert.deepEqual({ onFailed: onFailed.mock.callCount(), onTimeout: onTimeout.mock.callCount() }, { onFailed: 0, onTimeout: 0 }, "and neither is asked");
    });
  }
});

describe("ffmpegEndingVerdict - the order the callback sets are asked in", () => {

  test("the first set's handled ends the asking", () => {

    const first = answering("handled");
    const second = answering("handled");

    assert.equal(ffmpegEndingVerdict(endingFor("failed"), { onFailed: first }, { onFailed: second }), "handled", "the first set handled the ending");
    assert.deepEqual({ first: first.mock.callCount(), second: second.mock.callCount() }, { first: 1, second: 0 }, "and the second is never asked");
  });

  test("a default passes the ending to the next set, whose handled is the answer", () => {

    const first = answering("default");
    const second = answering("handled");

    assert.equal(ffmpegEndingVerdict(endingFor("timeout"), { onTimeout: first }, { onTimeout: second }), "handled", "the second set handled the ending");
    assert.deepEqual({ first: first.mock.callCount(), second: second.mock.callCount() }, { first: 1, second: 1 }, "after the first answered default");
  });

  test("a callback answering neither verdict reads as default, and the next set is still asked", () => {

    const first = mock.fn((_ending: FfmpegEnding): FfmpegEndingVerdict => undefined as unknown as FfmpegEndingVerdict);
    const second = answering("default");

    assert.equal(ffmpegEndingVerdict(endingFor("failed"), { onFailed: first }, { onFailed: second }), "default", "the answer that is neither verdict reads as default");
    assert.deepEqual({ first: first.mock.callCount(), second: second.mock.callCount() }, { first: 1, second: 1 }, "and the asking goes on to the next set");
  });

  test("a set without the selected callback is passed over", () => {

    const onFailed = answering("handled");
    const onTimeout = answering("handled");

    assert.equal(ffmpegEndingVerdict(endingFor("failed"), { onTimeout }, { onFailed }), "handled", "the later set's onFailed handled the ending");
    assert.deepEqual({ onFailed: onFailed.mock.callCount(), onTimeout: onTimeout.mock.callCount() }, { onFailed: 1, onTimeout: 0 },
      "and the earlier set's other callback is not asked in its place");
  });

  test("the answer is default when every set answers default", () => {

    const first = answering("default");
    const second = answering("default");

    assert.equal(ffmpegEndingVerdict(endingFor("failed"), { onFailed: first }, { onFailed: second }), "default", "no set handled the ending");
    assert.deepEqual({ first: first.mock.callCount(), second: second.mock.callCount() }, { first: 1, second: 1 }, "though each was asked");
  });

  test("the answer is default when no set carries a callback", () => {

    assert.equal(ffmpegEndingVerdict(endingFor("failed")), "default", "with no set at all");
    assert.equal(ffmpegEndingVerdict(endingFor("timeout"), {}, {}), "default", "and with sets that carry nothing");
  });
});

describe("ffmpegEndingVerdict - a throwing callback", () => {

  test("the throw leaves the function, and no later set is asked", () => {

    const failure = new Error("An invented callback failure.");
    const later = answering("handled");
    const throwing = (): FfmpegEndingVerdict => {

      throw failure;
    };

    assert.throws(() => ffmpegEndingVerdict(endingFor("failed"), { onFailed: throwing }, { onFailed: later }), (thrown: unknown) => thrown === failure,
      "the callback's own throw reaches the caller unchanged");
    assert.equal(later.mock.callCount(), 0, "and the asking stops there");
  });
});
