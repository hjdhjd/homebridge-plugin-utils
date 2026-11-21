/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/fmp4-builders.ts: Published ISO BMFF (fMP4) byte-level construction builders for the parser, assembler, and predicate test suites.
 */

/**
 * Shared ISO BMFF (fMP4) byte-level construction builders.
 *
 * The parser-aligned construction surface every consumer's tests build fragments and initialization segments on - the library's own parser, assembler, and predicate
 * suites and downstream plugins alike. Ships on the `homebridge-plugin-utils/testing` entry point alongside the other test doubles (`TestClock`,
 * `TestRecordingProcessFactory`) so a consumer composes real fMP4 bytes without hand-rolling box headers or re-deriving the wire layouts the predicates read.
 *
 * Construction layers, from primitive to fullbox builders to the composers over them:
 *
 * - {@link makeBox} - the primitive: header + payload. Every higher builder composes against this.
 * - {@link makeContainer} - a convenience wrapper that concatenates nested box bytes into a parent container (e.g., `makeContainer("moov", [ trak1, trak2 ])`).
 * - {@link makeHdlrBox} / {@link makeTkhdBox} / {@link makeMdhdBox} / {@link makeTfhdBox} / {@link makeTrunBox} - fullbox builders that encode the specific header
 *   layouts the `fmp4.ts` readers read (`hasAudioTrack` and `findVideoTrack` walk the handler-type field, and `findVideoTrack` reads a track's ID and timescale;
 *   `findKeyframe`, `isKeyframe` and `startsWithKeyframe` read each run's sample flags and the track fragment header's default flags, and `startsWithKeyframe` the
 *   durations ahead of the keyframe and the header's default duration; `splitVideoFrames` reads a track fragment's header and its run's entries). Routing every test
 *   through one parser-aligned construction path means a future tweak to any reader's wire layout has exactly one builder to update.
 * - {@link makeInitSegment} / {@link makeFragment} - composers that build a whole initialization segment from its tracks and a whole fragment from its samples,
 *   in the layout a stream's producer writes, so a suite feeding a reader or a feed a stream states its tracks and frames rather than assembling their boxes. A
 *   malformed segment or fragment, one no producer writes, is built from the fullbox builders directly.
 *
 * **Wire-format constants.** Every wire-format value these builders write lives in `fmp4.ts` (TRUN and TFHD flag bits, sample-flag bits, the handler-type codes),
 * because the production readers read each of them, and is imported here so the production reader and the construction path share one definition.
 *
 * @module
 */
import { BOX_HEADER_SIZE, TFHD_FLAG_BASE_DATA_OFFSET, TFHD_FLAG_DEFAULT_BASE_IS_MOOF, TFHD_FLAG_DEFAULT_SAMPLE_DURATION, TFHD_FLAG_DEFAULT_SAMPLE_FLAGS,
  TFHD_FLAG_DEFAULT_SAMPLE_SIZE, TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX, TRUN_FLAG_DATA_OFFSET, TRUN_FLAG_FIRST_SAMPLE_FLAGS, TRUN_FLAG_SAMPLE_COMPOSITION_OFFSET,
  TRUN_FLAG_SAMPLE_DURATION, TRUN_FLAG_SAMPLE_FLAGS, TRUN_FLAG_SAMPLE_SIZE } from "./fmp4.ts";
import type { FMp4Track } from "./fmp4.ts";
import assert from "node:assert/strict";

// Re-export the video handler-type code from `fmp4.ts`, where `findVideoTrack` reads it, so a suite building a video track reaches it on the testing entry point
// beside the builders that write it. The single source is `fmp4.ts`; this file is just a forwarding re-export.
export { HDLR_TYPE_VIDE } from "./fmp4.ts";

