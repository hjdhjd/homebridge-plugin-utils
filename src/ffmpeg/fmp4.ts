/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/fmp4.ts: ISO BMFF (fMP4) box parsing utilities.
 */

/**
 * ISO BMFF (fMP4) box parsing utilities for working with fragmented MP4 data.
 *
 * This module provides lightweight, Buffer-based utilities for inspecting ISO Base Media File Format (ISO BMFF) structures commonly found in fragmented MP4 (fMP4)
 * streams. It enables locating specific box types, splitting fragments into their moof/mdat components, finding a fragment's first keyframe (sync sample) from its
 * samples' flags and whether a decoder can take the fragment from its first byte, identifying audio track presence in initialization segments, finding an
 * initialization segment's video track, and cutting a fragment into pieces that each end where one of that track's frames ends, with the frame's duration, for a
 * paced write.
 *
 * These utilities operate on complete Buffers and are independent of FFmpeg processes or streaming pipelines.
 *
 * @module
 */
import type { Nullable } from "../util.ts";
import type { PacedChunk } from "../backpressure.ts";

/**
 * ISO BMFF box header size in bytes: 4 bytes big-endian size + 4 bytes ASCII type.
 *
 * @category FFmpeg
 */
export const BOX_HEADER_SIZE = 8;

// TRUN fullbox header size: standard box header + 4 bytes version/flags + 4 bytes sample_count.
const TRUN_HEADER_SIZE = BOX_HEADER_SIZE + 8;

// TFHD fullbox header size: the standard box header, then the version/flags word and the track_ID.
const TFHD_HEADER_SIZE = BOX_HEADER_SIZE + 8;

/**
 * TRUN fullbox flags bit indicating that a `data_offset` field follows the sample_count in the box header.
 *
 * @category FFmpeg
 */
export const TRUN_FLAG_DATA_OFFSET = 0x000001;

/**
 * TRUN fullbox flags bit indicating that a `first_sample_flags` field follows (after `data_offset` if present). When this flag is set, the first sample's flags are
 * stored in a dedicated header field rather than in the per-sample entries - the common arrangement for fragments emitted with FFmpeg's `frag_keyframe` movflag.
 *
 * @category FFmpeg
 */
export const TRUN_FLAG_FIRST_SAMPLE_FLAGS = 0x000004;

/**
 * TRUN fullbox flags bit indicating that each sample entry carries a 4-byte duration field.
 *
 * @category FFmpeg
 */
export const TRUN_FLAG_SAMPLE_DURATION = 0x000100;

/**
 * TRUN fullbox flags bit indicating that each sample entry carries a 4-byte size field.
 *
 * @category FFmpeg
 */
export const TRUN_FLAG_SAMPLE_SIZE = 0x000200;

/**
 * TRUN fullbox flags bit indicating that each sample entry carries a 4-byte sample_flags field.
 *
 * @category FFmpeg
 */
export const TRUN_FLAG_SAMPLE_FLAGS = 0x000400;

/**
 * TRUN fullbox flags bit indicating that each sample entry carries a 4-byte composition time offset, the last field of the entry.
 *
 * @category FFmpeg
 */
export const TRUN_FLAG_SAMPLE_COMPOSITION_OFFSET = 0x000800;

/**
 * TFHD fullbox flags bit indicating that a 64-bit `base_data_offset` field follows the track_ID, so the track fragment's data offsets are measured from that
 * position rather than from the moof.
 *
 * @category FFmpeg
 */
export const TFHD_FLAG_BASE_DATA_OFFSET = 0x000001;

/**
 * TFHD fullbox flags bit indicating that a 4-byte `sample_description_index` field follows, after the base data offset if present.
 *
 * @category FFmpeg
 */
export const TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX = 0x000002;

/**
 * TFHD fullbox flags bit indicating that a 4-byte `default_sample_duration` field follows, the duration of every sample whose TRUN entry carries none.
 *
 * @category FFmpeg
 */
export const TFHD_FLAG_DEFAULT_SAMPLE_DURATION = 0x000008;

/**
 * TFHD fullbox flags bit indicating that a 4-byte `default_sample_size` field follows, the size of every sample whose TRUN entry carries none.
 *
 * @category FFmpeg
 */
export const TFHD_FLAG_DEFAULT_SAMPLE_SIZE = 0x000010;

/**
 * TFHD fullbox flags bit indicating that a 4-byte `default_sample_flags` field follows, the flags of every sample whose TRUN entry carries none.
 *
 * @category FFmpeg
 */
export const TFHD_FLAG_DEFAULT_SAMPLE_FLAGS = 0x000020;

/**
 * TFHD fullbox flags bit indicating that the track fragment's data offsets are measured from the start of its moof, the layout FFmpeg's `default_base_moof` movflag
 * writes.
 *
 * @category FFmpeg
 */
export const TFHD_FLAG_DEFAULT_BASE_IS_MOOF = 0x020000;

