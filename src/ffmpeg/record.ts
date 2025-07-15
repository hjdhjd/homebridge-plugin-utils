/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/record.ts: Provide FFmpeg process control to support livestreaming and HomeKit Secure Video.
 */

/**
 * FFmpeg process management for HomeKit Secure Video (HKSV) events and fMP4 livestreaming.
 *
 * This module defines classes for orchestrating FFmpeg processes that produce fMP4 segments suitable for HomeKit Secure Video and realtime livestreaming scenarios. It
 * handles process lifecycle, segment buffering, initialization segment detection, and streaming event generation, abstracting away the complexity of interacting directly
 * with FFmpeg for these workflows.
 *
 * Key features:
 *
 * - Automated setup and management of FFmpeg processes for HKSV event recording and livestreaming (with support for audio and video).
 * - Parsing and generation of fMP4 boxes/segments for HomeKit, including initialization and media segments.
 * - Async generator APIs for efficient, event-driven segment handling.
 * - Flexible error handling and timeouts for HomeKit’s strict realtime requirements.
 * - Designed for Homebridge plugin authors or advanced users who need robust, platform-aware FFmpeg session control for HomeKit and related integrations.
 *
 * @module
 */
import { AudioRecordingCodecType, AudioRecordingSamplerate, type CameraRecordingConfiguration } from "homebridge";
import { HKSV_IDR_INTERVAL, HKSV_TIMEOUT } from "./settings.js";
import { type Nullable, type PartialWithId, runWithTimeout } from "../util.js";
import type { FfmpegOptions } from "./options.js";
import { FfmpegProcess } from "./process.js";
import events from "node:events";
import { once } from "node:events";

/**
 * Base options for configuring an fMP4 recording or livestream session. These options aren't used directly but are inherited and used by it's descendents.
 *
 * @property audioStream          - Audio stream input to use, if the input contains multiple audio streams. Defaults to `0` (the first audio stream).
 * @property codec                - The codec for the input video stream. Valid values are `av1`, `h264`, and `hevc`. Defaults to `h264`.
 * @property enableAudio          - Indicates whether to enable audio or not.
 * @property hardwareTranscoding  - Enable hardware-accelerated video transcoding if available. Defaults to what was specified in `ffmpegOptions`.
 * @property videoStream          - Video stream input to use, if the input contains multiple video streams. Defaults to `0` (the first video stream).
 */
export interface FMp4BaseOptions {

  audioStream: number;
  codec: string;
  enableAudio: boolean;
  hardwareTranscoding: boolean;
  videoStream: number;
}

/**
 * Options for configuring an fMP4 recording or livestream session.
 *
 * @property fps             - The video frames per second for the session.
 * @property probesize       - Number of bytes to analyze for stream information.
 * @property timeshift       - Timeshift offset for event-based recording (in milliseconds).
 * @property transcodeAudio  - Transcode audio to AAC. This can be set to false if the audio stream is already in AAC. Defaults to `true`.
 */
export interface FMp4RecordingOptions extends FMp4BaseOptions {

  fps: number;
  probesize: number;
  timeshift: number;
  transcodeAudio: boolean;
}

/**
 * Options for configuring an fMP4 recording or livestream session.
 *
 * @property url          - Source URL for livestream (RTSP) remuxing to fMP4.
 */
export interface FMp4LivestreamOptions extends FMp4BaseOptions {

  url: string;
}

// Utility to map HKSV audio recording profiles to FFmpeg profile strings. We also use satisfies here to ensure we account for any future changes that would require
// updating this mapping.
const translateAudioRecordingCodecType = {

  [ AudioRecordingCodecType.AAC_ELD ]:   "38",
  [ AudioRecordingCodecType.AAC_LC ]:    "1"
} as const satisfies Record<AudioRecordingCodecType, string>;

// Utility to map audio sample rates to strings. We also use satisfies here to ensure we account for any future changes that would require updating this mapping.
const translateAudioSampleRate = {

  [ AudioRecordingSamplerate.KHZ_8 ]:    "8",
  [ AudioRecordingSamplerate.KHZ_16 ]:   "16",
  [ AudioRecordingSamplerate.KHZ_24 ]:   "24",
  [ AudioRecordingSamplerate.KHZ_32 ]:   "32",
  [ AudioRecordingSamplerate.KHZ_44_1 ]: "44.1",
  [ AudioRecordingSamplerate.KHZ_48 ]:   "48"
} as const satisfies Record<AudioRecordingSamplerate, string>;

