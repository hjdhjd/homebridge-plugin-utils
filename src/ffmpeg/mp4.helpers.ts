/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/mp4.helpers.ts: Shared ISO BMFF byte-level construction helpers for tests that exercise the fMP4 parser, assembler, and static predicates.
 */

/**
 * Shared test helpers for ISO BMFF (fMP4) byte-level tests.
 *
 * Co-located with the modules under test so changes to the construction surface land next to the code that depends on them. Files matching `*.helpers.ts` are excluded
 * from the build emit (see `tsconfig.build.json`) so nothing from this module ships in the published package.
 *
 * Construction layers, from primitive to fullbox builders:
 *
 * - {@link makeBox} - the primitive: header + payload. Every higher helper composes against this.
 * - {@link makeContainer} - a convenience wrapper that concatenates nested box bytes into a parent container (e.g., `makeContainer("moov", [ trak1, trak2 ])`).
 * - {@link makeHdlrBox} / {@link makeTrunBox} - fullbox builders that encode the specific header layouts the `fmp4.ts` predicates read (`hasAudioTrack` walks the
 *   handler-type field; `isKeyframe` walks TRUN flags). Keeping these here means every test file that needs them goes through one parser-aligned construction path, so
 *   a future tweak to either predicate's wire layout has exactly one helper to update.
 *
 * **Wire-format constants.** Anything the production parser reads lives in `fmp4.ts` (TRUN flag bits, sample-flag bits, the audio handler-type code) and is imported
 * here so the production reader and the test-construction path share one definition. Test-only values that production never consumes - currently the video
 * handler-type code, used as a negative-path handler for `hasAudioTrack` - live in this module as locally-scoped exports, which keeps the production surface to
 * exactly what production needs.
 *
 * @module
 */
import { HDLR_TYPE_SOUN, SAMPLE_FLAG_NON_SYNC, TRUN_FLAG_DATA_OFFSET, TRUN_FLAG_FIRST_SAMPLE_FLAGS, TRUN_FLAG_SAMPLE_DURATION, TRUN_FLAG_SAMPLE_FLAGS,
  TRUN_FLAG_SAMPLE_SIZE } from "./fmp4.ts";
import assert from "node:assert/strict";

// Re-export the production constants the helpers consume so test files can import from `mp4.helpers.ts` alone as their one-stop shop for ISO BMFF byte construction.
// These values live in `fmp4.ts`; the re-export is a navigation convenience, not a second source.
export { HDLR_TYPE_SOUN, SAMPLE_FLAG_NON_SYNC };

/**
 * Handler-type code for video tracks in ISO BMFF `hdlr` boxes: ASCII `"vide"` encoded as a 32-bit big-endian integer. Defined here rather than in `fmp4.ts` because
 * production never inspects it - `hasAudioTrack` compares each track's handler_type against {@link HDLR_TYPE_SOUN} and any non-match (including `"vide"`) is treated
 * uniformly as "not audio." Tests need a concrete non-audio value to exercise the negative path of that predicate, so the constant lives with the test helpers.
 */
export const HDLR_TYPE_VIDE = 0x76696465;

/**
 * Synthesize a minimal ISO BMFF box. Produces a Buffer whose first 4 bytes are the big-endian total size, the next 4 bytes are the 4-character ASCII `type`, and the
 * remainder is the supplied payload. Each test file wants the same construction helper to exercise different stream shapes; keeping it in one place eliminates drift
 * between the parser and assembler test suites.
 *
 * @param type     - The 4-character ASCII box type (`"ftyp"`, `"moov"`, `"moof"`, `"mdat"`, ...). Any other length fails the check.
 * @param payload  - Optional opaque payload bytes. Defaults to an empty buffer.
 *
 * @returns A complete box (header + payload) suitable for feeding to the parser or writing to an in-memory Readable fixture.
 */