/**
 * Sample-flags bit indicating a non-sync (non-keyframe) sample. When this bit is clear (0), the sample is a sync sample / IDR frame / keyframe.
 *
 * @category FFmpeg
 */
export const SAMPLE_FLAG_NON_SYNC = 0x00010000;

/**
 * Handler-type code for audio tracks in ISO BMFF `hdlr` boxes: ASCII `"soun"` encoded as a 32-bit big-endian integer. Compared against the `handler_type` field of
 * each track's `hdlr` fullbox to identify the audio track during init-segment inspection.
 *
 * @category FFmpeg
 */
export const HDLR_TYPE_SOUN = 0x736F756E;

/**
 * Handler-type code for video tracks in ISO BMFF `hdlr` boxes: ASCII `"vide"` encoded as a 32-bit big-endian integer. Compared against the `handler_type` field of
 * each track's `hdlr` fullbox to find the video track during init-segment inspection.
 *
 * @category FFmpeg
 */
export const HDLR_TYPE_VIDE = 0x76696465;

// Offset from the start of an hdlr fullbox to the handler_type field: standard box header (8 bytes) + version/flags (4 bytes) + pre_defined (4 bytes).
const HDLR_TYPE_OFFSET = BOX_HEADER_SIZE + 8;

// The per-sample fields a TRUN entry can carry, in the order the spec lays them out within the entry. An entry holds exactly the ones its run's flags set, so the
// stride of an entry and the offset of each field within it are each read from this one list.
const TRUN_ENTRY_FIELDS = [ TRUN_FLAG_SAMPLE_DURATION, TRUN_FLAG_SAMPLE_SIZE, TRUN_FLAG_SAMPLE_FLAGS, TRUN_FLAG_SAMPLE_COMPOSITION_OFFSET ] as const;

// The optional fields that follow a TFHD's track_ID, each with its width in bytes, in the order the spec lays them out. A header holds exactly the ones its flags
// set, so each field's position is read by walking this one list.
const TFHD_FIELDS = [ [ TFHD_FLAG_BASE_DATA_OFFSET, 8 ], [ TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX, 4 ], [ TFHD_FLAG_DEFAULT_SAMPLE_DURATION, 4 ],
  [ TFHD_FLAG_DEFAULT_SAMPLE_SIZE, 4 ], [ TFHD_FLAG_DEFAULT_SAMPLE_FLAGS, 4 ] ] as const;

/**
 * Describes the location of an ISO BMFF box within a buffer.
 *
 * @property offset    - The byte offset of the box start (including the header).
 * @property size      - The total box size in bytes (including the header).
 *
 * @category FFmpeg
 */
export interface FMp4Box {

  readonly offset: number;
  readonly size: number;
}

/**
 * A track of an fMP4 stream as {@link findVideoTrack} reads it from an initialization segment: what a track fragment names it by, and the unit its durations are in.
 *
 * @property id        - The track's `track_ID`, which each of its track fragments names in its `tfhd`.
 * @property timescale - The track's media timescale, the number of duration ticks in one second.
 *
 * @category FFmpeg
 */
export interface FMp4Track {

  readonly id: number;
  readonly timescale: number;
}

// Where a TRUN's fields sit, as positions in the buffer that holds it, read from its fixed header alone. A field the run's flags omit is null. No bound past the fixed
// header is checked here: each reader of a run checks the fields it reads against the box, so a run is read exactly as far as its reader needs.
interface TrackRunLayout {

  readonly dataOffset: Nullable<number>;
  readonly firstEntry: number;
  readonly firstSampleFlags: Nullable<number>;
  readonly flags: number;
  readonly sampleCount: number;
  readonly stride: number;
}