/**
 * FFmpeg process controller for HomeKit Secure Video (HKSV) and fMP4 livestreaming and recording.
 *
 * This class manages the lifecycle and parsing of an FFmpeg process to support HKSV and livestreaming in fMP4 format. It handles initialization segments, media segment
 * parsing, buffering, and HomeKit segment generation, and emits events for segment and initialization.
 *
 * @example
 *
 * ```ts
 * // Create a new recording process for an HKSV event.
 * const process = new FfmpegRecordingProcess(ffmpegOptions, recordingConfig, 30, true, 5000000, 0);
 *
 * // Start the process.
 * process.start();
 *
 * // Iterate over generated segments.
 * for await(const segment of process.segmentGenerator()) {
 *
 *   // Send segment to HomeKit, etc.
 * }
 *
 * // Stop when finished.
 * process.stop();
 * ```
 *
 * @see FfmpegOptions
 * @see FfmpegProcess
 * @see {@link https://ffmpeg.org/ffmpeg.html | FFmpeg Documentation}
 */
class FfmpegFMp4Process extends FfmpegProcess {

  private hasInitSegment: boolean;
  private _initSegment: Buffer;
  private isLivestream: boolean;
  private isLoggingErrors: boolean;
  public isTimedOut: boolean;
  private recordingBuffer: { data: Buffer, header: Buffer, length: number, type: string }[];
  public segmentLength?: number;

