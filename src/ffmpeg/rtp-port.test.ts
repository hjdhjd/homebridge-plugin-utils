/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp-port.test.ts: Unit tests for the input port rule the two-way audio demuxer shares with its doubles - the ports a UDP socket can hold, each bound of the
 * range, and the refusal a port outside it answers.
 */
import { HIGHEST_UDP_PORT, inputPortError } from "./rtp-port.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("inputPortError", () => {

  test("answers null for each bound of the range a UDP socket can hold, and for a port inside it", () => {

    for(const inputPort of [ 0, 1, 50000, HIGHEST_UDP_PORT ]) {

      assert.equal(inputPortError(inputPort), null);
    }
  });

  test("answers a RangeError naming the rule for a port below the range, a port above it, a fraction, and a value that is no number", () => {

    for(const inputPort of [ -1, HIGHEST_UDP_PORT + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY ]) {

      const refusal = inputPortError(inputPort);

      assert.ok(refusal instanceof RangeError);
      assert.equal(refusal.message, "RtpDemuxer: inputPort must be a whole number from 0 to 65535.");
    }
  });

  test("the highest port is the highest a 16-bit port field carries", () => {

    assert.equal(HIGHEST_UDP_PORT, 0xFFFF);
  });
});
