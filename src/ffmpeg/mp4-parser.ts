/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/mp4-parser.ts: Pure byte-to-record parser for ISO BMFF (fMP4) box streams.
 */

/**
 * Pure stateful byte-to-record parser for ISO BMFF (fMP4) box streams.
 *
 * This module ships the streaming counterpart to the static predicates in {@link ffmpeg/fmp4! | fmp4}. The predicates (`findBox`, `isKeyframe`, `hasAudioTrack`,
 * `splitMoofMdat`) answer one-shot questions about a complete Buffer. {@link Mp4BoxParser} solves a different problem: incrementally consuming an unbounded byte stream
 * (typically FFmpeg stdout producing fMP4 fragments) and emitting each complete box as it becomes available.
 *
 * The parser is intentionally signal-free, event-free, and allocation-light. It carries only the bytes of an incomplete trailing box across calls and hands out
 * zero-copy `subarray` views whenever possible. Resource lifetime, async consumption, and cancellation are not this class's job - those belong to the composing
 * caller (see {@link ffmpeg/mp4-assembler!Mp4SegmentAssembler | Mp4SegmentAssembler}).
 *
 * @module
 */
import { BOX_HEADER_SIZE } from "./fmp4.ts";

/**
 * ISO BMFF box type code for the `ftyp` (file type) box, encoded as a 32-bit big-endian integer. Useful for branching on {@link Mp4Box.type} without re-encoding
 * the 4-character ASCII tag on every comparison.
 *
 * @category FFmpeg
 */
export const BOX_TYPE_FTYP = 0x66747970;

/**
 * ISO BMFF box type code for the `mdat` (media data) box. The mdat box carries the sample payload for the preceding `moof` in an fMP4 fragment and is the end-of-segment
 * marker that {@link ffmpeg/mp4-assembler!Mp4SegmentAssembler | Mp4SegmentAssembler} watches for.
 *
 * @category FFmpeg
 */
export const BOX_TYPE_MDAT = 0x6D646174;

/**
 * ISO BMFF box type code for the `moof` (movie fragment) box. Marks the start of a new fMP4 media fragment; the first `moof` in a stream also marks the end of the
 * initialization segment.
 *
 * @category FFmpeg
 */
export const BOX_TYPE_MOOF = 0x6D6F6F66;

/**
 * ISO BMFF box type code for the `moov` (movie) box. Part of the initialization segment that precedes the first `moof` in an fMP4 stream.
 *
 * @category FFmpeg
 */
export const BOX_TYPE_MOOV = 0x6D6F6F76;

// Reusable empty buffer sentinel for the parser's pending-bytes state. Avoids repeated zero-byte allocations at the start of every parse cycle where no residual bytes
// carried over from the previous chunk.
const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * A complete parsed ISO BMFF box emitted by {@link Mp4BoxParser}.
 *
 * @property bytes   - The complete box bytes, including the 8-byte header. The buffer is typically a zero-copy subarray view over the feed chunk; consumers that need
 *                     to hold it past the iteration loop should copy with `Buffer.from()` if the upstream chunk lifetime is suspect.
 * @property type    - The box type encoded as a 32-bit big-endian integer. Compare against the `BOX_TYPE_*` constants exported from this module; numeric comparison
 *                     avoids the per-box string allocation that an ASCII tag comparison would incur.
 *
 * @category FFmpeg
 */
export interface Mp4Box {

  bytes: Buffer;
  type: number;
}