  /**
   * Constructs a new fMP4 FFmpeg process for HKSV event recording or livestreaming.
   *
   * @param ffmpegOptions     - FFmpeg configuration options.
   * @param recordingConfig   - HomeKit recording configuration for the session.
   * @param isAudioActive     - If `true`, enables audio stream processing.
   * @param fMp4Options       - Configuration for the fMP4 session (fps, type, url, etc.).
   * @param isVerbose         - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   *
   * @example
   *
   * ```ts
   * const process = new FfmpegFMp4Process(ffmpegOptions, recordingConfig, true, { fps: 30 });
   * ```
   */
  constructor(ffmpegOptions: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, fMp4Options: Partial<FMp4LivestreamOptions & FMp4RecordingOptions> = {},
    isVerbose = false) {

    // Initialize our parent.
    super(ffmpegOptions);

    // We want to log errors when they occur.
    this.isLoggingErrors = true;

    // Initialize our recording buffer.
    this.hasInitSegment = false;
    this._initSegment = Buffer.alloc(0);
    this.recordingBuffer = [];

    // Initialize our state.
    this.isLivestream = !!fMp4Options.url;
    this.isTimedOut = false;
    fMp4Options.audioStream ??= 0;
    fMp4Options.codec ??= "h264";
    fMp4Options.enableAudio ??= true;
    fMp4Options.fps ??= 30;
    fMp4Options.hardwareTranscoding ??= this.options.config.hardwareTranscoding;
    fMp4Options.transcodeAudio ??= true;
    fMp4Options.videoStream ??= 0;

    // Configure our video parameters for our input:
    //
    // -hide_banner                  Suppress printing the startup banner in FFmpeg.
    // -nostats                      Suppress printing progress reports while encoding in FFmpeg.
    // -fflags flags                 Set the format flags to discard any corrupt packets rather than exit, generate a presentation timestamp if it's missing, and ignore
    //                               the decoding timestamp. Adjusting timestamps is a necessity if we want to ensure we keep audio and video in sync, especially when
    //                               using hardware acceleration.
    // -err_detect ignore_err        Ignore decoding errors and continue rather than exit.
    // -max_delay 500000             Set an upper limit on how much time FFmpeg can take in demuxing packets, in microseconds.
    this.commandLineArgs = [

      "-hide_banner",
      "-nostats",
      "-fflags", "+discardcorrupt+genpts+igndts",
      "-err_detect", "ignore_err",
      "-max_delay", "500000"
    ];

    if(this.isLivestream && fMp4Options.url) {

      // -avioflags direct           Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
      // -rtsp_transport tcp         Tell the RTSP stream handler that we're looking for a TCP connection.
      // -i url            RTSPS URL to get our input stream from.
      this.commandLineArgs.push(

        "-avioflags", "direct",
        "-rtsp_transport", "tcp",
        "-i", fMp4Options.url
      );
    } else {

      // -flags low_delay              Tell FFmpeg to optimize for low delay / realtime decoding.
      // -r fps                        Set the input frame rate for the video stream.
      // -probesize number             How many bytes should be analyzed for stream information.
      // -f mp4                        Tell FFmpeg that it should expect an MP4-encoded input stream.
      // -i pipe:0                     Use standard input to get video data.
      // -ss                           Fast forward to where HKSV is expecting us to be for a recording event.
      this.commandLineArgs.push(

        "-flags", "low_delay",
        "-r", fMp4Options.fps.toString(),
        "-probesize", (fMp4Options.probesize ?? 5000000).toString(),
        "-f", "mp4",
        "-i", "pipe:0",
        "-ss", (fMp4Options.timeshift ?? 0).toString() + "ms"
      );
    }

    // Configure our recording options for the video stream:
    //
    // -map 0:v:X                    Selects the video track from the input.
    this.commandLineArgs.push(

      "-map", "0:v:" + fMp4Options.videoStream.toString(),
      ...(this.isLivestream ? [ "-codec:v", "copy" ] : this.options.recordEncoder({

        bitrate: recordingConfig.videoCodec.parameters.bitRate,
        fps: recordingConfig.videoCodec.resolution[2],
        hardwareDecoding: false,
        hardwareTranscoding: fMp4Options.hardwareTranscoding,
        height: recordingConfig.videoCodec.resolution[1],
        idrInterval: HKSV_IDR_INTERVAL,
        inputFps: fMp4Options.fps,
        level: recordingConfig.videoCodec.parameters.level,
        profile: recordingConfig.videoCodec.parameters.profile,
        width: recordingConfig.videoCodec.resolution[0]
      }))
    );

    // If we're livestreaming, emit fragments at one-second intervals.
    if(this.isLivestream) {

      // -frag_duration number       Length of each fMP4 fragment, in microseconds.
      this.commandLineArgs.push("-frag_duration", "1000000");
    }

    // -movflags flags               In the generated fMP4 stream: set the default-base-is-moof flag in the header, write an initial empty MOOV box, start a new fragment
    //                               at each keyframe, skip creating a segment index (SIDX) box in fragments, and skip writing the final MOOV trailer since it's unneeded.
    // -reset_timestamps             Reset timestamps at the beginning of each segment.
    // -metadata                     Set the metadata to the name of the camera to distinguish between FFmpeg sessions.
    this.commandLineArgs.push(

      "-movflags", "default_base_moof+empty_moov+frag_keyframe+skip_sidx+skip_trailer",
      "-reset_timestamps", "1",
      "-metadata", "comment=" + this.options.name() + " " + (this.isLivestream ? "Livestream Buffer" : "HKSV Event")
    );

    if(fMp4Options.enableAudio) {

      // Configure the audio portion of the command line. Options we use are:
      //
      // -map 0:a:X?                 Selects the audio stream from the input, if it exists.
      this.commandLineArgs.push("-map", "0:a:" + fMp4Options.audioStream.toString() + "?");

      if(fMp4Options.transcodeAudio) {

        // Configure the audio portion of the command line. Options we use are:
        //
        // -codec:a                    Encode using the codecs available to us on given platforms.
        // -profile:a                  Specify either low-complexity AAC or enhanced low-delay AAC for HKSV events.
        // -ar samplerate              Sample rate to use for this audio. This is specified by HKSV.
        // -ac number                  Set the number of audio channels.
        this.commandLineArgs.push(

          ...this.options.audioEncoder({ codec: recordingConfig.audioCodec.type }),
          "-profile:a", translateAudioRecordingCodecType[recordingConfig.audioCodec.type],
          "-ar", translateAudioSampleRate[recordingConfig.audioCodec.samplerate as AudioRecordingSamplerate] + "k",
          "-ac", (recordingConfig.audioCodec.audioChannels ?? 1).toString()
        );
      } else {

        // Configure the audio portion of the command line. Options we use are:
        //
        // -codec:a copy               Copy the audio stream, since it's already in AAC.
        this.commandLineArgs.push("-codec:a", "copy");
      }
    }

    // Configure our video parameters for outputting our final stream:
    //
    // -f mp4                        Tell ffmpeg that it should create an MP4-encoded output stream.
    // -avioflags direct             Tell FFmpeg to minimize buffering to reduce latency for more realtime processing.
    // pipe:1                        Output the stream to standard output.
    this.commandLineArgs.push(

      "-f", "mp4",
      "-avioflags", "direct",
      "pipe:1");

    // Additional logging, but only if we're debugging.
    if(isVerbose || this.isVerbose) {

      this.commandLineArgs.unshift("-loglevel", "level+verbose");
    }
  }