/**
 * Synthesize a minimal ISO BMFF box. Produces a Buffer whose first 4 bytes are the big-endian total size, the next 4 bytes are the 4-character ASCII `type`, and the
 * remainder is the supplied payload. Each test file wants the same construction helper to exercise different stream shapes; keeping it in one place eliminates drift
 * between the parser and assembler test suites.
 *
 * @param type     - The 4-character ASCII box type (`"ftyp"`, `"moov"`, `"moof"`, `"mdat"`, ...). Any other length fails the check.
 * @param payload  - Optional opaque payload bytes. Defaults to an empty buffer.
 *
 * @returns A complete box (header + payload) suitable for feeding to the parser or writing to an in-memory Readable fixture.
 *
 * @category Testing
 */
export function makeBox(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {

  assert.equal(type.length, 4, "box type must be exactly 4 ASCII characters");

  // The header width comes from BOX_HEADER_SIZE, the constant the production parser walks boxes with, so the construction path and the parser read one definition of it.
  const size = BOX_HEADER_SIZE + payload.length;
  const header = Buffer.alloc(BOX_HEADER_SIZE);

  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, "ascii");

  return Buffer.concat([ header, payload ]);
}

/**
 * Convenience wrapper that builds a container box from a sequence of already-constructed child boxes. The payload is just the concatenation of children, so the
 * result is equivalent to `makeBox(type, Buffer.concat(children))` - this helper's value is readability at the call site, where nested structures like
 * `moov -> [ trak -> [ mdia -> [ hdlr ] ] ]` become one-liners instead of a visual ladder of `Buffer.concat` calls.
 *
 * @param type     - The 4-character ASCII box type.
 * @param children - The pre-built child boxes to include as the container's payload.
 *
 * @returns A complete container box.
 *
 * @example
 *
 * ```ts
 * const hdlr = makeHdlrBox(HDLR_TYPE_SOUN);
 * const mdia = makeContainer("mdia", [hdlr]);
 * const trak = makeContainer("trak", [mdia]);
 * const moov = makeContainer("moov", [trak]);
 * ```
 *
 * @category Testing
 */
export function makeContainer(type: string, children: Buffer[]): Buffer {

  return makeBox(type, Buffer.concat(children));
}

/**
 * Build a `hdlr` fullbox with the supplied handler_type code. The fullbox layout (box header + version/flags + pre_defined + handler_type + reserved[3] + name) is
 * exactly what `hasAudioTrack` reads when deciding whether a track is audio. Tests compose an initialization segment by wrapping an hdlr inside `moov -> trak -> mdia`,
 * with the handler_type selecting the track media type under test.
 *
 * @param handlerType - The 32-bit big-endian handler type code. Use `HDLR_TYPE_SOUN` for audio, {@link HDLR_TYPE_VIDE} for video, or any other value to
 *                      exercise the "unknown handler" negative path.
 * @param truncate    - Optional. When `true`, emits an hdlr whose payload is smaller than the minimum `hasAudioTrack` reads (stops before the handler_type field). Used
 *                      by the "undersized hdlr" negative test; defaults to `false`.
 *
 * @returns A complete `hdlr` box.
 *
 * @category Testing
 */
export function makeHdlrBox(handlerType: number, truncate = false): Buffer {

  if(truncate) {

    // Intentionally short: version/flags (4) + pre_defined (4), no handler_type. The predicate's size guard (`hdlr.size >= (HDLR_TYPE_OFFSET + 4)`) must reject this.
    return makeBox("hdlr", Buffer.alloc(8));
  }

  // Standard hdlr payload: version/flags (4) + pre_defined (4) + handler_type (4) + reserved[3] (12) + empty name terminator (1).
  const payload = Buffer.alloc(25);

  payload.writeUInt32BE(handlerType, 8);

  return makeBox("hdlr", payload);
}

/**
 * Build a `tkhd` fullbox naming a track. Its creation and modification times, and its duration, are 32-bit in version 0 and 64-bit in version 1, so the track_ID
 * `findVideoTrack` reads sits at byte 20 of the box in version 0 and at byte 28 in version 1. Every other field is written as zero.
 *
 * @param options         - Options that shape the emitted box.
 * @param options.trackId - The track_ID to write.
 * @param options.version - The box version, `0` (the default) or `1`, which decides the width of the times and the duration.
 *
 * @returns A complete `tkhd` box.
 *
 * @category Testing
 */
