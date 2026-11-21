/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp-port.ts: The highest port UDP carries and the one rule for the input port a two-way audio demuxer may be asked to bind.
 */

/**
 * The port rule the two-way audio demuxer shares with its doubles.
 *
 * The real demuxer refuses an input port no UDP socket can hold before it builds anything, and the double that stands in for it has to refuse the same ports, or a
 * plugin's suite passes on a port its plugin throws on in the field. Each reads the rule here, so they cannot come to disagree about which ports are refused or
 * what the refusal says.
 *
 * This module imports nothing by value. A double reads it without loading any of the demuxer's socket machinery, and the demuxer reads it without importing from a
 * double.
 *
 * @module
 */
import type { Nullable } from "../util.ts";

/**
 * The highest port number UDP carries.
 *
 * @category FFmpeg
 */
export const HIGHEST_UDP_PORT = 65535;

/**
 * Check the input port a demuxer is asked to bind against what a UDP socket can hold: a whole number from 0, which asks the kernel for an ephemeral port, to 65535.
 * The demuxer and its double each throw what this answers ahead of everything else they do, so a refused construction has built nothing and bound nothing.
 *
 * @param inputPort - The port the construction asks for.
 *
 * @returns A `RangeError` naming the rule when no UDP socket can hold the port, and `null` when one can.
 *
 * @category FFmpeg
 */
export function inputPortError(inputPort: number): Nullable<RangeError> {

  if(!Number.isInteger(inputPort) || (inputPort < 0) || (inputPort > HIGHEST_UDP_PORT)) {

    return new RangeError("RtpDemuxer: inputPort must be a whole number from 0 to 65535.");
  }

  return null;
}