  /**
   * Prepares and configures the FFmpeg process for reading and parsing output fMP4 data.
   *
   * This method is called internally by the process lifecycle and is not typically invoked directly by consumers.
   */
  protected configureProcess(): void {

    let dataListener: (buffer: Buffer) => void;

    // Call our parent to get started.
    super.configureProcess();

    // Initialize our variables that we need to process incoming FFmpeg packets.
    let header = Buffer.alloc(0);
    let bufferRemaining = Buffer.alloc(0);
    let dataLength = 0;
    let type = "";

    // Process FFmpeg output and parse out the fMP4 stream it's generating for HomeKit Secure Video.
    this.process?.stdout.on("data", dataListener = (buffer: Buffer): void => {

      // If we have anything left from the last buffer we processed, prepend it to this buffer.
      if(bufferRemaining.length > 0) {

        buffer = Buffer.concat([bufferRemaining, buffer]);
        bufferRemaining = Buffer.alloc(0);
      }

      let offset = 0;

      // FFmpeg is outputting an fMP4 stream that's suitable for HomeKit Secure Video. However, we can't just pass this stream directly back to HomeKit since we're using
      // a generator-based API to send packets back to HKSV. Here, we take on the task of parsing the fMP4 stream that's being generated and split it up into the MP4
      // boxes that HAP-NodeJS is ultimately expecting.
      for(;;) {

        let data;

        // The MP4 container format is well-documented and designed around the concept of boxes. A box (or atom as they used to be called) is at the center of an MP4
        // container. It's composed of an 8-byte header, followed by the data payload it carries.

        // No existing header, let's start a new box.
        if(!header.length) {

          // Grab the header. The first four bytes represents the length of the entire box. Second four bytes represent the box type.
          header = buffer.subarray(0, 8);

          // Now we retrieve the length of the box.
          dataLength = header.readUInt32BE(0);

          // Get the type of the box. This is always a string and has a funky history to it that makes for an interesting read!
          type = header.subarray(4).toString();

          // Finally, we get the data portion of the box.
          data = buffer.subarray(8, dataLength);

          // Mark our data offset so we account for the length of the data header and subtract it from the overall length to capture just the data portion.
          dataLength -= offset = 8;
        } else {

          // Grab the data from our buffer.
          data = buffer.subarray(0, dataLength);
          offset = 0;
        }

        // If we don't have enough data in this buffer, save what we have for the next buffer we see and append it there.
        if(data.length < dataLength) {

          bufferRemaining = data;

          break;
        }

        // If we're creating a livestream to be consumed by the timeshift buffer, we need to track the initialization segment, and emit segments.
        if(this.isLivestream) {

          // If this is part of the initialization segment, store it for future use.
          if(!this.hasInitSegment) {

            // The initialization segment is everything before the first moof box. Once we've seen a moof box, we know we've captured it in full.
            if(type === "moof") {

              this.hasInitSegment = true;
              this.emit("initsegment");
            } else {

              this._initSegment = Buffer.concat([this._initSegment, header, data]);
            }
          }

          if(this.hasInitSegment) {

            // We only emit segments once we have the initialization segment.
            this.emit("segment", Buffer.concat([ header, data ]));
          }
        } else {

          // Add it to our queue to be eventually pushed out through our generator function.
          this.recordingBuffer.push({ data: data, header: header, length: dataLength, type: type });
          this.emit("mp4box");
        }

        // Prepare to start a new box for the next buffer that we will be processing.
        data = Buffer.alloc(0);
        header = Buffer.alloc(0);
        type = "";

        // We've parsed an entire box, and there's no more data in this buffer to parse.
        if(buffer.length === (offset + dataLength)) {

          dataLength = 0;

          break;
        }

        // If there's anything left in the buffer, move us to the new box and let's keep iterating.
        buffer = buffer.subarray(offset + dataLength);
        dataLength = 0;
      }
    });

    // Make sure we cleanup our listeners when we're done.
    this.process?.once("exit", () => {

      this.process?.stdout?.off("data", dataListener);
    });
  }

