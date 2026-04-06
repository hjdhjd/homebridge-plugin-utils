/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/fmp4.ts: ISO BMFF (fMP4) box parsing utilities.
 */

/**
 * ISO BMFF (fMP4) box parsing utilities for working with fragmented MP4 data.
 *
 * This module provides lightweight, Buffer-based utilities for inspecting ISO Base Media File Format (ISO BMFF) structures commonly found in fragmented MP4 (fMP4)
 * streams. It enables locating specific box types, splitting fragments into their moof/mdat components, detecting keyframe (sync sample) segments by parsing the TRUN
 * sample flags, and identifying audio track presence in initialization segments.
 *
 * These utilities operate on complete Buffers and are independent of FFmpeg processes or streaming pipelines.
 *
 * @module
 */
import type { Nullable } from "../util.js";

/**
 * ISO BMFF box header size in bytes: 4 bytes big-endian size + 4 bytes ASCII type.
 *
 * @category FFmpeg
 */
export const BOX_HEADER_SIZE = 8;

// TRUN fullbox header size: standard box header + 4 bytes version/flags + 4 bytes sample_count.
const TRUN_HEADER_SIZE = BOX_HEADER_SIZE + 8;

// TRUN box flags indicating the presence of optional fields.
const TRUN_FLAG_DATA_OFFSET = 0x000001;
const TRUN_FLAG_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_FLAG_SAMPLE_DURATION = 0x000100;
const TRUN_FLAG_SAMPLE_SIZE = 0x000200;
const TRUN_FLAG_SAMPLE_FLAGS = 0x000400;

// Sample flags bit indicating a non-sync sample. When this bit is clear (0), the sample is a sync sample (keyframe/IDR).
const SAMPLE_FLAG_NON_SYNC = 0x00010000;

// Handler type for audio tracks in ISO BMFF: "soun" encoded as a 32-bit integer.
const HDLR_TYPE_SOUN = 0x736F756E;

// Offset from the start of an hdlr fullbox to the handler_type field: standard box header (8 bytes) + version/flags (4 bytes) + pre_defined (4 bytes).
const HDLR_TYPE_OFFSET = BOX_HEADER_SIZE + 8;

/**
 * Describes the location of an ISO BMFF box within a buffer.
 *
 * @property offset    - The byte offset of the box start (including the header).
 * @property size      - The total box size in bytes (including the header).
 *
 * @category FFmpeg
 */
export interface FMp4Box {

  offset: number;
  size: number;
}

/**
 * Locates the first ISO BMFF box of a given type within a byte range.
 *
 * Walks the standard box headers (4-byte big-endian size + 4-byte ASCII type) starting at `start` and ending at `end`. Returns the offset and size of the first
 * matching box, or `null` if no match is found. Does not handle extended-size boxes (64-bit size field) as these are uncommon in fMP4 livestream contexts.
 *
 * @param buffer       - The buffer containing ISO BMFF box data.
 * @param type         - The 4-character ASCII box type to search for (e.g. "moof", "traf", "trun"). Must be exactly 4 characters.
 * @param start        - Optional. The byte offset to begin searching from. Defaults to 0.
 * @param end          - Optional. The byte offset to stop searching at. Defaults to the buffer length.
 *
 * @returns The box location, or `null` if not found.
 *
 * @category FFmpeg
 */
export function findBox(buffer: Buffer, type: string, start = 0, end?: number): Nullable<FMp4Box> {

  const limit = end ?? buffer.length;

  // Encode the target type as a 32-bit integer for comparison, avoiding string allocation on every box visited. Box types in ISO BMFF are always exactly 4 ASCII bytes.
  if(type.length !== 4) {

    return null;
  }

  const target = ((type.charCodeAt(0) << 24) | (type.charCodeAt(1) << 16) | (type.charCodeAt(2) << 8) | type.charCodeAt(3)) >>> 0;
  let offset = start;

  // Walk boxes by reading each header: 4 bytes size (big-endian) + 4 bytes type.
  while((offset + BOX_HEADER_SIZE) <= limit) {

    const size = buffer.readUInt32BE(offset);

    // A valid box must be at least the header size and must not extend beyond the search range. Size values below the header size indicate corruption, misalignment,
    // extended-size boxes (size === 1), or open-ended boxes (size === 0) - none of which are supported in this context.
    if((size < BOX_HEADER_SIZE) || (size > (limit - offset))) {

      return null;
    }

    // Compare the box type as a 32-bit integer to avoid allocating a string on every iteration.
    if(buffer.readUInt32BE(offset + 4) === target) {

      return { offset, size };
    }

    // Advance to the next box.
    offset += size;
  }

  return null;
}

/**
 * Determines whether an fMP4 segment contains a keyframe (sync sample) by parsing the TRUN sample flags.
 *
 * Traverses the box hierarchy `moof -> traf -> trun` and inspects the sample flags to determine if the first sample is a sync sample (keyframe/IDR frame). Checks
 * `first_sample_flags` first (the common case for fragments generated with `frag_keyframe`), then falls back to per-sample flags if available. Returns `false` if the
 * box structure cannot be parsed or if the flags indicate a non-sync sample.
 *
 * @param segment      - A buffer containing a complete fMP4 segment (typically a moof+mdat pair).
 *
 * @returns `true` if the segment's first sample is a sync sample (keyframe), `false` otherwise.
 *
 * @category FFmpeg
 */
