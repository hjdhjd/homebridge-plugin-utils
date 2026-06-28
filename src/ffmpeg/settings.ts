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

// Default inactivity window, in milliseconds, for the streaming return-port health watchdog (ffmpeg/stream.ts): once a live stream is flowing, the HomeKit client sends
// RTCP receiver reports back to the return port, and if no inbound packet arrives within this window the watchdog aborts the process. This is the watchdog's own
// cadence, not an FFmpeg input timeout - FFmpeg reading from a stdin pipe has none.
export const STREAM_HEALTH_TIMEOUT = 5000;

// RTCP-replay heartbeat cadence for {@link RtpDemuxer}, in milliseconds. On the two-way-audio backchannel, RtpDemuxer replays the last observed RTCP packet to the RTP
// destination port at this cadence whenever inbound RTCP stalls, keeping that input alive during legitimate quiet periods - see ffmpeg/rtp.ts, which owns the contract.
// 3000 ms leaves comfortable headroom for transient scheduling jitter without producing unnecessary traffic in healthy sessions where RTCP arrives more frequently than
// the cadence. Exported so plugin authors that pass this value verbatim document their intent at the call site, and so a future timeout adjustment propagates from one
// place to every consumer.
export const RTCP_HEARTBEAT_INTERVAL = 3000;

// Minimum GPU memory (in MB) a Raspberry Pi 4 must allocate via the legacy VideoCore gpu_mem split (read with `vcgencmd get_mem gpu`) to enable hardware acceleration;
// below this floor, decoding and transcoding fall back to software. This is the Pi 4 floor - we do not support anything earlier, and the Pi 5 (not a currently-supported
// target) uses a different memory model where the gpu_mem split does not apply. The hostSystem === "raspbian" detection does not distinguish Pi models, so adding Pi 5
// support would make this gate model-aware.
export const RPI4_GPU_MINIMUM = 128;

// The maximum source pixel count the Raspberry Pi 4 GPU hardware-transcode pipeline (h264_v4l2m2m) can ingest; a source above 1080p must be fed from a lower channel.
// This is the Pi 4 ceiling specifically - the Pi 5 (not a currently-supported target) has different GPU constraints. The hostSystem === "raspbian" detection does not
// distinguish Pi models, so this cap currently applies to every Raspberry Pi host, which is correct while the Pi 4 is the supported target; adding Pi 5 support would
// make this value model-aware. Distinct from RPI4_GPU_MINIMUM (GPU memory, in MB) - do not overload them.
export const RPI4_HW_TRANSCODE_MAX_PIXELS = 1920 * 1080;