  /**
   * Retrieves the fMP4 initialization segment generated by FFmpeg.
   *
   * Waits until the initialization segment is available, then returns it.
   *
   * @returns A promise resolving to the initialization segment as a Buffer.
   *
   * @example
   *
   * ```ts
   * const initSegment = await process.getInitSegment();
   * ```
   */
  protected async getInitSegment(): Promise<Buffer> {

    // If we have the initialization segment, return it.
    if(this.hasInitSegment) {

      return this._initSegment;
    }

    // Wait until the initialization segment is seen and then try again.
    await events.once(this, "initsegment");

    return this.getInitSegment();
  }

  /**
   * Stops the FFmpeg process and performs cleanup, including emitting termination events for segment generators.
   *
   * This is called as part of the process shutdown sequence.
   */
  protected stopProcess(): void {

    // Call our parent to get started.
    super.stopProcess();

    // Ensure that we clear out of our segment generator by guaranteeing an exit path.
    this.isEnded = true;
    this.emit("mp4box");
    this.emit("close");
  }

  /**
   * Starts the FFmpeg process, adjusting segment length for livestreams if set.
   *
   * @example
   *
   * ```ts
   * process.start();
   * ```
   */
  public start(): void {

    if(this.isLivestream && (this.segmentLength !== undefined)) {

      const fragIndex = this.commandLineArgs.indexOf("-frag_duration");

      if(fragIndex !== -1) {

        this.commandLineArgs[fragIndex + 1] = (this.segmentLength * 1000).toString();
      }
    }

    // Start the FFmpeg session.
    super.start();
  }

  /**
   * Stops the FFmpeg process and logs errors if specified.
   *
   * @param logErrors - If `true`, logs FFmpeg errors. Defaults to the internal process logging state.
   *
   * @example
   *
   * ```ts
   * process.stop();
   * ```
   */
  public stop(logErrors = this.isLoggingErrors): void {

    const savedLogErrors = this.isLoggingErrors;

    // Flag whether we should log abnormal exits (e.g. being killed) or not.
    this.isLoggingErrors = logErrors;

    // Call our parent to finish the job.
    super.stop();

    // Restore our previous logging state.
    this.isLoggingErrors = savedLogErrors;
  }

  /**
   * Logs errors from FFmpeg process execution, handling known benign HKSV stream errors gracefully.
   *
   * @param exitCode - The exit code from the FFmpeg process.
   * @param signal   - The signal (if any) used to terminate the process.
   */
  protected logFfmpegError(exitCode: number, signal: NodeJS.Signals): void {

    // If we're ignoring errors, we're done.
    if(!this.isLoggingErrors) {

      return;
    }

    // Known HKSV-related errors due to occasional inconsistencies that are occasionally produced by the input stream and FFmpeg's own occasional quirkiness.
    const ffmpegKnownHksvError = new RegExp([

      "(Cannot determine format of input stream 0:0 after EOF)",
      "(Could not write header \\(incorrect codec parameters \\?\\): Broken pipe)",
      "(Could not write header for output file #0)",
      "(Error closing file: Broken pipe)",
      "(Error splitting the input into NAL units\\.)",
      "(Invalid data found when processing input)",
      "(moov atom not found)"
    ].join("|"));

    // See if we know about this error.
    if(this.stderrLog.some(x => ffmpegKnownHksvError.test(x))) {

      this.log.error("FFmpeg ended unexpectedly due to issues processing the media stream. This error can be safely ignored - it will occur occasionally.");

      return;
    }

    // Otherwise, revert to our default logging in our parent.
    super.logFfmpegError(exitCode, signal);
  }