/**
 * Locates the first ISO BMFF box of a given type within a byte range.
 *
 * Walks the standard box headers (4-byte big-endian size + 4-byte ASCII type) starting at `start` and ending at `end`. Returns the offset and size of the first
 * matching box. Returns `null` when no box of the requested type is found in range, and also when the walk encounters a box whose declared size is invalid - below
 * the header size, extending past the search range, or an extended/open-ended size (64-bit size field, uncommon in fMP4 livestream contexts and unsupported here) -
 * since a malformed size makes it unsafe to keep walking; every rejection reason collapses to the same null return, so callers cannot distinguish which one
 * occurred from the return value alone.
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
 * Finds the first keyframe (sync sample) in an fMP4 fragment, as its index among the samples of the track fragment it reads.
 *
 * Reads the first `moof`'s track fragment whose `tfhd` names `track`, or the moof's first track fragment when no track is given, and walks every `trun` in it in
 * order, counting samples across them, to the first sample whose flags clear the non-sync bit. A sample's flags are read where the fragment states them: the first
 * sample of a run takes the run's first-sample flags, else its entry's flags, else the `tfhd`'s default sample flags, and every later sample takes its entry's flags,
 * else that default. A sample whose flags are stated nowhere, as in a track fragment with no `tfhd`, is no keyframe. The default is read only for a sample whose
 * flags its run does not state, and only from a `tfhd` that holds its track_ID and every field its flags announce; a default only the initialization segment
 * states, in its `trex`, is not read.
 *
 * The first run's first-sample flags, or its first entry's, are read even when it declares no samples, so the fragment's first sample answers from what it states
 * alone. A run that declares no samples adds nothing to the index, and past the first run it holds no keyframe.
 *
 * A caller handing a decoder the fragment as its first asks {@link startsWithKeyframe} rather than comparing this index with zero, because samples of no duration
 * can stand ahead of a keyframe that a decoder still shows first.
 *
 * @remarks **Hot path.** A plugin reads every fragment of a live stream through this, so the walk allocates nothing per sample and stops at the first keyframe. A
 * run whose entries carry no flags is answered in one step, because every sample after its first takes the same default, so a run that declares billions of
 * samples it does not list costs no more than one that declares two. A run whose entries do carry flags is read one entry at a time, never past its box.
 *
 * @param segment - A buffer containing a complete fMP4 fragment (typically a moof followed by its mdat). No `mdat` is read.
 * @param track   - Optional. The track whose track fragment to read, typically the video track {@link findVideoTrack} read from the stream's initialization
 *                  segment. Without it, the moof's first track fragment is read.
 *
 * @returns The zero-based index of the first keyframe among the track fragment's samples, or `null` when it holds none: when the segment has no `moof`, when no track
 *          fragment names `track` (or, without one, the moof holds none), when every sample's flags mark it non-sync or are stated nowhere, or when the walk reaches
 *          a run too short for its fixed header or a flags field that lies past its run's box before it finds a keyframe.
 *
 * @category FFmpeg
 */
export function findKeyframe(segment: Buffer, track?: FMp4Track): Nullable<number> {

  // The track fragment every keyframe reader reads. Its header is read for a default only if a sample's flags turn out to need one, so without a track a fragment
  // whose runs state their flags costs no header lookup. With a track, choosing the track fragment reads each header's track_ID.
  const traf = findKeyframeTrackFragment(segment, track);

  if(!traf) {

    return null;
  }

  const trafEnd = traf.offset + traf.size;
  let defaultFlags: number | undefined;
  let index = 0;

  for(let first = true, trunStart = traf.offset + BOX_HEADER_SIZE; ; first = false) {

    const trun = findBox(segment, "trun", trunStart, trafEnd);
    const run = trun && readTrackRun(segment, trun);

    // The walk ends with no keyframe past the last run, and at a run too short to say how many samples it holds, since no sample after it can be counted.
    if(!trun || !run) {

      return null;
    }

    const trunEnd = trun.offset + trun.size;
    const flagsAt = (run.flags & TRUN_FLAG_SAMPLE_FLAGS) ? entryFieldOffset(run.flags, TRUN_FLAG_SAMPLE_FLAGS) : null;
    let sample = 0;

    // The first sample's flags where the run states them, its first-sample flags ahead of its first entry's. The first run's are read whatever count it declares and
    // bounded by their own field alone, so the fragment's first sample answers from what it states even when the run's count or entries do not hold together.
    const firstEntryFlags = (flagsAt === null) ? null : (run.firstEntry + flagsAt);
    const stated = (first || (run.sampleCount > 0)) ? (run.firstSampleFlags ?? firstEntryFlags) : null;

    if(stated !== null) {

      if((stated + 4) > trunEnd) {

        return null;
      }

      if(isSyncSample(segment.readUInt32BE(stated))) {

        return index;
      }

      sample = 1;
    }

    if(flagsAt !== null) {

      // Each later sample states its flags in its entry, read one entry at a time, and an entry the box does not hold ends the walk.
      for(let position = run.firstEntry + (sample * run.stride) + flagsAt; sample < run.sampleCount; position += run.stride, sample++) {

        if((position + 4) > trunEnd) {

          return null;
        }

        if(isSyncSample(segment.readUInt32BE(position))) {

          return index + sample;
        }
      }
    } else if(run.sampleCount > sample) {

      // The run's entries state no flags, so every sample from here to its end takes the header's default, and the first of them answers for them all. The default is
      // read once, by the first run that needs it, and a header that states none marks no keyframe.
      defaultFlags ??= readKeyframeHeader(segment, traf)?.defaultFlags ?? SAMPLE_FLAG_NON_SYNC;

      if(isSyncSample(defaultFlags)) {

        return index + sample;
      }
    }

    index += run.sampleCount;
    trunStart = trunEnd;
  }
}

/**
 * Determines whether an fMP4 fragment holds a keyframe (sync sample) anywhere in the track fragment it reads: {@link findKeyframe}'s answer compared with `null`.
 *
 * A producer that cuts its fragments by time rather than at keyframes leaves a keyframe wherever the cut falls, often after the first sample, so every sample of
 * every run counts, each read as {@link findKeyframe} reads it.
 *
 * A caller handing a decoder the fragment as its first asks {@link startsWithKeyframe} instead, because a keyframe somewhere in the fragment is not always the first
 * sample a decoder shows.
 *
 * @param segment - A buffer containing a complete fMP4 fragment (typically a moof followed by its mdat).
 * @param track   - Optional. The track whose track fragment to read, as {@link findKeyframe} takes it. Without it, the moof's first track fragment is read.
 *
 * @returns `true` if the track fragment holds a sync sample (keyframe), `false` otherwise.
 *
 * @category FFmpeg
 */