export function makeTkhdBox({ trackId, version = 0 }: { trackId: number; version?: 0 | 1 }): Buffer {

  // Version/flags (4), creation and modification times (4 or 8 each), track_ID (4), reserved (4), duration (4 or 8), reserved (8), layer, alternate group, volume
  // and reserved (2 each), the matrix (36), and the width and height (4 each).
  const times = (version === 0) ? 4 : 8;
  const payload = Buffer.alloc(4 + (2 * times) + 4 + 4 + times + 8 + 8 + 36 + 8);

  payload.writeUInt8(version, 0);
  payload.writeUInt32BE(trackId, 4 + (2 * times));

  return makeBox("tkhd", payload);
}

/**
 * Build an `mdhd` fullbox stating a track's media timescale. Its creation and modification times, and its duration, are 32-bit in version 0 and 64-bit in version 1,
 * so the timescale `findVideoTrack` reads sits at byte 20 of the box in version 0 and at byte 28 in version 1. Every other field is written as zero.
 *
 * @param options           - Options that shape the emitted box.
 * @param options.timescale - The timescale to write, in ticks per second.
 * @param options.version   - The box version, `0` (the default) or `1`, which decides the width of the times and the duration.
 *
 * @returns A complete `mdhd` box.
 *
 * @category Testing
 */
export function makeMdhdBox({ timescale, version = 0 }: { timescale: number; version?: 0 | 1 }): Buffer {

  // Version/flags (4), creation and modification times (4 or 8 each), timescale (4), duration (4 or 8), language (2) and pre_defined (2).
  const times = (version === 0) ? 4 : 8;
  const payload = Buffer.alloc(4 + (2 * times) + 4 + times + 4);

  payload.writeUInt8(version, 0);
  payload.writeUInt32BE(timescale, 4 + (2 * times));

  return makeBox("mdhd", payload);
}

/**
 * Build a `tfhd` fullbox: a track fragment's header, naming its track and carrying any of the optional fields `splitVideoFrames` and `findKeyframe` read. Each
 * optional field given sets its flag and is written in the order the spec lays them out after the track_ID: the 64-bit base data offset, the sample description
 * index, and the default sample duration, size and flags. Default-base-is-moof is set unless asked otherwise, the layout FFmpeg's `default_base_moof` movflag writes.
 *
 * @param options                        - Options that shape the emitted box.
 * @param options.baseDataOffset         - When given, set `TFHD_FLAG_BASE_DATA_OFFSET` and write this 64-bit base data offset.
 * @param options.defaultBaseIsMoof      - When `true`, the default, set `TFHD_FLAG_DEFAULT_BASE_IS_MOOF`.
 * @param options.defaultSampleDuration  - When given, set `TFHD_FLAG_DEFAULT_SAMPLE_DURATION` and write this default sample duration.
 * @param options.defaultSampleFlags     - When given, set `TFHD_FLAG_DEFAULT_SAMPLE_FLAGS` and write these default sample flags.
 * @param options.defaultSampleSize      - When given, set `TFHD_FLAG_DEFAULT_SAMPLE_SIZE` and write this default sample size.
 * @param options.sampleDescriptionIndex - When given, set `TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX` and write this sample description index.
 * @param options.trackId                - The track_ID the header names.
 *
 * @returns A complete `tfhd` box.
 *
 * @category Testing
 */