  /**
   * Asynchronously generates complete segments from FFmpeg output, formatted for HomeKit Secure Video.
   *
   * This async generator yields fMP4 segments as Buffers, or ends on process termination or timeout.
   *
   * @yields A Buffer containing a complete MP4 segment suitable for HomeKit.
   *
   * @example
   *
   * ```ts
   * for await(const segment of process.segmentGenerator()) {
   *
   *   // Process each segment for HomeKit.
   * }
   * ```
   */
  public async *segmentGenerator(): AsyncGenerator<Buffer> {

    let segment: Buffer[] = [];

    // Loop forever, generating either FTYP/MOOV box pairs or MOOF/MDAT box pairs for HomeKit Secure Video.
    for(;;) {

      // FFmpeg has finished it's output - we're done.
      if(this.isEnded) {

        return;
      }

      // If the buffer is empty, wait for our FFmpeg process to produce more boxes.
      if(!this.recordingBuffer.length) {

        // Segments are output by FFmpeg according to our specified IDR interval. If we don't see a segment within the timeframe we need for HKSV's timing requirements,
        // we flag it accordingly and return null back to the generator that's calling us.
        // eslint-disable-next-line no-await-in-loop
        await runWithTimeout(once(this, "mp4box"), HKSV_TIMEOUT);
      }

      // Grab the next fMP4 box from our buffer.
      const box = this.recordingBuffer.shift();

      // FFmpeg hasn't produced any output. Given the time-sensitive nature of HKSV that constrains us to no more than 5 seconds to provide the next segment, we're done.
      if(!box) {

        this.isTimedOut = true;

        return;
      }

      // Queue up this fMP4 box to send back to HomeKit.
      segment.push(box.header, box.data);

      // What we want to send are two types of complete segments, made up of multiple MP4 boxes:
      //
      // - a complete MOOV box, usually with an accompanying FTYP box, that's sent at the very beginning of any valid fMP4 stream. HomeKit Secure Video looks for this
      //   before anything else.
      //
      // - a complete MOOF/MDAT pair. MOOF describes the sample locations and their sizes and MDAT contains the actual audio and video data related to that segment. Think
      //   of MOOF as the audio/video data "header", and MDAT as the "payload".
      //
      // Once we see these, we combine all the segments in our queue to send back to HomeKit.
      if((box.type === "moov") || (box.type === "mdat")) {

        yield Buffer.concat(segment);
        segment = [];
      }
    }
  }

  /**
   * Returns the initialization segment as a Buffer, or null if not yet available.
   *
   * @returns The initialization segment Buffer, or `null` if not yet generated.
   *
   * @example
   *
   * ```ts
   * const init = process.initSegment;
   * if(init) {
   *
   *   // Use the initialization segment.
   * }
   * ```
   */
  public get initSegment(): Nullable<Buffer> {

    if(!this.hasInitSegment) {

      return null;
    }

    return this._initSegment;
  }
}

/**
 * Manages a HomeKit Secure Video recording FFmpeg process.
 *
 * @example
 *
 * ```ts
 * const process = new FfmpegRecordingProcess(ffmpegOptions, recordingConfig, 30, true, 5000000, 0);
 * process.start();
 * ```
 *
 * @see FfmpegFMp4Process
 *
 * @category FFmpeg
 */
export class FfmpegRecordingProcess extends FfmpegFMp4Process {

  /**
   * Constructs a new FFmpeg recording process for HKSV events.
   *
   * @param options          - FFmpeg configuration options.
   * @param recordingConfig  - HomeKit recording configuration for the session.
   * @param fMp4Options      - fMP4 recording options.
   * @param isVerbose        - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   */
  constructor(options: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, fMp4Options: Partial<FMp4RecordingOptions> = {}, isVerbose = false) {

    super(options, recordingConfig, fMp4Options, isVerbose);
  }
}

/**
 * Manages a HomeKit livestream FFmpeg process for generating fMP4 segments.
 *
 * @example
 *
 * ```ts
 * const process = new FfmpegLivestreamProcess(ffmpegOptions, recordingConfig, url, 30, true);
 * process.start();
 *
 * const initSegment = await process.getInitSegment();
 * ```
 *
 * @see FfmpegFMp4Process
 *
 * @category FFmpeg
 */
export class FfmpegLivestreamProcess extends FfmpegFMp4Process {

  /**
   * Constructs a new FFmpeg livestream process.
   *
   * @param options            - FFmpeg configuration options.
   * @param recordingConfig    - HomeKit recording configuration for the session.
   * @param livestreamOptions  - livestream segmenting options.
   * @param isVerbose          - If `true`, enables more verbose logging for debugging purposes. Defaults to `false`.
   */
  constructor(options: FfmpegOptions, recordingConfig: CameraRecordingConfiguration, livestreamOptions: PartialWithId<FMp4LivestreamOptions, "url">, isVerbose = false) {

    super(options, recordingConfig, livestreamOptions, isVerbose);
  }

  /**
   * Gets the fMP4 initialization segment generated by FFmpeg for the livestream.
   *
   * @returns A promise resolving to the initialization segment as a Buffer.
   *
   * @example
   *
   * ```ts
   * const initSegment = await process.getInitSegment();
   * ```
   */
  public async getInitSegment(): Promise<Buffer> {

    return super.getInitSegment();
  }
}