export function isKeyframe(segment: Buffer, track?: FMp4Track): boolean {

  return findKeyframe(segment, track) !== null;
}

/**
 * Determines whether an fMP4 fragment starts with a keyframe (sync sample): whether a decoder handed the fragment as its first, from its first byte, shows a
 * keyframe first.
 *
 * Answers from {@link findKeyframe}: a keyframe that is the first sample starts the fragment, and a keyframe at a later index does when every sample ahead of it,
 * in the track fragment {@link findKeyframe} reads, states a duration of zero. A sample of zero duration takes no time on the track's timeline, so the keyframe
 * behind it is the first picture the fragment presents, and some packagers put the parameter sets in such a sample, flagged non-sync, ahead of each keyframe. A
 * sample's duration is read where the fragment states it: its entry's when its run carries per-sample durations, else the `tfhd`'s default sample duration, read
 * only from a `tfhd` that holds its track_ID and every field its flags announce. A duration stated nowhere is not zero, and a default only the initialization
 * segment states, in its `trex`, is not read.
 *
 * Each keyframe reader answers its own question: this one whether a decoder can be handed the fragment as its first, {@link isKeyframe} whether the fragment holds a
 * keyframe anywhere, and {@link findKeyframe} where the keyframe sits.
 *
 * @remarks A run whose entries carry no durations is answered in one step from the default, and a run whose entries do carry them is read one entry at a time,
 * never past its box, so the walk is bounded by the bytes the fragment holds whatever count a run declares.
 *
 * @param segment - A buffer containing a complete fMP4 fragment (typically a moof followed by its mdat). No `mdat` is read.
 * @param track   - Optional. The track whose track fragment to read, as {@link findKeyframe} takes it. Without it, the moof's first track fragment is read.
 *
 * @returns `true` when the track fragment's first keyframe is its first sample or every sample ahead of it states a duration of zero, `false` when it holds no
 *          keyframe, when a sample ahead of the keyframe states a duration other than zero or states none, or when a duration field ahead of the keyframe lies past
 *          its run's box.
 *
 * @example
 *
 * ```ts
 * const video = findVideoTrack(initSegment);
 *
 * // Hold a recording back until a fragment arrives that a decoder can take from its first byte.
 * if(video && startsWithKeyframe(fragment, video)) {
 *
 *   recording.start(initSegment, fragment);
 * }
 * ```
 *
 * @category FFmpeg
 */
export function startsWithKeyframe(segment: Buffer, track?: FMp4Track): boolean {

  const keyframe = findKeyframe(segment, track);

  // An index of zero or none settles the answer alone, so the track fragment is looked up again only when samples stand ahead of the keyframe.
  const traf = keyframe ? findKeyframeTrackFragment(segment, track) : null;

  if(!keyframe || !traf) {

    return keyframe === 0;
  }

  const trafEnd = traf.offset + traf.size;
  let ahead = keyframe;
  let defaultDuration: Nullable<number> | undefined;
  let trun = findBox(segment, "trun", traf.offset + BOX_HEADER_SIZE, trafEnd);
  let run = trun && readTrackRun(segment, trun);

  // Each run in order while samples stand ahead of the keyframe. These are the runs findKeyframe counted the keyframe's index across, so the walk reaches the
  // keyframe with no sample left ahead of it unless a duration answers first.
  while(trun && run && (ahead > 0)) {

    const trunEnd = trun.offset + trun.size;
    const count = Math.min(run.sampleCount, ahead);

    if(run.flags & TRUN_FLAG_SAMPLE_DURATION) {

      // Each sample states its duration in its entry, read one entry at a time, and a duration field the box does not hold answers false.
      for(let position = run.firstEntry + entryFieldOffset(run.flags, TRUN_FLAG_SAMPLE_DURATION), sample = 0; sample < count; position += run.stride, sample++) {

        if(((position + 4) > trunEnd) || (segment.readUInt32BE(position) !== 0)) {

          return false;
        }
      }
    } else if(count > 0) {

      // The run's entries state no durations, so every sample of it ahead of the keyframe takes the header's default, and the default answers for them all. It is
      // read once, by the first run that needs it, and a header that states none answers false.
      defaultDuration ??= readKeyframeHeader(segment, traf)?.defaultDuration;

      if(defaultDuration !== 0) {

        return false;
      }
    }

    ahead -= count;
    trun = findBox(segment, "trun", trunEnd, trafEnd);
    run = trun && readTrackRun(segment, trun);
  }

  return ahead === 0;
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

  return findTrackByHandler(initSegment, HDLR_TYPE_SOUN) !== null;
}