export function makeTfhdBox({ baseDataOffset, defaultBaseIsMoof = true, defaultSampleDuration, defaultSampleFlags, defaultSampleSize, sampleDescriptionIndex,
  trackId }: {
  baseDataOffset?: number;
  defaultBaseIsMoof?: boolean;
  defaultSampleDuration?: number;
  defaultSampleFlags?: number;
  defaultSampleSize?: number;
  sampleDescriptionIndex?: number;
  trackId: number;
}): Buffer {

  const fields = [ [ TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX, sampleDescriptionIndex ], [ TFHD_FLAG_DEFAULT_SAMPLE_DURATION, defaultSampleDuration ],
    [ TFHD_FLAG_DEFAULT_SAMPLE_SIZE, defaultSampleSize ], [ TFHD_FLAG_DEFAULT_SAMPLE_FLAGS, defaultSampleFlags ] ] as const;
  const parts: Buffer[] = [];
  let flags = defaultBaseIsMoof ? TFHD_FLAG_DEFAULT_BASE_IS_MOOF : 0;

  // The base data offset is the one 64-bit field, and it comes first.
  if(baseDataOffset !== undefined) {

    const offset = Buffer.alloc(8);

    flags |= TFHD_FLAG_BASE_DATA_OFFSET;
    offset.writeBigUInt64BE(BigInt(baseDataOffset), 0);
    parts.push(offset);
  }

  for(const [ flag, value ] of fields) {

    if(value !== undefined) {

      const field = Buffer.alloc(4);

      flags |= flag;
      field.writeUInt32BE(value, 0);
      parts.push(field);
    }
  }

  const header = Buffer.alloc(8);

  // Version 0 in the top byte and the flags below it, then the track_ID.
  header.writeUInt32BE(flags & 0x00FFFFFF, 0);
  header.writeUInt32BE(trackId, 4);

  return makeBox("tfhd", Buffer.concat([ header, ...parts ]));
}

/**
 * One sample's entry in a `trun` built by {@link makeTrunBox}. Each field is written only when the run's flags say every entry carries it, and a field the run
 * carries but the sample omits is written as zero.
 *
 * @property compositionOffset - The sample's composition time offset, written signed.
 * @property duration          - The sample's duration, in the track's timescale.
 * @property flags             - The sample's flags.
 * @property size              - The sample's size, in bytes.
 *
 * @category Testing
 */
export interface TrunSample {

  readonly compositionOffset?: number;
  readonly duration?: number;
  readonly flags?: number;
  readonly size?: number;
}

/**
 * Build a `trun` fullbox. Without `samples` it describes a single sample, with the flags and sample-flags bits set to select where the run states that sample's
 * flags: `isKeyframe` reads a run's first sample from `first_sample_flags` when the run carries them (common path, when `frag_keyframe` movflag is set), from the
 * per-sample `sample_flags` field otherwise, and from the track fragment header's default when the run states neither. With `samples` it describes a run of any
 * length, one entry per sample, which is what `splitVideoFrames` and `findKeyframe` read. The helper composes the optional fields in the exact order the spec
 * mandates so the readers' offset arithmetic matches.
 *
 * @param options                          - Options that shape the emitted box.
 * @param options.dataOffset               - The value written, signed, into the data_offset field. Defaults to `0`.
 * @param options.includeCompositionOffset - When `true`, set `TRUN_FLAG_SAMPLE_COMPOSITION_OFFSET` and write each sample's composition offset as the last field of its
 *                                           entry. It shapes the entries written for `samples`, and without `samples` it sets the flag bit alone.
 * @param options.includeDataOffset        - When `true`, the default, set `TRUN_FLAG_DATA_OFFSET` and write the data_offset field after the sample count. `false` omits
 *                                           the flag and the field together, the shape of a run that does not say where its samples start.
 * @param options.includeDuration          - When `true`, set `TRUN_FLAG_SAMPLE_DURATION` and reserve a 4-byte per-sample duration slot before the flags slot.
 * @param options.includeSize              - When `true`, set `TRUN_FLAG_SAMPLE_SIZE` and reserve a 4-byte per-sample size slot before the flags slot.
 * @param options.sampleCount              - The sample count the run declares. Defaults to the number of `samples`, or `1` without them. A count above the entries
 *                                           written declares entries the box does not hold.
 * @param options.sampleFlagsValue         - The 32-bit value to write into the first_sample_flags field, and without `samples` into the per-sample flags field. Use
 *                                           `0`, the default, for a keyframe; use `SAMPLE_FLAG_NON_SYNC` for a non-keyframe.
 * @param options.samples                  - The run's entries, in order. Each entry holds, in this order, the duration when `includeDuration` is set, the size when
 *                                           `includeSize` is set, the flags when `usePerSampleFlags` is set and the composition offset when `includeCompositionOffset`
 *                                           is set. Omit it for the single-sample run the keyframe paths read.
 * @param options.truncate                 - Without `samples`, when `true`, emit a trun whose payload stops short of the flags field the predicate would read. Exercises
 *                                           the "insufficient bytes" guard inside `isKeyframe` without changing the declared box size.
 * @param options.useFirstSampleFlags      - When `true`, set `TRUN_FLAG_FIRST_SAMPLE_FLAGS` and emit the first-sample-flags field after the optional data_offset.
 * @param options.usePerSampleFlags        - When `true`, set `TRUN_FLAG_SAMPLE_FLAGS`. Without `samples`, emit a single per-sample flags field after any duration/size
 *                                           slots, regardless of `useFirstSampleFlags`; when `useFirstSampleFlags` is also `true`, `isKeyframe` never reads these
 *                                           trailing bytes, because `first_sample_flags` stands in for the first sample's entry flags and the run holds no other.
 *
 * @returns A complete `trun` box.
 *
 * @category Testing
 */
