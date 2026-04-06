/* Copyright(C) 2022-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/settings.ts: Settings and constants for HomeKit FFmpeg utilities.
 */

// HomeKit prefers an I-frame interval of 5 seconds when livestreaming.
export const HOMEKIT_IDR_INTERVAL = 5;

// Additional headroom for bitrates beyond what HomeKit is requesting when streaming to improve quality with a minor additional bandwidth cost.
export const HOMEKIT_STREAMING_HEADROOM = 64;

// HomeKit Secure Video fragment length, in milliseconds. HomeKit only supports this value currently.
export const HKSV_FRAGMENT_LENGTH = 4000;

// HomeKit prefers a default I-frame interval of 4 seconds for HKSV event recordings.
export const HKSV_IDR_INTERVAL = 4;

// HomeKit Secure Video communication timeout threshold, in milliseconds. HKSV has a strict 5 second threshold for communication, so we set this a little below that.
export const HKSV_TIMEOUT = 4500;

// FFmpeg's default input timeout, in milliseconds. FFmpeg terminates input streams that receive no data for this duration. The SIGKILL failsafe in process.ts and the
// stream health monitor in stream.ts are both coordinated with this value.
export const FFMPEG_INPUT_TIMEOUT = 5000;

// Minimum required GPU memory on a Raspberry Pi to enable hardware acceleration.
export const RPI_GPU_MINIMUM = 128;