export function isKeyframe(segment: Buffer): boolean {

  // Locate the moof box at the top level.
  const moof = findBox(segment, "moof");

  if(!moof) {

    return false;
  }

  // Locate the traf box inside the moof. Child boxes start after the parent's header.
  const traf = findBox(segment, "traf", moof.offset + BOX_HEADER_SIZE, moof.offset + moof.size);

  if(!traf) {

    return false;
  }

  // Locate the trun box inside the traf.
  const trun = findBox(segment, "trun", traf.offset + BOX_HEADER_SIZE, traf.offset + traf.size);

  if(!trun) {

    return false;
  }

  // The trun is a fullbox: after the standard box header come 4 bytes of version/flags and 4 bytes of sample_count. We need the full header to read the flags and
  // determine which optional fields follow.
  if(trun.size < TRUN_HEADER_SIZE) {

    return false;
  }

  // Read the flags from the fullbox header. The version occupies the top byte and the flags occupy the lower 24 bits.
  const flags = segment.readUInt32BE(trun.offset + BOX_HEADER_SIZE) & 0x00FFFFFF;

  // Start after the trun header (box header + version/flags + sample_count).
  let pos = trun.offset + TRUN_HEADER_SIZE;

  // Skip the optional data_offset field if present.
  if(flags & TRUN_FLAG_DATA_OFFSET) {

    pos += 4;
  }

  // Check first_sample_flags if present. This is the most common path for fMP4 fragments generated with the frag_keyframe movflag, where each fragment starts at a
  // keyframe and the first sample's flags are stored separately from the per-sample entries.
  if(flags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) {

    if((pos + 4) > (trun.offset + trun.size)) {

      return false;
    }

    return (segment.readUInt32BE(pos) & SAMPLE_FLAG_NON_SYNC) === 0;
  }

  // Fall back to per-sample flags. The per-sample entry fields appear in a fixed order: duration, size, flags, composition time offset. We skip duration and size to
  // reach the first sample's flags field.
  if(flags & TRUN_FLAG_SAMPLE_FLAGS) {

    if(flags & TRUN_FLAG_SAMPLE_DURATION) {

      pos += 4;
    }

    if(flags & TRUN_FLAG_SAMPLE_SIZE) {

      pos += 4;
    }

    if((pos + 4) > (trun.offset + trun.size)) {

      return false;
    }

    return (segment.readUInt32BE(pos) & SAMPLE_FLAG_NON_SYNC) === 0;
  }

  // No sample flags information available in the trun...we can't determine keyframe status.
  return false;
}

/**
 * Determines whether an fMP4 initialization segment contains an audio track by inspecting the handler type in each track's media handler box.
 *
 * Traverses the box hierarchy `moov -> trak -> mdia -> hdlr` for every track in the init segment and checks the handler_type field for "soun" (0x736F756E). This is the
 * standard ISO BMFF mechanism for identifying track media types - "soun" for audio, "vide" for video, "subt" for subtitles, etc.
 *
 * @param initSegment   - A buffer containing a complete fMP4 initialization segment (typically ftyp + moov).
 *
 * @returns `true` if the init segment contains at least one audio track, `false` otherwise.
 *
 * @category FFmpeg
 */
export function hasAudioTrack(initSegment: Buffer): boolean {

  // Locate the moov box at the top level.
  const moov = findBox(initSegment, "moov");

  if(!moov) {

    return false;
  }

  const moovStart = moov.offset + BOX_HEADER_SIZE;
  const moovEnd = moov.offset + moov.size;

  // Walk each trak box inside the moov. After finding one, search for the next starting after it.
  let trakStart = moovStart;

  for(;;) {

    const trak = findBox(initSegment, "trak", trakStart, moovEnd);

    if(!trak) {

      return false;
    }

    // Locate the mdia box inside this trak.
    const mdia = findBox(initSegment, "mdia", trak.offset + BOX_HEADER_SIZE, trak.offset + trak.size);

    if(mdia) {

      // Locate the hdlr box inside the mdia.
      const hdlr = findBox(initSegment, "hdlr", mdia.offset + BOX_HEADER_SIZE, mdia.offset + mdia.size);

      // Read the handler_type field. In a hdlr fullbox, the layout after the standard box header is: version/flags (4 bytes) + pre_defined (4 bytes) + handler_type
      // (4 bytes). We check that the box is large enough to contain the field before reading.
      if(hdlr && (hdlr.size >= (HDLR_TYPE_OFFSET + 4))) {

        if(initSegment.readUInt32BE(hdlr.offset + HDLR_TYPE_OFFSET) === HDLR_TYPE_SOUN) {

          return true;
        }
      }
    }

    // Advance past this trak to search for the next one.
    trakStart = trak.offset + trak.size;
  }
}

/**
 * Splits an fMP4 fragment into its moof and mdat components.
 *
 * Locates the `mdat` box and returns everything before it as the moof portion (which includes the moof box and any preceding metadata boxes) and everything from the
 * mdat box to the end of the fragment as the mdat portion. The returned buffers are subarray views into the original buffer, so no data is copied. Returns `null` if
 * the mdat box cannot be found.
 *
 * @param fragment     - A buffer containing a complete fMP4 fragment.
 *
 * @returns An object with `moof` and `mdat` sub-buffers, or `null` if the structure cannot be parsed.
 *
 * @category FFmpeg
 */
export function splitMoofMdat(fragment: Buffer): Nullable<{ mdat: Buffer; moof: Buffer }> {

  const mdat = findBox(fragment, "mdat");

  if(!mdat) {

    return null;
  }

  return { mdat: fragment.subarray(mdat.offset), moof: fragment.subarray(0, mdat.offset) };
}