export function makeTrunBox({ dataOffset = 0, includeCompositionOffset = false, includeDataOffset = true, includeDuration = false, includeSize = false, sampleCount,
  sampleFlagsValue = 0, samples, truncate = false, useFirstSampleFlags = false, usePerSampleFlags = false }: {
  dataOffset?: number;
  includeCompositionOffset?: boolean;
  includeDataOffset?: boolean;
  includeDuration?: boolean;
  includeSize?: boolean;
  sampleCount?: number;
  sampleFlagsValue?: number;
  samples?: readonly TrunSample[];
  truncate?: boolean;
  useFirstSampleFlags?: boolean;
  usePerSampleFlags?: boolean;
}): Buffer {

  // Include the data_offset flag unless asked not to, so the parser walks past it - matches real-world FFmpeg output and exercises the offset-skip branch without a
  // dedicated test.
  let flags = includeDataOffset ? TRUN_FLAG_DATA_OFFSET : 0;

  if(useFirstSampleFlags) {

    flags |= TRUN_FLAG_FIRST_SAMPLE_FLAGS;
  }

  if(usePerSampleFlags) {

    flags |= TRUN_FLAG_SAMPLE_FLAGS;
  }

  if(includeDuration) {

    flags |= TRUN_FLAG_SAMPLE_DURATION;
  }

  if(includeSize) {

    flags |= TRUN_FLAG_SAMPLE_SIZE;
  }

  if(includeCompositionOffset) {

    flags |= TRUN_FLAG_SAMPLE_COMPOSITION_OFFSET;
  }

  // Compose the payload: version(0)/flags(3) + sample_count + optional data_offset + optional first_sample_flags + per-sample entries (duration?, size?, flags?,
  // composition offset?).
  const parts: Buffer[] = [];
  const header = Buffer.alloc(8);

  // Version 0 in the top byte, flags in the low 24 bits.
  header.writeUInt32BE(flags & 0x00FFFFFF, 0);
  header.writeUInt32BE(sampleCount ?? samples?.length ?? 1, 4);
  parts.push(header);

  // The data_offset slot, written signed because a run may point back before the moof's end.
  if(includeDataOffset) {

    const offset = Buffer.alloc(4);

    offset.writeInt32BE(dataOffset, 0);
    parts.push(offset);
  }

  if(useFirstSampleFlags) {

    const firstSampleFlags = Buffer.alloc(4);

    firstSampleFlags.writeUInt32BE(sampleFlagsValue, 0);
    parts.push(firstSampleFlags);
  }

  // A run of samples writes one entry per sample, each holding the fields the flags announce, in the order the spec fixes.
  if(samples) {

    for(const sample of samples) {

      const fields = [ [ includeDuration, sample.duration ], [ includeSize, sample.size ], [ usePerSampleFlags, sample.flags ],
        [ includeCompositionOffset, sample.compositionOffset ] ] as const;

      for(const [ present, value ] of fields) {

        if(present) {

          const field = Buffer.alloc(4);

          // The unsigned shift writes a negative composition offset as its two's complement, which is how a signed field reads it back.
          field.writeUInt32BE((value ?? 0) >>> 0, 0);
          parts.push(field);
        }
      }
    }

    return makeBox("trun", Buffer.concat(parts));
  }

  // Per-sample entry. When useFirstSampleFlags is true, first_sample_flags stands in for the single sample's entry flags, so the keyframe readers consult no
  // per-sample field and we stop here unless per-sample was explicitly requested.
  if(usePerSampleFlags) {

    if(includeDuration) {

      parts.push(Buffer.alloc(4));
    }

    if(includeSize) {

      parts.push(Buffer.alloc(4));
    }

    if(!truncate) {

      const perSampleFlags = Buffer.alloc(4);

      perSampleFlags.writeUInt32BE(sampleFlagsValue, 0);
      parts.push(perSampleFlags);
    }
  }

  return makeBox("trun", Buffer.concat(parts));
}