/**
 * Finds an fMP4 initialization segment's video track: the first track whose media handler is `"vide"`, as its track ID and its media timescale.
 *
 * Traverses `moov -> trak -> mdia -> hdlr` as {@link hasAudioTrack} does, passing over a track with no `mdia`, no `hdlr` or an `hdlr` too short to name its handler,
 * and reads the first video track's `tkhd` for its ID and its `mdhd` for its timescale. Each of those fullboxes holds its field after a creation and a modification
 * time that are 32-bit in version 0 and 64-bit in version 1, and no later version is defined, so the field is read from byte 20 of the box or from byte 28.
 *
 * @param initSegment - A buffer containing a complete fMP4 initialization segment (typically ftyp + moov), or one followed by fragments.
 *
 * @returns The video track, or `null` when the segment has no video track, when that track's `tkhd` or `mdhd` is missing, too short or of a version above 1, or when
 *          its timescale is zero.
 *
 * @category FFmpeg
 */
export function findVideoTrack(initSegment: Buffer): Nullable<FMp4Track> {

  const track = findTrackByHandler(initSegment, HDLR_TYPE_VIDE);

  if(!track) {

    return null;
  }

  const id = readFieldAfterTimes(initSegment, findBox(initSegment, "tkhd", track.trak.offset + BOX_HEADER_SIZE, track.trak.offset + track.trak.size));
  const timescale = readFieldAfterTimes(initSegment, findBox(initSegment, "mdhd", track.mdia.offset + BOX_HEADER_SIZE, track.mdia.offset + track.mdia.size));

  // A timescale of zero would make every duration a division by zero, so a track that states one is a track this module cannot time.
  if((id === null) || !timescale) {

    return null;
  }

  return { id, timescale };
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

/**
 * Cuts an fMP4 fragment into pieces that each end where one of a track's frames ends, each carrying that frame's duration, for
 * {@link backpressure!BackpressureWriter.writePaced | BackpressureWriter.writePaced}.
 *
 * Reads the first `moof`'s track fragment whose `tfhd` names `track`, and that fragment's one `trun`. A sample's size and duration come from its `trun` entry when
 * the run carries them and from the `tfhd`'s defaults otherwise, never from the initialization segment. The first frame starts at the moof's start plus the run's
 * data offset, read signed, and each frame follows the one before it. Piece k runs from the end of piece k - 1, or the fragment's start for the first, to the end of
 * frame k, and the last piece runs to the fragment's end, so the pieces join back to the fragment exactly and carry every other track's samples and every box
 * around them along with the video. A duration is the frame's ticks times 1000 over the track's timescale, in milliseconds. The pieces are `subarray` views over
 * `fragment`, so no bytes are copied.
 *
 * A fragment none of whose track fragments names `track` holds no frame of it, as the fragment of audio alone that FFmpeg writes when a clip's audio outlasts its
 * video does. There is nothing in it to cut at, so it answers an empty list, which a caller tells apart from `null`, the answer for a fragment that holds the
 * track and cannot be cut. The walk of the track fragments ends at a box it cannot read, so a fragment whose track fragments break off that way before one names
 * the track answers the empty list too.
 *
 * The reader knows one layout, the one FFmpeg's `default_base_moof` movflag writes: data offsets measured from the moof, and one run per track fragment. A
 * fragment it cannot read answers `null` - one with no `moof`, no `mdat` after it, or a track fragment that names the track in any other layout - which is how a
 * caller learns its producer's layout is not one this reader paces.
 *
 * @remarks **Trust boundary.** The walk is bounded by the payload: every sample holds at least one byte, and every frame lies inside the `mdat` that follows the
 * `moof`. A malformed run can still declare a sample for every byte of that payload, each answered as a piece of its own. This is safe for trusted sources like
 * FFmpeg, where each sample is a whole frame. A caller feeding fragments from a source it does not trust bounds them first, because a fragment's size bounds the
 * pieces it can answer.
 *
 * @param fragment - A buffer containing a complete fMP4 fragment (a moof followed by its mdat).
 * @param track    - The track to cut at, typically the video track {@link findVideoTrack} read from the stream's initialization segment. Its timescale must be
 *                   positive, as {@link findVideoTrack} answers it, because each duration is divided by it.
 *
 * @returns The pieces, an empty list when no track fragment names the track, or `null` when the fragment has no `moof` or no `mdat` after it,
 *          when the track fragment that names the track has a `tfhd` too short for a field its flags announce, one that does not set default-base-is-moof or one
 *          that carries a base data offset, when it holds other than exactly one `trun` or that run carries no data offset, when the run declares no samples or its
 *          entries run past its box, when a sample's size or duration is neither in its entry nor a `tfhd` default, when a sample is empty, or when any frame lies
 *          outside the payload of the `mdat` that follows the `moof`.
 *
 * @category FFmpeg
 */
export function splitVideoFrames(fragment: Buffer, track: FMp4Track): Nullable<PacedChunk[]> {

  const moof = findBox(fragment, "moof");

  if(!moof) {

    return null;
  }

  const mdat = findBox(fragment, "mdat", moof.offset + moof.size);

  if(!mdat) {

    return null;
  }

  const found = findTrackFragment(fragment, moof, track);

  // No track fragment names the track, so the fragment holds none of its frames and there is nothing to cut at.
  if(!found) {

    return [];
  }

  // The track fragment that names the track is the one to cut, so a rule it breaks makes the fragment one this reader cannot cut, a header too short for a field its
  // flags announce among them.
  const header = readTrackFragmentHeader(fragment, found.tfhd);

  return header && splitRun(fragment, { header, mdat, moof, timescale: track.timescale, traf: found.traf });
}

/* The track fragment that holds a track, found from an fMP4 fragment's `moof`: the first whose `tfhd` names `track`, with that `tfhd`. Null when no track fragment
 * names the track, or when the walk meets a box it cannot read before one does, since a malformed size makes it unsafe to keep walking. A track fragment with no
 * header, or one whose header is too short to hold a track_ID, names no track, so it is passed over. Every reader that looks for a track's fragment goes through
 * this, so which track fragment holds a track is decided once.
 */
function findTrackFragment(buffer: Buffer, moof: FMp4Box, track: FMp4Track): Nullable<{ tfhd: FMp4Box; traf: FMp4Box }> {

  const moofEnd = moof.offset + moof.size;

  for(let trafStart = moof.offset + BOX_HEADER_SIZE; ;) {

    const traf = findBox(buffer, "traf", trafStart, moofEnd);

    if(!traf) {

      return null;
    }

    const trafEnd = traf.offset + traf.size;
    const tfhd = findBox(buffer, "tfhd", traf.offset + BOX_HEADER_SIZE, trafEnd);

    if(tfhd && (readTrackId(buffer, tfhd) === track.id)) {

      return { tfhd, traf };
    }

    trafStart = trafEnd;
  }
}

/* The track fragment every keyframe reader reads, from an fMP4 fragment's first `moof`: with a track, the first whose `tfhd` names it, and without one, the moof's
 * first. It answers the track fragment alone, and a reader that needs a default finds the header then, so without a track a read whose runs state everything it
 * needs costs no header lookup. With a track, the choice itself reads each track fragment's header for its track_ID. Null when the segment has no `moof`, or when
 * no track fragment names the track (or, without one, the moof holds none). The keyframe readers each go through this, so the samples a keyframe's index counts
 * are the samples each of them reads.
 */
function findKeyframeTrackFragment(buffer: Buffer, track?: FMp4Track): Nullable<FMp4Box> {

  const moof = findBox(buffer, "moof");

  if(!moof) {

    return null;
  }

  if(track) {

    return findTrackFragment(buffer, moof, track)?.traf ?? null;
  }

  return findBox(buffer, "traf", moof.offset + BOX_HEADER_SIZE, moof.offset + moof.size);
}

// The header a keyframe read takes a sample's defaults from: its track fragment's first `tfhd`, which for a named track is the header that names it, because a
// track fragment is chosen by its first header. A reader calls this only when a sample first needs a default.
function readKeyframeHeader(buffer: Buffer, traf: FMp4Box): Nullable<TrackFragmentHeader> {

  return readTrackFragmentHeader(buffer, findBox(buffer, "tfhd", traf.offset + BOX_HEADER_SIZE, traf.offset + traf.size));
}

/* The first track in an init segment whose media handler is `handlerType`, as the boxes of its `trak` and its `mdia`, or null when no track has that handler.
 *
 * Walks each trak box inside the moov, advancing past each one it finds. Once it has passed the last trak, findBox runs out of range and returns null, which is how
 * the walk knows it is done, and a malformed box ends the walk the same way. A trak with no mdia, an mdia with no hdlr, and an hdlr too small to hold the
 * handler_type field are each passed over rather than ending the walk. Every reader of a track by its handler goes through this, so which tracks count as having a
 * handler is decided once.
 */
function findTrackByHandler(initSegment: Buffer, handlerType: number): Nullable<{ mdia: FMp4Box; trak: FMp4Box }> {

  const moov = findBox(initSegment, "moov");

  if(!moov) {

    return null;
  }

  const moovEnd = moov.offset + moov.size;

  for(let trakStart = moov.offset + BOX_HEADER_SIZE; ;) {

    const trak = findBox(initSegment, "trak", trakStart, moovEnd);

    if(!trak) {

      return null;
    }

    const mdia = findBox(initSegment, "mdia", trak.offset + BOX_HEADER_SIZE, trak.offset + trak.size);

    if(mdia) {

      const hdlr = findBox(initSegment, "hdlr", mdia.offset + BOX_HEADER_SIZE, mdia.offset + mdia.size);

      // Read the handler_type field. In a hdlr fullbox, the layout after the standard box header is: version/flags (4 bytes) + pre_defined (4 bytes) + handler_type
      // (4 bytes). We check that the box is large enough to contain the field before reading.
      if(hdlr && (hdlr.size >= (HDLR_TYPE_OFFSET + 4)) && (initSegment.readUInt32BE(hdlr.offset + HDLR_TYPE_OFFSET) === handlerType)) {

        return { mdia, trak };
      }
    }

    // Advance past this trak to search for the next one.
    trakStart = trak.offset + trak.size;
  }
}

/* Read the 32-bit field a tkhd or mdhd fullbox holds after its creation and modification times: a tkhd's track_ID, an mdhd's timescale. Those times are 32-bit in
 * version 0 and 64-bit in version 1, so the field sits at byte 20 or byte 28 of the box. Null for a missing box, a box too short to hold the field, and a version
 * above 1, whose layout this module does not know.
 */
function readFieldAfterTimes(buffer: Buffer, box: Nullable<FMp4Box>): Nullable<number> {

  if(!box || (box.size < (BOX_HEADER_SIZE + 4))) {

    return null;
  }

  const version = buffer.readUInt8(box.offset + BOX_HEADER_SIZE);

  if(version > 1) {

    return null;
  }

  const field = (version === 0) ? 20 : 28;

  if(box.size < (field + 4)) {

    return null;
  }

  return buffer.readUInt32BE(box.offset + field);
}

/* Read a TRUN's fixed header: its flags, its sample count, and the positions of its optional fields, its first entry and its entry stride. Null for a run too short
 * to hold that header. Nothing past the fixed header is bounded here, because the readers of a run need different things from it: the keyframe readers read one
 * flags or duration field at a time and answer from a sample ahead of entries that are cut short, while the frame reader needs every entry. Each reader checks what
 * it reads against the box.
 */
function readTrackRun(buffer: Buffer, trun: FMp4Box): Nullable<TrackRunLayout> {

  // The trun is a fullbox: after the standard box header come the version/flags word and the sample_count word. We need the full header to read the flags and
  // determine which optional fields follow.
  if(trun.size < TRUN_HEADER_SIZE) {

    return null;
  }

  // Read the flags from the fullbox header. The version occupies the top byte and the flags occupy the rest of the word.
  const flags = buffer.readUInt32BE(trun.offset + BOX_HEADER_SIZE) & 0x00FFFFFF;

  // The optional fields follow the sample count in a fixed order, the data_offset and then the first_sample_flags, and the entries follow them.
  let position = trun.offset + TRUN_HEADER_SIZE;
  const dataOffset = (flags & TRUN_FLAG_DATA_OFFSET) ? position : null;

  if(dataOffset !== null) {

    position += 4;
  }

  const firstSampleFlags = (flags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) ? position : null;

  if(firstSampleFlags !== null) {

    position += 4;
  }

  const stride = TRUN_ENTRY_FIELDS.reduce((width, field) => (flags & field) ? (width + 4) : width, 0);

  return { dataOffset, firstEntry: position, firstSampleFlags, flags, sampleCount: buffer.readUInt32BE(trun.offset + BOX_HEADER_SIZE + 4), stride };
}

// The offset of `field` within a TRUN entry whose run carries `flags`: the width of every field the run carries ahead of it in the entry's fixed order.
function entryFieldOffset(flags: number, field: (typeof TRUN_ENTRY_FIELDS)[number]): number {

  let offset = 0;

  for(const entryField of TRUN_ENTRY_FIELDS) {

    if(entryField === field) {

      break;
    }

    if(flags & entryField) {

      offset += 4;
    }
  }

  return offset;
}

// A sample whose flags clear the non-sync bit is a sync sample, a keyframe.
function isSyncSample(flags: number): boolean {

  return (flags & SAMPLE_FLAG_NON_SYNC) === 0;
}

// The fields of a TFHD its readers read: its flags, and the defaults a TRUN's samples fall back to, the duration the frame reader and `startsWithKeyframe` read, the
// size the frame reader reads and the flags `findKeyframe` reads. A default the header does not carry is null.
interface TrackFragmentHeader {

  readonly defaultDuration: Nullable<number>;
  readonly defaultFlags: Nullable<number>;
  readonly defaultSize: Nullable<number>;
  readonly flags: number;
}

// The track a TFHD names, read from the track_ID that follows its fullbox header, or null for a header too short to hold one.
function readTrackId(buffer: Buffer, tfhd: FMp4Box): Nullable<number> {

  return (tfhd.size < TFHD_HEADER_SIZE) ? null : buffer.readUInt32BE(tfhd.offset + BOX_HEADER_SIZE + 4);
}

/* Read a TFHD: its flags, then each optional field they set after the track_ID, in the order the spec lays them out - the 64-bit base data offset, the sample
 * description index, and the default duration, size and flags. Null for a missing header, one too short to hold its flags and track_ID, and one too short for any
 * field its flags announce, so a default is read only from a header that holds it and every field before it.
 */
function readTrackFragmentHeader(buffer: Buffer, tfhd: Nullable<FMp4Box>): Nullable<TrackFragmentHeader> {

  if(!tfhd || (tfhd.size < TFHD_HEADER_SIZE)) {

    return null;
  }

  const end = tfhd.offset + tfhd.size;
  let position = tfhd.offset + TFHD_HEADER_SIZE;
  const flags = buffer.readUInt32BE(tfhd.offset + BOX_HEADER_SIZE) & 0x00FFFFFF;
  let defaultDuration: Nullable<number> = null;
  let defaultFlags: Nullable<number> = null;
  let defaultSize: Nullable<number> = null;

  for(const [ flag, width ] of TFHD_FIELDS) {

    if(!(flags & flag)) {

      continue;
    }

    if((position + width) > end) {

      return null;
    }

    switch(flag) {

      case TFHD_FLAG_DEFAULT_SAMPLE_DURATION: {

        defaultDuration = buffer.readUInt32BE(position);

        break;
      }

      case TFHD_FLAG_DEFAULT_SAMPLE_FLAGS: {

        defaultFlags = buffer.readUInt32BE(position);

        break;
      }

      case TFHD_FLAG_DEFAULT_SAMPLE_SIZE: {

        defaultSize = buffer.readUInt32BE(position);

        break;
      }

      default: {

        break;
      }
    }

    position += width;
  }

  return { defaultDuration, defaultFlags, defaultSize, flags };
}

// What the frame reader has found by the time it reaches the video track fragment: that fragment and its header, the moof and the mdat around it, and the track's
// timescale.
interface VideoTrackFragment {

  readonly header: TrackFragmentHeader;
  readonly mdat: FMp4Box;
  readonly moof: FMp4Box;
  readonly timescale: number;
  readonly traf: FMp4Box;
}

/* Cut a fragment at the frames of the one run its video track fragment holds, answering the pieces `splitVideoFrames` documents or null where it documents null.
 * Each frame is placed and bounded as its piece is cut, so a check that fails part way through discards the pieces cut before it and no caller sees them.
 */
function splitRun(fragment: Buffer, { header, mdat, moof, timescale, traf }: VideoTrackFragment): Nullable<PacedChunk[]> {

  // The reader knows data offsets measured from the moof alone, which is what default-base-is-moof states and an explicit base data offset would override.
  if(!(header.flags & TFHD_FLAG_DEFAULT_BASE_IS_MOOF) || (header.flags & TFHD_FLAG_BASE_DATA_OFFSET)) {

    return null;
  }

  const trafEnd = traf.offset + traf.size;
  const trun = findBox(fragment, "trun", traf.offset + BOX_HEADER_SIZE, trafEnd);

  // Exactly one run: a second would place its samples by a data offset of its own, which the frames below do not follow.
  if(!trun || findBox(fragment, "trun", trun.offset + trun.size, trafEnd)) {

    return null;
  }

  const run = readTrackRun(fragment, trun);

  // The run must declare at least one sample, say where its samples start, and hold every entry it declares.
  if(!run?.sampleCount || (run.dataOffset === null) || ((run.firstEntry + (run.sampleCount * run.stride)) > (trun.offset + trun.size))) {

    return null;
  }

  const durationAt = (run.flags & TRUN_FLAG_SAMPLE_DURATION) ? entryFieldOffset(run.flags, TRUN_FLAG_SAMPLE_DURATION) : null;
  const sizeAt = (run.flags & TRUN_FLAG_SAMPLE_SIZE) ? entryFieldOffset(run.flags, TRUN_FLAG_SAMPLE_SIZE) : null;
  const payloadEnd = mdat.offset + mdat.size;
  let frameEnd = moof.offset + fragment.readInt32BE(run.dataOffset);

  // The first frame must start inside the mdat's payload, past its header, and each frame is bounded as it is placed below.
  if(frameEnd < (mdat.offset + BOX_HEADER_SIZE)) {

    return null;
  }

  const pieces: PacedChunk[] = [];
  let pieceStart = 0;

  for(let entry = run.firstEntry, sample = 0; sample < run.sampleCount; entry += run.stride, sample++) {

    const duration = (durationAt === null) ? header.defaultDuration : fragment.readUInt32BE(entry + durationAt);
    const size = (sizeAt === null) ? header.defaultSize : fragment.readUInt32BE(entry + sizeAt);

    // A sample of no bytes is no frame to pace, and refusing it is also what bounds the walk: a run whose every size is a zero default would otherwise declare as many
    // frames as its 32-bit count holds, all of them fitting in any payload.
    if((duration === null) || !size) {

      return null;
    }

    frameEnd += size;

    if(frameEnd > payloadEnd) {

      return null;
    }

    // The last piece carries everything after the last frame as well, the other tracks' samples among it, so the pieces join back to the whole fragment.
    const pieceEnd = (sample === (run.sampleCount - 1)) ? fragment.length : frameEnd;

    pieces.push({ bytes: fragment.subarray(pieceStart, pieceEnd), duration: (duration * 1000) / timescale });
    pieceStart = pieceEnd;
  }

  return pieces;
}