export function makeBox(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {

  assert.equal(type.length, 4, "box type must be exactly 4 ASCII characters");

  const size = 8 + payload.length;
  const header = Buffer.alloc(8);

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
 */
export function makeContainer(type: string, children: Buffer[]): Buffer {

  return makeBox(type, Buffer.concat(children));
}

/**
 * Build a `hdlr` fullbox with the supplied handler_type code. The fullbox layout (box header + version/flags + pre_defined + handler_type + reserved[3] + name) is
 * exactly what `hasAudioTrack` reads when deciding whether a track is audio. Tests compose an initialization segment by wrapping an hdlr inside `moov -> trak -> mdia`,
 * with the handler_type selecting the track media type under test.
 *
 * @param handlerType - The 32-bit big-endian handler type code. Use {@link HDLR_TYPE_SOUN} for audio, {@link HDLR_TYPE_VIDE} for video, or any other value to
 *                      exercise the "unknown handler" negative path.
 * @param truncate    - Optional. When `true`, emits an hdlr whose payload is smaller than the minimum `hasAudioTrack` reads (stops before the handler_type field). Used
 *                      by the "undersized hdlr" negative test; defaults to `false`.
 *
 * @returns A complete `hdlr` box.
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
 * Build a `trun` fullbox describing a single sample, with the flags and sample-flags bits set to select one of the keyframe-detection paths `isKeyframe` supports.
 * `isKeyframe` reads the flags to decide whether to consult `first_sample_flags` (common path, when `frag_keyframe` movflag is set) or fall back to the per-sample
 * `sample_flags` field. The helper composes the optional fields in the exact order the spec mandates so the predicate's offset arithmetic matches.
 *
 * @param options                   - Options that shape the emitted box.
 * @param options.useFirstSampleFlags - When `true`, set `TRUN_FLAG_FIRST_SAMPLE_FLAGS` and emit the first-sample-flags field after the optional data_offset.
 * @param options.usePerSampleFlags - When `true`, set `TRUN_FLAG_SAMPLE_FLAGS` and emit a single per-sample flags field after any duration/size slots. Ignored when
 *                                    `useFirstSampleFlags` is also `true` because the predicate consults first_sample_flags first.
 * @param options.includeDuration   - When `true`, set `TRUN_FLAG_SAMPLE_DURATION` and reserve a 4-byte per-sample duration slot before the flags slot.
 * @param options.includeSize       - When `true`, set `TRUN_FLAG_SAMPLE_SIZE` and reserve a 4-byte per-sample size slot before the flags slot.
 * @param options.sampleFlagsValue  - The 32-bit value to write into the chosen flags field (first_sample_flags or per-sample flags). Use `0` for a keyframe; use
 *                                    {@link SAMPLE_FLAG_NON_SYNC} for a non-keyframe.
 * @param options.truncate          - When `true`, emit a trun whose payload stops short of the flags field the predicate would read. Exercises the "insufficient bytes"
 *                                    guard inside `isKeyframe` without changing the declared box size.
 *
 * @returns A complete `trun` box.
 */
export function makeTrunBox(options: {
  includeDuration?: boolean;
  includeSize?: boolean;
  sampleFlagsValue: number;
  truncate?: boolean;
  useFirstSampleFlags?: boolean;
  usePerSampleFlags?: boolean;
}): Buffer {

  const { includeDuration = false, includeSize = false, sampleFlagsValue, truncate = false, useFirstSampleFlags = false, usePerSampleFlags = false } = options;

  // Always include the data_offset flag so the parser walks past it - matches real-world FFmpeg output and exercises the offset-skip branch without a dedicated test.
  let flags = TRUN_FLAG_DATA_OFFSET;

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

  // Compose the payload: version(0)/flags(3) + sample_count + data_offset + optional first_sample_flags + per-sample entries (duration?, size?, flags?).
  const parts: Buffer[] = [];
  const header = Buffer.alloc(8);

  // Version 0 in the top byte, flags in the low 24 bits.
  header.writeUInt32BE(flags & 0x00FFFFFF, 0);
  // sample_count = 1.
  header.writeUInt32BE(1, 4);
  parts.push(header);

  // data_offset slot (value irrelevant; the predicate skips past it).
  parts.push(Buffer.alloc(4));

  if(useFirstSampleFlags) {

    const firstSampleFlags = Buffer.alloc(4);

    firstSampleFlags.writeUInt32BE(sampleFlagsValue, 0);
    parts.push(firstSampleFlags);
  }

  // Per-sample entry. When useFirstSampleFlags is true, the predicate returns early before consulting per-sample fields, so we stop here unless per-sample was
  // explicitly requested.
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