/**
 * One track of an initialization segment built by {@link makeInitSegment}: its ID and timescale, as {@link ffmpeg/fmp4!FMp4Track | FMp4Track} holds them, its
 * media handler, and the version each of its `tkhd` and `mdhd` is written at. A box's version decides the width of its times and duration, and a producer chooses it
 * for each box on its own.
 *
 * @property handler     - The track's handler-type code, such as {@link HDLR_TYPE_VIDE} for video or `HDLR_TYPE_SOUN` for audio.
 * @property mdhdVersion - The version of the track's `mdhd`, `0` (the default) or `1`.
 * @property tkhdVersion - The version of the track's `tkhd`, `0` (the default) or `1`.
 *
 * @category Testing
 */
export interface InitSegmentTrack extends FMp4Track {

  readonly handler: number;
  readonly mdhdVersion?: 0 | 1;
  readonly tkhdVersion?: 0 | 1;
}

/**
 * Build an initialization segment from its tracks: an `ftyp`, then a `moov` holding an `mvhd` and a `trak` for each track in the order given, each `trak` holding
 * the track's `tkhd` and an `mdia` with its `mdhd` and `hdlr`. These are the boxes `findVideoTrack` and `hasAudioTrack` walk, and past the fields they read and
 * the file type's brands, every field is written as zero.
 *
 * @param tracks - The segment's tracks, in order.
 *
 * @returns A complete initialization segment.
 *
 * @example
 *
 * ```ts
 * const header = makeInitSegment([ { handler: HDLR_TYPE_VIDE, id: 1, timescale: 90000 }, { handler: HDLR_TYPE_SOUN, id: 2, timescale: 48000 } ]);
 * ```
 *
 * @category Testing
 */
export function makeInitSegment(tracks: readonly InitSegmentTrack[]): Buffer {

  const traks = tracks.map(({ handler, id, mdhdVersion, timescale, tkhdVersion }) => makeContainer("trak", [ makeTkhdBox({ trackId: id, version: tkhdVersion }),
    makeContainer("mdia", [ makeMdhdBox({ timescale, version: mdhdVersion }), makeHdlrBox(handler) ]) ]));

  // The file type names its major brand, a minor version of zero and its compatible brands. The movie header is a version 0 box of zeros, which no reader here reads.
  return Buffer.concat([ makeBox("ftyp", Buffer.concat([ Buffer.from("iso5"), Buffer.alloc(4), Buffer.from("iso5mp41") ])),
    makeContainer("moov", [ makeBox("mvhd", Buffer.alloc(100)), ...traks ]) ]);
}