/**
 * Pure stateful parser that converts a stream of ISO BMFF byte chunks into discrete {@link Mp4Box} records.
 *
 * Feed each chunk from the byte source through {@link Mp4BoxParser.consume} and iterate the returned values for every complete box now available. The parser carries
 * only the bytes of an incomplete trailing box across calls; chunk boundaries in the middle of a box are handled transparently. A single chunk may produce zero, one, or
 * many boxes depending on how the stream falls on chunk boundaries.
 *
 * The class is intentionally signal-free and event-free. It performs one job, synchronously, and leaves resource lifecycle and async consumption to the composing
 * caller - typically {@link ffmpeg/mp4-assembler!Mp4SegmentAssembler | Mp4SegmentAssembler} for fMP4 streams driven by an FFmpeg process.
 *
 * @remarks **Trust boundary.** The parser does not bound the size field it reads from the wire. A source that claims a multi-gigabyte box size would cause the parser
 * to accumulate incoming chunks into its internal pending buffer until the declared box completes. This is safe for trusted sources like FFmpeg stdout, where the
 * size field reflects the actual payload. Callers feeding untrusted byte streams (e.g., user-uploaded media, network input from arbitrary peers) should impose their
 * own bound - either by truncating chunks that would exceed a budget, or by wrapping the parser in a guard that rejects implausibly large declared sizes before
 * feeding the chunk.
 *
 * @example
 *
 * ```ts
 * import { BOX_TYPE_MDAT, Mp4BoxParser } from "homebridge-plugin-utils";
 *
 * const parser = new Mp4BoxParser();
 *
 * for(const box of parser.consume(chunk)) {
 *
 *   if(box.type === BOX_TYPE_MDAT) {
 *
 *     // We have just received a complete mdat box.
 *   }
 * }
 * ```
 *
 * @see Mp4SegmentAssembler
 *
 * @category FFmpeg
 */
export class Mp4BoxParser {

  // Residual bytes from the previous call that did not complete a box. Prepended to the next chunk so a box split across two chunks is reassembled transparently. A
  // zero-length sentinel is used when nothing is pending to avoid per-call allocation.
  #pending: Buffer = EMPTY_BUFFER;

  /**
   * Feed the parser a new byte chunk and yield every complete box now available.
   *
   * The iterable is single-pass: consume it with a `for...of` loop (or spread into an array) before the next call to `consume`. Emitted `bytes` are typically
   * zero-copy subarray views over the input chunk; copy with `Buffer.from()` if you intend to hold a box past the upstream chunk's lifetime.
   *
   * Chunk boundaries in the middle of a box are handled internally: the incomplete trailing bytes are stashed and prepended to the next call's input.
   *
   * @param chunk - A contiguous slice of box-stream bytes from the source.
   *
   * @returns An iterable of every box contained in (or completed by) this chunk, in stream order.
   */
  public *consume(chunk: Buffer): Iterable<Mp4Box> {

    // Prepend any pending partial box from the previous call. Buffer.concat is only paid when there is actually residual state; the common "chunk carries whole boxes
    // and nothing is pending" path stays zero-allocation.
    const buffer = (this.#pending.length > 0) ? Buffer.concat([ this.#pending, chunk ]) : chunk;
    let offset = 0;

    // Walk boxes by reading each header: 4 bytes size (big-endian) + 4 bytes type. The 32-bit type code is surfaced directly so consumers can compare against the
    // exported BOX_TYPE_* constants without re-encoding a 4-character ASCII tag on every box.
    while((offset + BOX_HEADER_SIZE) <= buffer.length) {

      const size = buffer.readUInt32BE(offset);

      // Size must be at least the header size. Smaller values indicate corruption, a misaligned feed, or an unsupported extended-size box (size === 1 signals a 64-bit
      // size field that we do not handle). Either way, the parser cannot make further progress - reset pending state so we do not busy-loop on the same bad byte on
      // every subsequent chunk.
      if(size < BOX_HEADER_SIZE) {

        this.#pending = EMPTY_BUFFER;

        return;
      }

      // Not enough bytes for a complete box yet. Stash the remainder - including the header - for the next call.
      if((offset + size) > buffer.length) {

        break;
      }

      const type = buffer.readUInt32BE(offset + 4);
      const bytes = buffer.subarray(offset, offset + size);

      offset += size;

      yield { bytes, type };
    }

    // Carry the trailing incomplete box (header + partial payload, or just the unconsumed tail) into the next call.
    this.#pending = (offset === buffer.length) ? EMPTY_BUFFER : buffer.subarray(offset);
  }
}