/**
 * Build an fMP4 fragment in the layout the family's producers write: a `moof` holding an `mfhd` and the track fragment of `trackId`, then that of `secondTrack`
 * when one is given, and one `mdat` holding the first track's samples and then the second's. Each track fragment holds a `tfhd` naming its track, a `tfdt` and one
 * `trun` whose data offset is measured from the start of the `moof` to the track's first sample. Each sample is written into the `mdat` as `size` bytes of zeros,
 * whether or not its run carries the size.
 *
 * The first track's fragment is the one a test shapes: its header's defaults and flags, the fields its run's entries carry, and its data offset. The second track's
 * header sets default-base-is-moof alone, and its run's entries carry each sample's duration and size.
 *
 * @param options                     - Options that shape the emitted fragment.
 * @param options.dataOffset          - The first track's data offset as written, in place of the position of its first sample, for a fragment whose run points
 *                                      somewhere other than its samples.
 * @param options.header              - The first track's `tfhd` options, as {@link makeTfhdBox} takes them, without the track_ID. Defaults to default-base-is-moof
 *                                      alone.
 * @param options.run                 - Which fields the first track's `trun` carries, and the value its first-sample flags hold, as {@link makeTrunBox} takes
 *                                      them. Defaults to each sample's duration and size in its entry and a first-sample-flags field marking a keyframe; a run
 *                                      given replaces that default whole, and the first-sample flags it carries mark a keyframe unless it picks a `sampleFlagsValue`.
 * @param options.samples             - The first track's samples, in order. Each is written to the `mdat` as its `size`, and to the run's entries as far as `run`
 *                                      says.
 * @param options.secondTrack         - A second track whose fragment and samples follow the first's.
 * @param options.secondTrack.samples - The second track's samples, in order, each written to the `mdat` as its `size` and to the run's entries with its duration
 *                                      and size.
 * @param options.secondTrack.trackId - The track_ID of the second track.
 * @param options.trackId             - The track_ID of the first track.
 *
 * @returns A complete fragment, its `moof` followed by its `mdat`.
 *
 * @example
 *
 * ```ts
 * // A fragment of video frames, then the audio samples that play alongside them.
 * const fragment = makeFragment({ samples: [ { duration: 3000, size: 40 }, { duration: 3000, size: 12 }, { duration: 3000, size: 18 } ],
 *   secondTrack: { samples: [ { duration: 1920, size: 7 } ], trackId: 2 }, trackId: 1 });
 * ```
 *
 * @category Testing
 */
export function makeFragment({ dataOffset, header = {}, run = { includeDuration: true, includeSize: true, useFirstSampleFlags: true }, samples, secondTrack,
  trackId }: {
  dataOffset?: number;
  header?: Omit<Parameters<typeof makeTfhdBox>[0], "trackId">;
  run?: Pick<Parameters<typeof makeTrunBox>[0], "includeCompositionOffset" | "includeDataOffset" | "includeDuration" | "includeSize" | "sampleFlagsValue" |
    "useFirstSampleFlags" | "usePerSampleFlags">;
  samples: readonly TrunSample[];
  secondTrack?: { samples: readonly TrunSample[]; trackId: number };
  trackId: number;
}): Buffer {

  const bytesOf = (trackSamples: readonly TrunSample[]): Buffer => Buffer.concat(trackSamples.map(({ size = 0 }) => Buffer.alloc(size)));
  const firstBytes = bytesOf(samples);
  const secondBytes = bytesOf(secondTrack?.samples ?? []);

  // Every data offset is a fixed-width field, so the moof's length does not depend on the offsets written into it, and one sizing pass places every sample.
  const moofOf = (firstSample: number): Buffer => makeContainer("moof", [

    makeBox("mfhd", Buffer.alloc(8)),
    makeContainer("traf", [ makeTfhdBox({ ...header, trackId }), makeBox("tfdt", Buffer.alloc(8)),
      makeTrunBox({ ...run, dataOffset: dataOffset ?? firstSample, samples }) ]),
    ...(secondTrack ? [makeContainer("traf", [ makeTfhdBox({ trackId: secondTrack.trackId }), makeBox("tfdt", Buffer.alloc(8)),
      makeTrunBox({ dataOffset: firstSample + firstBytes.length, includeDuration: true, includeSize: true, samples: secondTrack.samples }) ])] : [])
  ]);

  // The first track's first sample sits just past the mdat's header.
  const firstSample = moofOf(0).length + BOX_HEADER_SIZE;

  return Buffer.concat([ moofOf(firstSample), makeBox("mdat", Buffer.concat([ firstBytes, secondBytes ])) ]);
}
