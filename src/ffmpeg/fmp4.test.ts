/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/fmp4.test.ts: Unit tests for the stateless ISO BMFF (fMP4) predicates exported from fmp4.ts - findBox, isKeyframe, hasAudioTrack, and splitMoofMdat - for
 * the keyframe reader isKeyframe answers through, findKeyframe, for startsWithKeyframe, which answers from it, and for the frame reader beside them, findVideoTrack
 * and splitVideoFrames.
 *
 * These are the one-shot counterparts to the streaming `Mp4BoxParser` / `Mp4SegmentAssembler`: each predicate accepts a complete Buffer and returns a verdict. They are
 * consumed both internally (the parser reuses `BOX_HEADER_SIZE` and the assembler compares box type codes via the `BOX_TYPE_*` constants) and externally (HBUP calls
 * `isKeyframe(buffer)` directly at its timeshift boundary), so the surface here stays stable: the library's own streaming parser and assembler read its constants,
 * and a plugin acts on its verdicts at its own boundary.
 *
 * The frame reader's rows build every well-formed fragment and initialization segment from invented values through `makeFragment` and `makeInitSegment`, in the
 * layout the family's producers write: one moof holding a video track fragment and then an audio one, and one mdat holding the video samples and then the audio.
 * A row that breaks a rule that layout keeps builds its fragment or segment from the fullbox builders. One row reads FFmpeg's own output for its test pattern, gated
 * on the FFmpeg integration predicate. The keyframe reader's rows that lay out runs of their own build a moof alone from the fullbox builders, because the keyframe
 * readers read no mdat.
 */
import { BOX_HEADER_SIZE, HDLR_TYPE_SOUN, SAMPLE_FLAG_NON_SYNC, findBox, findKeyframe, findVideoTrack, hasAudioTrack, isKeyframe, splitMoofMdat,
  splitVideoFrames, startsWithKeyframe } from "./fmp4.ts";
import { BOX_TYPE_MOOF, Mp4BoxParser } from "./mp4-parser.ts";
import { HDLR_TYPE_VIDE, makeBox, makeContainer, makeFragment, makeHdlrBox, makeInitSegment, makeMdhdBox, makeTfhdBox, makeTkhdBox,
  makeTrunBox } from "./fmp4-builders.ts";
import type { InitSegmentTrack, TrunSample } from "./fmp4-builders.ts";
import { describe, test } from "node:test";
import { expectAt, present, silentLog } from "../testing/index.ts";
import type { FMp4Track } from "./fmp4.ts";
import { FfmpegCodecs } from "./codecs.ts";
import type { Nullable } from "../util.ts";
import type { PacedChunk } from "../backpressure.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { ffmpegIntegrationEnabled } from "./integration.helpers.ts";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("findBox", () => {

  test("locates a top-level box at offset 0 and reports its total size", () => {

    // A single box whose payload carries a known byte pattern. `findBox` returns the offset and size - the caller reads the payload bytes via `buffer.subarray`.
    const payload = Buffer.from("abcd");
    const box = makeBox("moov", payload);

    const result = findBox(box, "moov");

    assert.deepEqual(result, { offset: 0, size: 12 }, "header (8 bytes) + payload (4 bytes) = 12 total");
  });

  test("locates the first matching box when multiple boxes of different types sit at the top level", () => {

    // Realistic init shape: ftyp then moov. The predicate's job is to find the first box of the requested type, skipping past intervening boxes via their size fields.
    const ftyp = makeBox("ftyp", Buffer.from("isomavc1"));
    const moov = makeBox("moov", Buffer.from("metadata"));

    const result = findBox(Buffer.concat([ ftyp, moov ]), "moov");

    assert.deepEqual(result, { offset: ftyp.length, size: moov.length });
  });

  test("returns null when the requested type is not present", () => {

    const box = makeBox("ftyp");

    assert.equal(findBox(box, "moov"), null);
  });

  test("returns null for buffers shorter than the 8-byte header", () => {

    // A sub-header buffer cannot contain a box at all; the loop guard (`offset + BOX_HEADER_SIZE <= limit`) fails before the first read.
    assert.equal(findBox(Buffer.alloc(4), "moov"), null);
    assert.equal(findBox(Buffer.alloc(0), "moov"), null);
  });

  test("returns null when the declared size is below the header size (corruption guard)", () => {

    // A claimed size of 4 is invalid - a well-formed box is at least the 8-byte header. The predicate must reject rather than loop indefinitely or read past the tail.
    const corrupt = Buffer.alloc(8);

    corrupt.writeUInt32BE(4, 0);
    corrupt.write("moov", 4, 4, "ascii");

    assert.equal(findBox(corrupt, "moov"), null);
  });

  test("returns null when the declared size extends past the buffer (extended-size / open-ended guard)", () => {

    // Size encodings of 0 ("extends to end of file") and 1 ("size field is actually 64 bits in the next 8 bytes") are legal ISO BMFF but outside `findBox`'s scope.
    // Both should reject rather than misread the payload.
    const openEnded = Buffer.alloc(8);

    openEnded.writeUInt32BE(0, 0);
    openEnded.write("moov", 4, 4, "ascii");
    assert.equal(findBox(openEnded, "moov"), null, "size=0 (to-end-of-file) is unsupported and must reject");

    const extendedSize = Buffer.alloc(8);

    extendedSize.writeUInt32BE(1, 0);
    extendedSize.write("moov", 4, 4, "ascii");
    assert.equal(findBox(extendedSize, "moov"), null, "size=1 (extended-size) is unsupported and must reject");
  });

  test("returns null when the declared size is larger than the remaining buffer", () => {

    // Claim size = 100 but only provide 12 bytes total. The size-vs-limit guard catches this.
    const truncated = Buffer.alloc(12);

    truncated.writeUInt32BE(100, 0);
    truncated.write("moov", 4, 4, "ascii");
    assert.equal(findBox(truncated, "moov"), null);
  });

  test("returns null for type strings whose length is not exactly 4", () => {

    // Only 4-ASCII-char types exist in the ISO BMFF box naming scheme. The predicate's length guard rejects everything else up front without attempting a search.
    const box = makeBox("moov");

    assert.equal(findBox(box, "moo"), null);
    assert.equal(findBox(box, "moovx"), null);
    assert.equal(findBox(box, ""), null);
  });

  test("respects the optional start and end range when scanning a sub-range", () => {

    // Caller-supplied start/end bound the search. The assembler uses this pattern: once a parent box is located, it searches only within the parent's byte range for
    // child boxes so unrelated top-level boxes never match a nested search.
    const ftyp = makeBox("ftyp");
    const moov = makeBox("moov");
    const buffer = Buffer.concat([ ftyp, moov ]);

    // Searching only within the ftyp range must not find moov.
    assert.equal(findBox(buffer, "moov", 0, ftyp.length), null);

    // Searching from the moov offset onward finds it.
    const result = findBox(buffer, "moov", ftyp.length);

    assert.ok(result, "findBox must locate the moov box when the start range begins at its offset");
    assert.equal(result.offset, ftyp.length);
  });

  test("refuses an assignment to a located box's fields at compile time", () => {

    const box = makeBox("moov", Buffer.from("abcd"));
    const result = findBox(box, "moov");

    assert.ok(result, "findBox must locate the moov box the fixture carries");
    assert.equal(result.offset, 0, "the located box must report the offset the walk stopped at");
    assert.equal(result.size, box.length, "the located box must report the box's total size, header included");

    // Type-level refusal only. `readonly` is erased at runtime, so the reads above run before the assignments below - each would land if the compiler admitted it.
    // The directives fail typecheck if any field of FMp4Box drops its modifier, so the contract is policed by `tsc --noEmit` rather than by the runner.
    // @ts-expect-error - offset is readonly.
    result.offset = 0;
    // @ts-expect-error - size is readonly.
    result.size = 0;
  });
});

describe("isKeyframe", () => {

  // Assemble a minimal moof/traf container wrapping the supplied trun. The predicate walks moof -> traf -> trun, so every test case that exercises a trun branch needs
  // the enclosing structure. Centralizing it here keeps each test case focused on the trun variation.
  function wrapInMoofTraf(trun: Buffer): Buffer {

    const traf = makeContainer("traf", [trun]);
    const moof = makeContainer("moof", [traf]);

    return moof;
  }

  test("returns true when TRUN first_sample_flags does not set the non-sync bit (keyframe)", () => {

    // The common frag_keyframe path: FFmpeg writes first_sample_flags with bit 0x00010000 clear to indicate the sample is a sync sample.
    const trun = makeTrunBox({ sampleFlagsValue: 0, useFirstSampleFlags: true });
    const segment = wrapInMoofTraf(trun);

    assert.equal(isKeyframe(segment), true);
  });

  test("returns false when TRUN first_sample_flags sets the non-sync bit", () => {

    // Same path, bit set - the sample is not a sync sample.
    const trun = makeTrunBox({ sampleFlagsValue: SAMPLE_FLAG_NON_SYNC, useFirstSampleFlags: true });
    const segment = wrapInMoofTraf(trun);

    assert.equal(isKeyframe(segment), false);
  });

  test("falls back to per-sample flags when TRUN_FLAG_FIRST_SAMPLE_FLAGS is not set", () => {

    // The predicate's secondary path: no first_sample_flags flag means we skip past duration/size (if present) and read per-sample flags instead.
    const trun = makeTrunBox({ includeDuration: true, includeSize: true, sampleFlagsValue: 0, usePerSampleFlags: true });
    const segment = wrapInMoofTraf(trun);

    assert.equal(isKeyframe(segment), true);
  });

  test("returns false when per-sample flags indicate a non-sync sample", () => {

    const trun = makeTrunBox({ includeDuration: true, includeSize: true, sampleFlagsValue: SAMPLE_FLAG_NON_SYNC, usePerSampleFlags: true });
    const segment = wrapInMoofTraf(trun);

    assert.equal(isKeyframe(segment), false);
  });

  test("returns false when the TRUN reports neither first_sample_flags nor sample_flags", () => {

    // Neither flags source present - the predicate cannot determine sync status and returns false conservatively. This is the "no information available" path.
    const trun = makeTrunBox({ sampleFlagsValue: 0 });
    const segment = wrapInMoofTraf(trun);

    assert.equal(isKeyframe(segment), false);
  });

  test("returns false when the segment contains no moof box", () => {

    // Without a moof we cannot walk to traf/trun. The predicate must short-circuit on the top-level lookup.
    const notAnFMp4 = Buffer.concat([ makeBox("ftyp"), makeBox("mdat") ]);

    assert.equal(isKeyframe(notAnFMp4), false);
  });

  test("returns false when moof has no traf child", () => {

    // A moof without a traf is syntactically valid but semantically unusable for the predicate's decision - no sample information is available.
    const moofOnly = makeContainer("moof", [makeBox("mfhd")]);

    assert.equal(isKeyframe(moofOnly), false);
  });

  test("returns false when traf has no trun child", () => {

    // Same reasoning: the traversal stops short of the flags source.
    const traf = makeContainer("traf", [makeBox("tfhd")]);
    const moof = makeContainer("moof", [traf]);

    assert.equal(isKeyframe(moof), false);
  });

  test("returns false when the trun is shorter than the fullbox header", () => {

    // Regression guard for the size-vs-TRUN_HEADER_SIZE check. A trun that ends before the sample_count field cannot be interpreted.
    // Fullbox header only partially populated.
    const shortTrun = makeBox("trun", Buffer.alloc(4));
    const segment = wrapInMoofTraf(shortTrun);

    assert.equal(isKeyframe(segment), false);
  });

  test("returns false when per-sample flags are promised but the box is truncated before them", () => {

    // The size guards inside `isKeyframe` reject the read when optional fields push past the declared box end. We construct this by building a trun that sets the
    // sample_flags flag but truncates before the flags field actually appears.
    const truncatedTrun = makeTrunBox({ includeDuration: true, includeSize: true, sampleFlagsValue: 0, truncate: true, usePerSampleFlags: true });
    const segment = wrapInMoofTraf(truncatedTrun);

    assert.equal(isKeyframe(segment), false);
  });
});

describe("hasAudioTrack", () => {

  // Build an init segment whose handler types are exactly the supplied sequence. Each handler is wrapped in hdlr -> mdia -> trak, and all traks are collected into moov.
  function makeInitSegment(handlerTypes: number[], ftyp = makeBox("ftyp", Buffer.from("isomavc1"))): Buffer {

    const traks = handlerTypes.map((handlerType) => makeContainer("trak", [makeContainer("mdia", [makeHdlrBox(handlerType)])]));
    const moov = makeContainer("moov", traks);

    return Buffer.concat([ ftyp, moov ]);
  }

  test("returns true for a single-trak init segment whose handler is \"soun\"", () => {

    assert.equal(hasAudioTrack(makeInitSegment([HDLR_TYPE_SOUN])), true);
  });

  test("returns false for a single-trak init segment whose handler is \"vide\"", () => {

    // Video-only init - every trak's hdlr reports a non-audio handler. The predicate must walk every trak before giving up.
    assert.equal(hasAudioTrack(makeInitSegment([HDLR_TYPE_VIDE])), false);
  });

  test("returns true when one of several traks carries the audio handler", () => {

    // Multi-trak walk: the predicate advances past each trak via `trakStart = trak.offset + trak.size` until it either finds soun or exhausts the moov range.
    assert.equal(hasAudioTrack(makeInitSegment([ HDLR_TYPE_VIDE, HDLR_TYPE_SOUN ])), true);
    assert.equal(hasAudioTrack(makeInitSegment([ HDLR_TYPE_SOUN, HDLR_TYPE_VIDE ])), true);
  });

  test("returns false when the init segment has no moov box", () => {

    // The top-level walk fails to find moov; the predicate must return false rather than throw.
    const ftypOnly = makeBox("ftyp", Buffer.from("isomavc1"));

    assert.equal(hasAudioTrack(ftypOnly), false);
  });

  test("returns false when moov contains no trak children", () => {

    // A moov populated only with mvhd / unrelated metadata cannot contain a track. The inner loop's findBox call returns null immediately and the predicate bails.
    const moovNoTrak = makeContainer("moov", [makeBox("mvhd")]);
    const ftyp = makeBox("ftyp", Buffer.from("isomavc1"));

    assert.equal(hasAudioTrack(Buffer.concat([ ftyp, moovNoTrak ])), false);
  });

  test("returns false when a trak has no mdia child", () => {

    // Degenerate trak - findBox("mdia", ...) returns null inside the walk and the predicate advances past this trak to the next one. With only the degenerate trak
    // present, no audio is ever located.
    const trak = makeContainer("trak", [makeBox("tkhd")]);
    const moov = makeContainer("moov", [trak]);

    assert.equal(hasAudioTrack(Buffer.concat([ makeBox("ftyp"), moov ])), false);
  });

  test("returns false when an mdia has no hdlr child", () => {

    // Same pattern, one level deeper - findBox("hdlr", ...) returns null and the predicate moves on.
    const mdia = makeContainer("mdia", [makeBox("mdhd")]);
    const trak = makeContainer("trak", [mdia]);
    const moov = makeContainer("moov", [trak]);

    assert.equal(hasAudioTrack(Buffer.concat([ makeBox("ftyp"), moov ])), false);
  });

  test("returns false when the hdlr box is too small to contain the handler_type field (undersized guard)", () => {

    // Truncated hdlr: payload exists but stops before HDLR_TYPE_OFFSET + 4. The predicate's size check (`hdlr.size >= (HDLR_TYPE_OFFSET + 4)`) must reject this rather
    // than reading beyond the declared end.
    const hdlr = makeHdlrBox(HDLR_TYPE_SOUN, true);
    const mdia = makeContainer("mdia", [hdlr]);
    const trak = makeContainer("trak", [mdia]);
    const moov = makeContainer("moov", [trak]);

    assert.equal(hasAudioTrack(Buffer.concat([ makeBox("ftyp"), moov ])), false);
  });
});

describe("isKeyframe and hasAudioTrack answers the shared box walks keep", () => {

  // Each row states an answer that a walk checking more, or skipping less, than these predicates do would change.

  test("hasAudioTrack is true for a track with no mdia followed by an audio track", () => {

    const degenerate = makeContainer("trak", [makeBox("tkhd")]);
    const audio = makeContainer("trak", [makeContainer("mdia", [makeHdlrBox(HDLR_TYPE_SOUN)])]);

    assert.equal(hasAudioTrack(Buffer.concat([ makeBox("ftyp"), makeContainer("moov", [ degenerate, audio ]) ])), true);
  });

  test("hasAudioTrack is true for a short hdlr followed by an audio track", () => {

    const short = makeContainer("trak", [makeContainer("mdia", [makeHdlrBox(HDLR_TYPE_SOUN, true)])]);
    const audio = makeContainer("trak", [makeContainer("mdia", [makeHdlrBox(HDLR_TYPE_SOUN)])]);

    assert.equal(hasAudioTrack(Buffer.concat([ makeBox("ftyp"), makeContainer("moov", [ short, audio ]) ])), true);
  });

  test("isKeyframe is true for a run with a sample count of zero and sync first-sample flags", () => {

    const trun = makeTrunBox({ samples: [], useFirstSampleFlags: true });

    assert.equal(trun.readUInt32BE(12), 0, "the run declares no samples");
    assert.equal(isKeyframe(makeContainer("moof", [makeContainer("traf", [trun])])), true);
  });

  test("isKeyframe is true for a multi-sample run with sync first-sample flags and truncated entries", () => {

    // The run declares more samples of duration and size than it holds entries for, so its entries run past the box.
    const trun = makeTrunBox({ includeDuration: true, includeSize: true, sampleCount: 5, samples: [ { duration: 3000, size: 40 }, { duration: 3000, size: 12 } ],
      useFirstSampleFlags: true });

    assert.equal(trun.readUInt32BE(12), 5, "the run declares more samples than it holds");
    assert.equal(isKeyframe(makeContainer("moof", [makeContainer("traf", [trun])])), true);
  });

  test("isKeyframe is true for a run whose first-sample flags mark a sync sample over a first entry whose flags do not", () => {

    const trun = makeTrunBox({ sampleFlagsValue: 0, samples: [{ flags: SAMPLE_FLAG_NON_SYNC }], useFirstSampleFlags: true, usePerSampleFlags: true });

    assert.equal(isKeyframe(makeContainer("moof", [makeContainer("traf", [trun])])), true);
  });

  test("isKeyframe is false for a run whose first-sample flags mark no sync sample over a first entry whose flags do", () => {

    const trun = makeTrunBox({ sampleFlagsValue: SAMPLE_FLAG_NON_SYNC, samples: [{ flags: 0 }], useFirstSampleFlags: true, usePerSampleFlags: true });

    assert.equal(isKeyframe(makeContainer("moof", [makeContainer("traf", [trun])])), false);
  });

  test("isKeyframe is false for a run stating no flags under a track fragment header with no default flags", () => {

    const fragment = makeFragment({ run: { includeDuration: true, includeSize: true }, samples: [ { duration: 3000, size: 30 }, { duration: 3000, size: 20 } ],
      trackId: 1 });

    assert.equal(isKeyframe(fragment), false);
  });
});

describe("splitMoofMdat", () => {

  test("splits a moof + mdat pair into its two components with zero-copy views over the source buffer", () => {

    // The function returns subarrays, not copies. Verify both parts reference the original buffer's backing store so the 30MB-init-segment costs don't double on every
    // fragment. `subarray` sharing is part of the contract - a consumer holding the original Buffer and a split view share one allocation.
    const moof = makeBox("moof", Buffer.from("fragment-header"));
    const mdat = makeBox("mdat", Buffer.from("payload-bytes"));
    const fragment = Buffer.concat([ moof, mdat ]);

    const result = splitMoofMdat(fragment);

    assert.ok(result, "splitMoofMdat must split a moof+mdat fragment into a non-null result");
    assert.deepEqual(Buffer.from(result.moof), moof, "moof portion must be byte-equivalent to the original moof");
    assert.deepEqual(Buffer.from(result.mdat), mdat, "mdat portion must be byte-equivalent to the original mdat");

    // Zero-copy contract: both views share the fragment's backing store.
    assert.equal(result.moof.buffer, fragment.buffer);
    assert.equal(result.mdat.buffer, fragment.buffer);
  });

  test("preserves everything preceding the mdat box inside the moof portion", () => {

    // FFmpeg occasionally emits additional boxes (e.g., styp or side-table metadata) between the moof and the mdat within the same fragment. The split contract is
    // "moof portion = everything before the mdat" so any such interlopers must remain intact in the moof side of the split.
    const moof = makeBox("moof", Buffer.from("fragment"));
    const styp = makeBox("styp");
    const mdat = makeBox("mdat", Buffer.from("payload"));
    const fragment = Buffer.concat([ moof, styp, mdat ]);

    const result = splitMoofMdat(fragment);

    assert.ok(result, "splitMoofMdat must split a fragment that has interlopers between moof and mdat");
    assert.deepEqual(Buffer.from(result.moof), Buffer.concat([ moof, styp ]), "moof portion captures everything up to the mdat, including intervening boxes");
    assert.deepEqual(Buffer.from(result.mdat), mdat);
  });

  test("returns null when no mdat box is present", () => {

    // A moof without a paired mdat is not a splittable fragment. The predicate must return null so the caller can distinguish "no mdat" from "empty mdat."
    const moofOnly = makeBox("moof", Buffer.from("header-only"));

    assert.equal(splitMoofMdat(moofOnly), null);
  });

  test("returns null for an empty buffer", () => {

    assert.equal(splitMoofMdat(Buffer.alloc(0)), null);
  });
});

// The video track the fragment rows cut at: invented values, a track ID and a 90 kHz timescale.
const VIDEO: FMp4Track = { id: 1, timescale: 90000 };

// The audio track the two-track fragments carry after their video, so the rows prove the last piece takes its samples along. Its samples are invented, each as
// long as the others at an audio timescale.
const AUDIO = { samples: [ { duration: 1920, size: 7 }, { duration: 1920, size: 9 } ], trackId: 2 } as const;

// How long a reading that claims a one-step answer may take, in milliseconds. The answer itself takes well under a millisecond, and a walk of one sample at a time
// over a run that declares the largest count its field holds takes seconds, so the limit tells the two apart with room on each side.
const ONE_STEP_LIMIT = 100;

// Take a reading and assert it answered inside the one-step limit, handing back what it answered. The clock is read around the call itself, because a reader runs
// to its end without yielding, and the test runner's own timeout cannot fail a body that never yields.
function inOneStep<T>(read: () => T): T {

  const started = performance.now();
  const answer = read();

  assert.ok((performance.now() - started) < ONE_STEP_LIMIT, "the reading took longer than a one-step answer takes");

  return answer;
}

// The frames of a video run, each sample carrying its duration and its size.
function framesOf(durations: readonly number[], sizes: readonly number[]): TrunSample[] {

  return sizes.map((size, index) => ({ duration: durations[index], size }));
}

// Where the mdat's payload starts in a fragment, which is where `makeFragment` writes the video's first sample.
function payloadStartOf(fragment: Buffer): number {

  return present(findBox(fragment, "mdat"), "the fragment's mdat").offset + BOX_HEADER_SIZE;
}

// Where each video frame ends in a fragment `makeFragment` built from samples of `sizes`: the video samples open the mdat's payload, in order.
function frameEndsOf(fragment: Buffer, sizes: readonly number[]): number[] {

  const start = payloadStartOf(fragment);

  return sizes.map((_, index) => start + sizes.slice(0, index + 1).reduce((total, size) => total + size, 0));
}

// Where each piece ends, as an offset into the fragment it is a view of.
function endsOf(pieces: readonly PacedChunk[], fragment: Buffer): number[] {

  return pieces.map(({ bytes }) => (bytes.byteOffset - fragment.byteOffset) + bytes.length);
}

/* A fragment no producer writes, for a row that breaks a rule `makeFragment`'s layout keeps: one track fragment holding the boxes `children` answers for the data
 * offset of the mdat's first payload byte, and an mdat holding `payload`. The data offset is a fixed-width field, so one sizing pass places it.
 */
function malformedOf(children: (dataOffset: number) => Buffer[], payload: Buffer): Buffer {

  const moofOf = (dataOffset: number): Buffer => makeContainer("moof", [makeContainer("traf", children(dataOffset))]);

  return Buffer.concat([ moofOf(moofOf(0).length + BOX_HEADER_SIZE), makeBox("mdat", payload) ]);
}

describe("splitVideoFrames", () => {

  const cases = [ [ "a single frame", [3000] ], [ "frames of near-equal durations", [ 3000, 3003 ] ],
    [ "frames of uneven durations", [ 3003, 2997, 3000, 6006, 1500 ] ] ] as const;

  for(const [ frames, durations ] of cases) {

    test("cuts a fragment of " + frames + " at each frame's end, each piece carrying its frame's duration", () => {

      const sizes = durations.map((_, index) => 20 + (index * 13));
      const fragment = makeFragment({ samples: framesOf(durations, sizes), secondTrack: AUDIO, trackId: VIDEO.id });
      const pieces = present(splitVideoFrames(fragment, VIDEO), "the fragment's pieces");

      // Every piece ends where its frame ends, except the last, which carries the rest of the fragment, the audio samples among it.
      assert.deepEqual(endsOf(pieces, fragment), [ ...frameEndsOf(fragment, sizes).slice(0, -1), fragment.length ]);
      assert.deepEqual(pieces.map(({ duration }) => duration), durations.map((ticks) => (ticks * 1000) / VIDEO.timescale));
      assert.deepEqual(Buffer.concat(pieces.map(({ bytes }) => bytes)), fragment, "the pieces join back to the fragment exactly");
    });
  }

  test("answers pieces that are views over the fragment, sharing its memory", () => {

    const sizes = [ 24, 18, 30 ];
    const fragment = makeFragment({ samples: framesOf([ 3000, 3000, 3000 ], sizes), secondTrack: AUDIO, trackId: VIDEO.id });
    const pieces = present(splitVideoFrames(fragment, VIDEO), "the fragment's pieces");
    const first = expectAt(pieces, 0, "the first piece");
    const last = expectAt(frameEndsOf(fragment, sizes), 0, "the first frame's end") - 1;

    // A write through the fragment shows through the piece only when the piece is a view of the fragment's own bytes.
    fragment[last] = 0xEE;
    assert.equal(first.bytes[first.bytes.length - 1], 0xEE);
    assert.equal(first.bytes.buffer, fragment.buffer);
  });

  test("answers a fragment in which no track fragment names the track as an empty list", () => {

    // A fragment of the audio track alone, as FFmpeg writes when the audio outlasts the video, and a fragment of the video and the audio read for a track
    // neither names.
    const audioOnly = makeFragment({ samples: AUDIO.samples, trackId: AUDIO.trackId });
    const neither = makeFragment({ samples: framesOf([ 3000, 3000, 3000 ], [ 30, 20, 10 ]), secondTrack: AUDIO, trackId: VIDEO.id });

    for(const [ fragment, track ] of [ [ audioOnly, VIDEO ], [ neither, { id: 9, timescale: 90000 } ] ] as const) {

      assert.deepEqual(splitVideoFrames(fragment, track), [], "a fragment holding none of the track's frames has nothing to cut at, and is not one the reader failed");
    }
  });

  test("takes each sample's size and duration from the track fragment header when its entry carries neither, with and without a sample description index", () => {

    for(const sampleDescriptionIndex of [ undefined, 1 ]) {

      const sizes = [ 33, 33, 33 ];
      const fragment = makeFragment({ header: { defaultSampleDuration: 3750, defaultSampleFlags: 0x01010000, defaultSampleSize: 33, sampleDescriptionIndex },
        run: { useFirstSampleFlags: true }, samples: sizes.map((size) => ({ size })), secondTrack: AUDIO, trackId: VIDEO.id });
      const pieces = present(splitVideoFrames(fragment, VIDEO), "the fragment's pieces");

      assert.deepEqual(endsOf(pieces, fragment), [ ...frameEndsOf(fragment, sizes).slice(0, -1), fragment.length ]);
      assert.deepEqual(pieces.map(({ duration }) => duration), [ 3750, 3750, 3750 ].map((ticks) => (ticks * 1000) / VIDEO.timescale));
    }
  });

  test("mixes entry sizes with a header default duration, and entry durations with a header default size", () => {

    // Sizes in the entries and the duration from the header: the layout FFmpeg writes when every frame lasts as long as the others.
    const sizes = [ 41, 17, 26 ];
    const sized = makeFragment({ header: { defaultSampleDuration: 3000, sampleDescriptionIndex: 1 }, run: { includeSize: true, useFirstSampleFlags: true },
      samples: sizes.map((size) => ({ size })), secondTrack: AUDIO, trackId: VIDEO.id });
    const sizedPieces = present(splitVideoFrames(sized, VIDEO), "the pieces of the sized fragment");

    assert.deepEqual(endsOf(sizedPieces, sized), [ ...frameEndsOf(sized, sizes).slice(0, -1), sized.length ]);
    assert.deepEqual(sizedPieces.map(({ duration }) => duration), [ 3000, 3000, 3000 ].map((ticks) => (ticks * 1000) / VIDEO.timescale));

    // Durations in the entries and the size from the header.
    const timed = makeFragment({ header: { defaultSampleSize: 29 }, run: { includeDuration: true }, samples: framesOf([ 2000, 4000 ], [ 29, 29 ]),
      secondTrack: AUDIO, trackId: VIDEO.id });
    const timedPieces = present(splitVideoFrames(timed, VIDEO), "the pieces of the timed fragment");

    assert.deepEqual(endsOf(timedPieces, timed), [ expectAt(frameEndsOf(timed, [ 29, 29 ]), 0, "the first frame's end"), timed.length ]);
    assert.deepEqual(timedPieces.map(({ duration }) => duration), [ 2000, 4000 ].map((ticks) => (ticks * 1000) / VIDEO.timescale));
  });

  test("steps over per-sample flags and composition offsets, a negative offset among them", () => {

    const sizes = [ 50, 22, 35 ];
    const fragment = makeFragment({ run: { includeCompositionOffset: true, includeDuration: true, includeSize: true, usePerSampleFlags: true }, samples: [
      { compositionOffset: 6000, duration: 3000, flags: 0x02000000, size: 50 }, { compositionOffset: -3000, duration: 3000, flags: 0x01010000, size: 22 },
      { compositionOffset: 0, duration: 3000, flags: 0x01010000, size: 35 } ], secondTrack: AUDIO, trackId: VIDEO.id });
    const pieces = present(splitVideoFrames(fragment, VIDEO), "the fragment's pieces");

    assert.deepEqual(endsOf(pieces, fragment), [ ...frameEndsOf(fragment, sizes).slice(0, -1), fragment.length ]);
    assert.deepEqual(pieces.map(({ duration }) => duration), [ 3000, 3000, 3000 ].map((ticks) => (ticks * 1000) / VIDEO.timescale));
  });

  test("cuts at whichever track it is handed, passing over the track fragments that name another", () => {

    // The audio track fragment comes second, so reaching it means passing over the video one.
    const sizes = [ 40, 40 ];
    const fragment = makeFragment({ samples: framesOf([ 3000, 3000 ], sizes), secondTrack: AUDIO, trackId: VIDEO.id });
    const audioStart = expectAt(frameEndsOf(fragment, sizes), sizes.length - 1, "the last video frame's end");
    const pieces = present(splitVideoFrames(fragment, { id: AUDIO.trackId, timescale: 48000 }), "the audio pieces");

    assert.deepEqual(endsOf(pieces, fragment), [ audioStart + 7, fragment.length ]);
    assert.deepEqual(pieces.map(({ duration }) => duration), [ 40, 40 ]);
  });

  test("answers a piece of duration zero for a frame whose duration is zero", () => {

    // A frame may last no time at all, and its piece says so, leaving the piece after it due at once.
    const sizes = [ 30, 20, 10 ];
    const durations = [ 3000, 0, 3000 ];
    const fragment = makeFragment({ samples: framesOf(durations, sizes), secondTrack: AUDIO, trackId: VIDEO.id });
    const pieces = present(splitVideoFrames(fragment, VIDEO), "the fragment's pieces");

    assert.deepEqual(endsOf(pieces, fragment), [ ...frameEndsOf(fragment, sizes).slice(0, -1), fragment.length ]);
    assert.deepEqual(pieces.map(({ duration }) => duration), durations.map((ticks) => (ticks * 1000) / VIDEO.timescale));
  });

  test("cuts a fragment with an mdat before its moof and one after it in the mdat that follows the moof", () => {

    // The frames sit where `makeFragment` placed them, moved along by the mdat in front of the moof.
    const sizes = [ 30, 20, 10 ];
    const leading = makeBox("mdat", Buffer.alloc(12));
    const inner = makeFragment({ samples: framesOf([ 3000, 3000, 3000 ], sizes), secondTrack: AUDIO, trackId: VIDEO.id });
    const fragment = Buffer.concat([ leading, inner ]);
    const pieces = present(splitVideoFrames(fragment, VIDEO), "the fragment's pieces");

    assert.deepEqual(endsOf(pieces, fragment), [ ...frameEndsOf(inner, sizes).slice(0, -1).map((end) => leading.length + end), fragment.length ]);
    assert.deepEqual(Buffer.concat(pieces.map(({ bytes }) => bytes)), fragment, "the pieces join back to the fragment exactly");
  });

  test("passes over a track fragment whose header is too short to hold a track_ID and cuts at the one after it that names the track", () => {

    // The box after the short header is as long as the track's ID, so a read past the header would take that box's size field as a track_ID naming the track and
    // look for a run where there is none.
    const track: FMp4Track = { id: 16, timescale: 90000 };
    const sizes = [ 30, 20 ];
    const passedOver = makeContainer("traf", [ makeBox("tfhd", Buffer.from([ 0x00, 0x02, 0x00, 0x00 ])), makeBox("tfdt", Buffer.alloc(track.id - BOX_HEADER_SIZE)) ]);
    const moofOf = (dataOffset: number): Buffer => makeContainer("moof", [ passedOver, makeContainer("traf", [ makeTfhdBox({ trackId: track.id }),
      makeTrunBox({ dataOffset, includeDuration: true, includeSize: true, samples: framesOf([ 3000, 3000 ], sizes) }) ]) ]);
    const fragment = Buffer.concat([ moofOf(moofOf(0).length + BOX_HEADER_SIZE), makeBox("mdat", Buffer.alloc(50)) ]);
    const pieces = present(splitVideoFrames(fragment, track), "the fragment's pieces");

    assert.deepEqual(endsOf(pieces, fragment), [ ...frameEndsOf(fragment, sizes).slice(0, -1), fragment.length ]);
  });

  describe("answers null", () => {

    const sizes = [ 30, 20, 10 ];
    const samples = framesOf([ 3000, 3000, 3000 ], sizes);
    const entries = { includeDuration: true, includeSize: true, useFirstSampleFlags: true } as const;

    test("when the fragment has no moof, or no mdat after its moof", () => {

      const fragment = makeFragment({ samples, secondTrack: AUDIO, trackId: VIDEO.id });
      const moof = present(findBox(fragment, "moof"), "the fragment's moof");
      const mdat = present(findBox(fragment, "mdat"), "the fragment's mdat");

      assert.equal(splitVideoFrames(fragment.subarray(mdat.offset), VIDEO), null);
      assert.equal(splitVideoFrames(fragment.subarray(0, moof.size), VIDEO), null);
      assert.equal(splitVideoFrames(Buffer.concat([ fragment.subarray(mdat.offset), fragment.subarray(0, moof.size) ]), VIDEO), null);
    });

    test("when the track fragment's header does not set default-base-is-moof, or carries a base data offset", () => {

      assert.equal(splitVideoFrames(makeFragment({ header: { defaultBaseIsMoof: false }, samples, secondTrack: AUDIO, trackId: VIDEO.id }), VIDEO), null);
      assert.equal(splitVideoFrames(makeFragment({ header: { baseDataOffset: 0 }, samples, secondTrack: AUDIO, trackId: VIDEO.id }), VIDEO), null);
    });

    test("when the track fragment's header is too short for a field its flags announce", () => {

      // The header names the track and announces a default duration and a default size but holds only the duration. The run after it points at the mdat's payload,
      // so a read past the header would take the run's own size field as the default size and find a frame that fits.
      const tfhd = makeBox("tfhd", Buffer.concat([ Buffer.from([ 0x00, 0x02, 0x00, 0x18 ]), Buffer.from([ 0, 0, 0, VIDEO.id ]), Buffer.alloc(4) ]));

      assert.equal(splitVideoFrames(malformedOf((dataOffset) => [ tfhd, makeTrunBox({ dataOffset, samples: [{}] }) ], Buffer.alloc(32)), VIDEO), null);
    });

    test("when the video track fragment holds no run, or more than one", () => {

      const tfhd = makeTfhdBox({ trackId: VIDEO.id });

      assert.equal(splitVideoFrames(malformedOf(() => [tfhd], Buffer.alloc(60)), VIDEO), null);
      assert.equal(splitVideoFrames(malformedOf((dataOffset) => [ tfhd, makeTrunBox({ ...entries, dataOffset, samples }),
        makeTrunBox({ includeSize: true, samples: [{ size: 1 }] }) ], Buffer.alloc(61)), VIDEO), null);
    });

    test("when the run carries no data offset", () => {

      assert.equal(splitVideoFrames(makeFragment({ run: { ...entries, includeDataOffset: false }, samples, secondTrack: AUDIO, trackId: VIDEO.id }), VIDEO), null);
    });

    test("when the run declares no samples", () => {

      assert.equal(splitVideoFrames(makeFragment({ header: { defaultSampleDuration: 3000, defaultSampleSize: 30 }, run: {}, samples: [], trackId: VIDEO.id }), VIDEO),
        null);
    });

    test("when the run's entries run past its box", () => {

      const tfhd = makeTfhdBox({ defaultSampleDuration: 3000, trackId: VIDEO.id });

      assert.equal(splitVideoFrames(malformedOf((dataOffset) => [ tfhd, makeTrunBox({ ...entries, dataOffset, sampleCount: 4, samples }) ], Buffer.alloc(76)),
        VIDEO), null);

      // The run declares a fourth size it does not hold, the box after it begins with a size field of 8, and the payload holds room past the frames the run does
      // hold, so reading past the run would find a frame that fits.
      assert.equal(splitVideoFrames(malformedOf((dataOffset) => [ tfhd, makeTrunBox({ dataOffset, includeSize: true, sampleCount: 4, samples }), makeBox("free") ],
        Buffer.alloc(76)), VIDEO), null);
    });

    test("when a sample's size or duration is neither in its entry nor a header default", () => {

      const timedOnly = makeFragment({ header: { defaultSampleDuration: 3000 }, run: { includeDuration: true }, samples, secondTrack: AUDIO, trackId: VIDEO.id });

      assert.equal(splitVideoFrames(timedOnly, VIDEO), null);

      const sizedOnly = makeFragment({ header: { defaultSampleSize: 30 }, run: { includeSize: true }, samples, secondTrack: AUDIO, trackId: VIDEO.id });

      assert.equal(splitVideoFrames(sizedOnly, VIDEO), null);
    });

    test("when a sample is empty", () => {

      assert.equal(splitVideoFrames(makeFragment({ samples: framesOf([ 3000, 3000, 3000 ], [ 30, 0, 10 ]), secondTrack: AUDIO, trackId: VIDEO.id }), VIDEO), null);

      // A run whose every size is a zero default declares as many frames as its count field holds, every one of them fitting in any payload.
      assert.equal(splitVideoFrames(malformedOf((dataOffset) => [ makeTfhdBox({ defaultSampleDuration: 3000, defaultSampleSize: 0, trackId: VIDEO.id }),
        makeTrunBox({ dataOffset, sampleCount: 0xFFFFFFFF, samples: [] }) ], Buffer.alloc(0)), VIDEO), null);
    });

    test("when a frame lies outside the payload of the mdat that follows the moof", () => {

      // A data offset is a fixed-width field, so a fragment built with another one places every box and sample where this one does.
      const start = payloadStartOf(makeFragment({ samples, secondTrack: AUDIO, trackId: VIDEO.id }));

      // The first frame starting inside the mdat's header, or before the moof's start.
      assert.equal(splitVideoFrames(makeFragment({ dataOffset: start - 1, samples, secondTrack: AUDIO, trackId: VIDEO.id }), VIDEO), null);
      assert.equal(splitVideoFrames(makeFragment({ dataOffset: -16, samples, secondTrack: AUDIO, trackId: VIDEO.id }), VIDEO), null);

      // The last frame ending past the mdat's end: in a fragment of the video alone, frames that start a byte late end a byte past the payload.
      const alone = payloadStartOf(makeFragment({ samples, trackId: VIDEO.id }));

      assert.equal(splitVideoFrames(makeFragment({ dataOffset: alone + 1, samples, trackId: VIDEO.id }), VIDEO), null);
    });

    test("when a frame runs past its mdat into a box that follows it", () => {

      // In a fragment of the video alone, frames that start a byte late end a byte past the mdat, inside the box after it, so a frame bounded by the fragment's
      // end rather than the mdat's would fit.
      const alone = payloadStartOf(makeFragment({ samples, trackId: VIDEO.id }));
      const fragment = Buffer.concat([ makeFragment({ dataOffset: alone + 1, samples, trackId: VIDEO.id }), makeBox("free", Buffer.alloc(4)) ]);

      assert.equal(splitVideoFrames(fragment, VIDEO), null);
    });
  });
});

describe("findVideoTrack", () => {

  // The audio track every segment here holds ahead of its video tracks, so the walk passes over a track of another handler first.
  const AUDIO_TRACK: InitSegmentTrack = { handler: HDLR_TYPE_SOUN, id: 2, timescale: 48000 };

  /* A segment holding the audio track and then a video track built from the `tkhd` and `mdhd` given, for a row that needs a box `makeInitSegment` does not write:
   * one renamed, cut short or of a version above 1.
   */
  function initWithBoxes({ mdhd, tkhd }: { mdhd: Buffer; tkhd: Buffer }): Buffer {

    const audio = makeContainer("trak", [ makeTkhdBox({ trackId: AUDIO_TRACK.id }),
      makeContainer("mdia", [ makeMdhdBox({ timescale: AUDIO_TRACK.timescale }), makeHdlrBox(HDLR_TYPE_SOUN) ]) ]);
    const video = makeContainer("trak", [ tkhd, makeContainer("mdia", [ mdhd, makeHdlrBox(HDLR_TYPE_VIDE) ]) ]);

    return Buffer.concat([ makeBox("ftyp", Buffer.from("isomiso5")), makeContainer("moov", [ makeBox("mvhd", Buffer.alloc(100)), audio, video ]) ]);
  }

  // A box with its version byte rewritten, for a version no builder writes.
  function versioned(box: Buffer, version: number): Buffer {

    const copy = Buffer.from(box);

    copy.writeUInt8(version, 8);

    return copy;
  }

  test("reads the video track's ID and timescale from boxes at version 0", () => {

    assert.deepEqual(findVideoTrack(makeInitSegment([ AUDIO_TRACK, { handler: HDLR_TYPE_VIDE, id: 1, timescale: 90000 } ])), { id: 1, timescale: 90000 });
  });

  test("reads the video track's ID and timescale from boxes at version 1, and from boxes at mixed versions", () => {

    assert.deepEqual(findVideoTrack(makeInitSegment([ AUDIO_TRACK, { handler: HDLR_TYPE_VIDE, id: 7, mdhdVersion: 1, timescale: 15360, tkhdVersion: 1 } ])),
      { id: 7, timescale: 15360 });
    assert.deepEqual(findVideoTrack(makeInitSegment([ AUDIO_TRACK, { handler: HDLR_TYPE_VIDE, id: 3, timescale: 30000, tkhdVersion: 1 } ])), { id: 3, timescale: 30000 });
  });

  test("answers the first video track, and reads it from a header followed by fragments", () => {

    const init = makeInitSegment([ AUDIO_TRACK, { handler: HDLR_TYPE_VIDE, id: 4, timescale: 90000 }, { handler: HDLR_TYPE_VIDE, id: 5, timescale: 1000 } ]);

    assert.deepEqual(findVideoTrack(init), { id: 4, timescale: 90000 });
    assert.deepEqual(findVideoTrack(Buffer.concat([ init, makeFragment({ samples: framesOf([ 1, 1 ], [ 10, 10 ]), trackId: 4 }) ])), { id: 4, timescale: 90000 });
  });

  test("answers null when the segment has no video track", () => {

    assert.equal(findVideoTrack(makeInitSegment([AUDIO_TRACK])), null);
  });

  test("answers null for a tkhd or an mdhd of a version above 1", () => {

    assert.equal(findVideoTrack(initWithBoxes({ mdhd: makeMdhdBox({ timescale: 90000 }), tkhd: versioned(makeTkhdBox({ trackId: 1, version: 1 }), 2) })), null);
    assert.equal(findVideoTrack(initWithBoxes({ mdhd: versioned(makeMdhdBox({ timescale: 90000, version: 1 }), 2), tkhd: makeTkhdBox({ trackId: 1 }) })), null);
  });

  test("answers null for a tkhd or an mdhd that is missing or too short", () => {

    const mdhd = makeMdhdBox({ timescale: 90000 });
    const tkhd = makeTkhdBox({ trackId: 1 });

    assert.equal(findVideoTrack(initWithBoxes({ mdhd, tkhd: makeBox("free", tkhd.subarray(8)) })), null);
    assert.equal(findVideoTrack(initWithBoxes({ mdhd: makeBox("free", mdhd.subarray(8)), tkhd })), null);

    // Each short box holds a whole fullbox header but is cut before its field, and the one marked with the wider layout is cut where the narrower layout's field
    // would end.
    assert.equal(findVideoTrack(initWithBoxes({ mdhd, tkhd: makeBox("tkhd", Buffer.alloc(15)) })), null);
    assert.equal(findVideoTrack(initWithBoxes({ mdhd: makeBox("mdhd", Buffer.alloc(15)), tkhd })), null);
    assert.equal(findVideoTrack(initWithBoxes({ mdhd, tkhd: makeBox("tkhd", Buffer.from([ 1, ...Buffer.alloc(15) ])) })), null);
    assert.equal(findVideoTrack(initWithBoxes({ mdhd, tkhd: makeBox("tkhd", Buffer.alloc(3)) })), null);
  });

  test("answers null for a timescale of zero", () => {

    assert.equal(findVideoTrack(makeInitSegment([ AUDIO_TRACK, { handler: HDLR_TYPE_VIDE, id: 1, timescale: 0 } ])), null);
  });
});

describe("findKeyframe", () => {

  const NON_SYNC = SAMPLE_FLAG_NON_SYNC;
  const entries = { includeDuration: true, includeSize: true } as const;
  const flagged = { ...entries, usePerSampleFlags: true } as const;
  const tfhd = makeTfhdBox({ trackId: VIDEO.id });

  // Every row reads its answer through here, so each also proves that isKeyframe answers whether findKeyframe found a keyframe, for the same input and track.
  function keyframeOf(segment: Buffer, track?: FMp4Track): Nullable<number> {

    const index = findKeyframe(segment, track);

    assert.equal(isKeyframe(segment, track), index !== null, "isKeyframe answers whether findKeyframe found a keyframe");

    return index;
  }

  // A moof of one track fragment holding the boxes given, for a row that lays out runs of its own. The keyframe readers read no mdat, so none follows.
  function moofOf(children: Buffer[]): Buffer {

    return makeContainer("moof", [makeContainer("traf", children)]);
  }

  // Samples whose entries state the flags given, in order.
  function flaggedOf(flags: readonly number[]): TrunSample[] {

    return flags.map((value) => ({ duration: 3000, flags: value, size: 10 }));
  }

  test("answers zero for a fragment whose first sample states a keyframe", () => {

    const fragment = makeFragment({ samples: framesOf([ 3000, 3000 ], [ 30, 20 ]), secondTrack: AUDIO, trackId: VIDEO.id });

    assert.equal(keyframeOf(fragment), 0);
    assert.equal(keyframeOf(fragment, VIDEO), 0);
  });

  test("answers a later sample's index from the flags its entry states, a run's first-sample flags standing in for its first entry's", () => {

    assert.equal(keyframeOf(makeFragment({ run: flagged, samples: flaggedOf([ NON_SYNC, NON_SYNC, 0, NON_SYNC ]), trackId: VIDEO.id })), 2);

    // The first entry's flags mark a keyframe, but the first sample takes the run's first-sample flags, which do not.
    assert.equal(keyframeOf(makeFragment({ run: { ...flagged, sampleFlagsValue: NON_SYNC, useFirstSampleFlags: true }, samples: flaggedOf([ 0, NON_SYNC, 0 ]),
      trackId: VIDEO.id })), 2);
  });

  test("answers a sample's index from the track fragment header's default when its run states no flags for it", () => {

    const samples = framesOf([ 3000, 3000, 3000 ], [ 30, 20, 10 ]);
    const behindFirst = { ...entries, sampleFlagsValue: NON_SYNC, useFirstSampleFlags: true } as const;

    assert.equal(keyframeOf(makeFragment({ header: { defaultSampleFlags: 0 }, run: behindFirst, samples, trackId: VIDEO.id })), 1);
    assert.equal(keyframeOf(makeFragment({ header: { defaultSampleFlags: 0 }, run: entries, samples, trackId: VIDEO.id })), 0);
    assert.equal(keyframeOf(makeFragment({ header: { defaultSampleFlags: NON_SYNC }, run: entries, samples, trackId: VIDEO.id })), null);

    // The default covers only a sample whose flags its run states nowhere: a run of one sample whose first-sample flags mark no keyframe, and entries that state
    // their own flags, each leave it unread.
    assert.equal(keyframeOf(makeFragment({ header: { defaultSampleFlags: 0 }, run: behindFirst, samples: samples.slice(0, 1), trackId: VIDEO.id })), null);
    assert.equal(keyframeOf(makeFragment({ header: { defaultSampleFlags: 0 }, run: flagged, samples: flaggedOf([ NON_SYNC, NON_SYNC ]), trackId: VIDEO.id })), null);
  });

  test("counts samples across every run of the track fragment, in order", () => {

    const leading = makeTrunBox({ samples: flaggedOf([ NON_SYNC, NON_SYNC ]), usePerSampleFlags: true });

    assert.equal(keyframeOf(moofOf([ tfhd, leading, makeTrunBox({ samples: [{}], useFirstSampleFlags: true }) ])), 2);
    assert.equal(keyframeOf(moofOf([ tfhd, leading, makeTrunBox({ samples: flaggedOf([ NON_SYNC, 0 ]), usePerSampleFlags: true }) ])), 3);
    assert.equal(keyframeOf(moofOf([ makeTfhdBox({ defaultSampleFlags: 0, trackId: VIDEO.id }), leading, makeTrunBox({ samples: [ {}, {} ] }) ])), 2);
  });

  test("answers null when no sample is a keyframe, when the segment has no moof, and when its track fragment holds no run", () => {

    assert.equal(keyframeOf(makeFragment({ run: flagged, samples: flaggedOf([ NON_SYNC, NON_SYNC, NON_SYNC ]), trackId: VIDEO.id })), null);
    assert.equal(keyframeOf(Buffer.concat([ makeBox("ftyp"), makeBox("mdat") ])), null);
    assert.equal(keyframeOf(moofOf([tfhd])), null);
  });

  test("with a track, reads the track fragment that names it, past a first track fragment of audio whose first sample is a sync sample", () => {

    const segment = makeContainer("moof", [ makeContainer("traf", [ makeTfhdBox({ trackId: AUDIO.trackId }), makeTrunBox({ samples: [{}], useFirstSampleFlags: true }) ]),
      makeContainer("traf", [ tfhd, makeTrunBox({ samples: flaggedOf([ NON_SYNC, NON_SYNC, 0 ]), usePerSampleFlags: true }) ]) ]);

    assert.equal(keyframeOf(segment, VIDEO), 2);
    assert.equal(keyframeOf(segment), 0, "without a track, the first track fragment is read");
  });

  test("with a track, answers null when no track fragment names it", () => {

    assert.equal(keyframeOf(makeFragment({ samples: framesOf([ 3000, 3000 ], [ 30, 20 ]), secondTrack: AUDIO, trackId: VIDEO.id }), { id: 9, timescale: 90000 }), null);
  });

  test("answers a keyframe's index ahead of entries the run's box does not hold, and null once the walk reaches one", () => {

    assert.equal(keyframeOf(moofOf([ tfhd, makeTrunBox({ sampleCount: 5, samples: flaggedOf([ NON_SYNC, NON_SYNC, 0 ]), usePerSampleFlags: true }) ])), 2);

    // The box after the run opens with its size, which reads as a keyframe's flags, so a walk reading past the run's box would find one there.
    assert.equal(keyframeOf(moofOf([ tfhd, makeTrunBox({ sampleCount: 4, samples: flaggedOf([ NON_SYNC, NON_SYNC, NON_SYNC ]), usePerSampleFlags: true }),
      makeBox("free", Buffer.alloc(4)) ])), null);
  });

  test("answers zero for sync first-sample flags under a header announcing a default it does not hold, and reads no default from that header", () => {

    // The header announces default sample flags and ends at its track_ID. The run after it opens with its size, which reads as a keyframe's flags, so a read of the
    // default past the header's end would find one.
    const short = makeBox("tfhd", Buffer.from([ 0x00, 0x02, 0x00, 0x20, 0x00, 0x00, 0x00, VIDEO.id ]));

    assert.equal(keyframeOf(moofOf([ short, makeTrunBox({ samples: [ {}, {} ], useFirstSampleFlags: true }) ])), 0);
    assert.equal(keyframeOf(moofOf([ short, makeTrunBox({ sampleFlagsValue: NON_SYNC, samples: [ {}, {}, {} ], useFirstSampleFlags: true }) ])), null);
  });

  test("answers null without throwing for a run stating no flags under a header that holds nothing past its box header and ends the buffer", () => {

    // The header follows the run and holds neither flags nor a track_ID, and nothing follows it, so a read of its flags would run past the buffer.
    const segment = moofOf([ makeTrunBox({ samples: [ {}, {} ] }), makeBox("tfhd") ]);

    assert.equal(segment.length, present(findBox(segment, "moof"), "the moof").size, "the moof ends the buffer");
    assert.equal(keyframeOf(segment), null);
  });

  test("answers a run that declares the largest count its field holds and lists no entry fields in one step", () => {

    // A walk of one sample at a time would take billions of steps to answer these, which the one-step limit does not allow.
    const huge = makeTrunBox({ sampleCount: 0xFFFFFFFF, sampleFlagsValue: NON_SYNC, samples: [], useFirstSampleFlags: true });
    const answeredByDefault = moofOf([ makeTfhdBox({ defaultSampleFlags: 0, trackId: VIDEO.id }), huge ]);
    const answeredPastTheRun = moofOf([ makeTfhdBox({ defaultSampleFlags: NON_SYNC, trackId: VIDEO.id }), huge,
      makeTrunBox({ samples: [{}], useFirstSampleFlags: true }) ]);

    assert.equal(inOneStep(() => keyframeOf(answeredByDefault)), 1);
    assert.equal(inOneStep(() => keyframeOf(answeredPastTheRun)), 0xFFFFFFFF);
  });

  test("adds nothing to the index for a run that declares no samples, and finds no keyframe in one past the first run", () => {

    const later = makeTrunBox({ samples: flaggedOf([ NON_SYNC, 0 ]), usePerSampleFlags: true });

    assert.equal(keyframeOf(moofOf([ tfhd, makeTrunBox({ samples: [] }), later ])), 1);
    assert.equal(keyframeOf(moofOf([ tfhd, makeTrunBox({ sampleFlagsValue: NON_SYNC, samples: [], useFirstSampleFlags: true }),
      makeTrunBox({ samples: [{}], useFirstSampleFlags: true }) ])), 0);

    // A default covers declared samples alone, and a later run of no samples holds none to be a keyframe, whatever its first-sample flags say.
    assert.equal(keyframeOf(moofOf([ makeTfhdBox({ defaultSampleFlags: 0, trackId: VIDEO.id }), makeTrunBox({ samples: [] }) ])), null);
    assert.equal(keyframeOf(moofOf([ tfhd, makeTrunBox({ samples: flaggedOf([NON_SYNC]), usePerSampleFlags: true }),
      makeTrunBox({ samples: [], useFirstSampleFlags: true }) ])), null);
  });

  test("reads a track fragment only inside the moof, and a header only inside its track fragment", () => {

    const keyframes = makeContainer("traf", [ tfhd, makeTrunBox({ samples: [{}], useFirstSampleFlags: true }) ]);

    // A track fragment that follows the moof, and one in a buffer that holds no moof, are not the moof's.
    assert.equal(keyframeOf(Buffer.concat([ makeContainer("moof", [makeBox("mfhd", Buffer.alloc(8))]), keyframes ])), null);
    assert.equal(keyframeOf(Buffer.concat([ makeBox("ftyp"), keyframes ])), null);

    // A header that follows the track fragment is not its header, so its default flags mark no keyframe in a run that states none.
    assert.equal(keyframeOf(makeContainer("moof", [ makeContainer("traf", [makeTrunBox({ samples: [ {}, {} ] })]),
      makeTfhdBox({ defaultSampleFlags: 0, trackId: VIDEO.id }) ])), null);
  });
});

describe("startsWithKeyframe", () => {

  const NON_SYNC = SAMPLE_FLAG_NON_SYNC;
  const flagged = { includeDuration: true, includeSize: true, usePerSampleFlags: true } as const;

  // Samples whose entries state each pair's duration and flags, in order, every sample of one invented size.
  function samplesOf(pairs: readonly (readonly [ number, number ])[]): TrunSample[] {

    return pairs.map(([ duration, flags ]) => ({ duration, flags, size: 10 }));
  }

  test("answers true for a fragment whose first sample is a keyframe, stated by its run's first-sample flags or by its entry's flags", () => {

    const fragment = makeFragment({ samples: framesOf([ 3000, 3000 ], [ 30, 20 ]), secondTrack: AUDIO, trackId: VIDEO.id });

    assert.equal(startsWithKeyframe(fragment), true);
    assert.equal(startsWithKeyframe(fragment, VIDEO), true);
    assert.equal(startsWithKeyframe(makeFragment({ run: flagged, samples: samplesOf([ [ 3000, 0 ], [ 3000, NON_SYNC ] ]), trackId: VIDEO.id })), true);
  });

  test("answers false for a fragment that holds no keyframe, even one whose every sample lasts no time, and for a buffer with no moof", () => {

    assert.equal(startsWithKeyframe(makeFragment({ run: flagged, samples: samplesOf([ [ 0, NON_SYNC ], [ 0, NON_SYNC ] ]), trackId: VIDEO.id })), false);
    assert.equal(startsWithKeyframe(Buffer.concat([ makeBox("ftyp"), makeBox("mdat") ])), false);
  });

  test("answers true when samples of zero duration, flagged non-sync, are all that stand ahead of the keyframe", () => {

    const one = makeFragment({ run: flagged, samples: samplesOf([ [ 0, NON_SYNC ], [ 3000, 0 ], [ 3000, NON_SYNC ] ]), trackId: VIDEO.id });
    const several = makeFragment({ run: flagged, samples: samplesOf([ [ 0, NON_SYNC ], [ 0, NON_SYNC ], [ 0, NON_SYNC ], [ 3000, 0 ] ]), trackId: VIDEO.id });

    assert.equal(findKeyframe(one), 1);
    assert.equal(startsWithKeyframe(one), true);
    assert.equal(findKeyframe(several), 3);
    assert.equal(startsWithKeyframe(several), true);
  });

  test("answers false when a sample ahead of the keyframe states a duration other than zero", () => {

    assert.equal(startsWithKeyframe(makeFragment({ run: flagged, samples: samplesOf([ [ 3000, NON_SYNC ], [ 3000, 0 ] ]), trackId: VIDEO.id })), false);

    // The first sample ahead of the keyframe lasts no time, and the one after it does.
    assert.equal(startsWithKeyframe(makeFragment({ run: flagged, samples: samplesOf([ [ 0, NON_SYNC ], [ 3000, NON_SYNC ], [ 3000, 0 ] ]), trackId: VIDEO.id })),
      false);
  });

  test("answers true for a first sample of zero duration that is itself a keyframe", () => {

    const fragment = makeFragment({ run: flagged, samples: samplesOf([ [ 0, 0 ], [ 3000, NON_SYNC ] ]), trackId: VIDEO.id });

    assert.equal(findKeyframe(fragment), 0);
    assert.equal(startsWithKeyframe(fragment), true);
  });

  test("reads the header's default duration for a run whose entries carry none: zero answers true, any other value false, and none false", () => {

    // The entries carry each sample's size and flags, the second sample is the keyframe, and the header alone can state a duration.
    const fragmentOf = (header: { defaultSampleDuration?: number }): Buffer => makeFragment({ header, run: { includeSize: true, usePerSampleFlags: true },
      samples: [ { flags: NON_SYNC, size: 12 }, { flags: 0, size: 30 } ], trackId: VIDEO.id });

    assert.equal(findKeyframe(fragmentOf({})), 1);
    assert.equal(startsWithKeyframe(fragmentOf({ defaultSampleDuration: 0 })), true);
    assert.equal(startsWithKeyframe(fragmentOf({ defaultSampleDuration: 3000 })), false);
    assert.equal(startsWithKeyframe(fragmentOf({})), false);
  });

  test("reads the samples ahead of the keyframe in every run before the keyframe's own", () => {

    // A run whose entries state the durations given and mark no keyframe, then a run whose first sample is the keyframe.
    const segmentOf = (durations: readonly number[]): Buffer => makeContainer("moof", [makeContainer("traf", [ makeTfhdBox({ trackId: VIDEO.id }),
      makeTrunBox({ includeDuration: true, samples: samplesOf(durations.map((duration) => [ duration, NON_SYNC ] as const)), usePerSampleFlags: true }),
      makeTrunBox({ samples: [{}], useFirstSampleFlags: true }) ])]);

    assert.equal(findKeyframe(segmentOf([ 0, 0 ])), 2);
    assert.equal(startsWithKeyframe(segmentOf([ 0, 0 ])), true);
    assert.equal(startsWithKeyframe(segmentOf([ 0, 3000 ])), false);

    // A run whose one sample lasts no time, then the keyframe's own run with a sample ahead of the keyframe, so the walk has samples left to read past the first run.
    const acrossOf = (duration: number): Buffer => makeContainer("moof", [makeContainer("traf", [ makeTfhdBox({ trackId: VIDEO.id }),
      makeTrunBox({ includeDuration: true, samples: samplesOf([[ 0, NON_SYNC ]]), usePerSampleFlags: true }),
      makeTrunBox({ includeDuration: true, samples: samplesOf([ [ duration, NON_SYNC ], [ 3000, 0 ] ]), usePerSampleFlags: true }) ])]);

    assert.equal(findKeyframe(acrossOf(0)), 2);
    assert.equal(startsWithKeyframe(acrossOf(0)), true);
    assert.equal(startsWithKeyframe(acrossOf(3000)), false);
  });

  test("reads a track fragment's first header for its defaults, with a track and without one", () => {

    // Each track fragment holds a header ahead of its run and another behind it. The run states its first sample as no keyframe and nothing else, so the second
    // sample's flags and the first sample's duration each come from a header's default.
    const segmentOf = (first: Parameters<typeof makeTfhdBox>[0], last: Parameters<typeof makeTfhdBox>[0]): Buffer => makeContainer("moof", [makeContainer("traf",
      [ makeTfhdBox(first), makeTrunBox({ sampleFlagsValue: NON_SYNC, samples: [ {}, {} ], useFirstSampleFlags: true }), makeTfhdBox(last) ])]);
    const flags = segmentOf({ defaultSampleDuration: 0, defaultSampleFlags: 0, trackId: VIDEO.id },
      { defaultSampleDuration: 0, defaultSampleFlags: NON_SYNC, trackId: VIDEO.id });
    const durations = segmentOf({ defaultSampleDuration: 0, defaultSampleFlags: 0, trackId: VIDEO.id },
      { defaultSampleDuration: 3000, defaultSampleFlags: 0, trackId: VIDEO.id });

    for(const track of [ undefined, VIDEO ]) {

      assert.equal(findKeyframe(flags, track), 1);
      assert.equal(startsWithKeyframe(durations, track), true);
    }
  });

  test("passes over a run ahead of the keyframe that declares no samples, which leaves no duration to read", () => {

    // The first run declares no samples and carries no entry fields, under a header that states no default duration, and the second states its own.
    const segment = makeContainer("moof", [makeContainer("traf", [ makeTfhdBox({ trackId: VIDEO.id }), makeTrunBox({ samples: [] }),
      makeTrunBox({ includeDuration: true, samples: samplesOf([ [ 0, NON_SYNC ], [ 3000, 0 ] ]), usePerSampleFlags: true }) ])]);

    assert.equal(findKeyframe(segment), 1);
    assert.equal(startsWithKeyframe(segment), true);
  });

  test("with a track, reads the track fragment that names it, past another track's fragment standing first", () => {

    // Each track fragment holds a sample ahead of its keyframe: the audio one lasts, and the video one lasts no time.
    const audio = makeContainer("traf", [ makeTfhdBox({ trackId: AUDIO.trackId }),
      makeTrunBox({ includeDuration: true, samples: samplesOf([ [ 1920, NON_SYNC ], [ 1920, 0 ] ]), usePerSampleFlags: true }) ]);
    const video = makeContainer("traf", [ makeTfhdBox({ trackId: VIDEO.id }),
      makeTrunBox({ includeDuration: true, samples: samplesOf([ [ 0, NON_SYNC ], [ 3000, 0 ] ]), usePerSampleFlags: true }) ]);
    const segment = makeContainer("moof", [ audio, video ]);

    assert.equal(findKeyframe(segment, VIDEO), 1);
    assert.equal(startsWithKeyframe(segment, VIDEO), true);
    assert.equal(startsWithKeyframe(segment), false, "without a track, the first track fragment is read");
  });

  test("answers false when a duration field ahead of the keyframe lies past its run's box", () => {

    // The run carries per-sample durations and no entry flags, and its box ends before its entries. Its first-sample flags mark no keyframe and the header's default
    // flags mark one, so findKeyframe answers the second sample without reading an entry. Zero bytes as wide as a duration field follow the run inside its track
    // fragment, so a read past the run's box would find a duration of zero there.
    const segment = makeContainer("moof", [makeContainer("traf", [ makeTfhdBox({ defaultSampleFlags: 0, trackId: VIDEO.id }),
      makeTrunBox({ includeDuration: true, sampleCount: 2, sampleFlagsValue: NON_SYNC, samples: [], useFirstSampleFlags: true }), Buffer.alloc(4) ])]);

    assert.equal(findKeyframe(segment), 1);
    assert.equal(startsWithKeyframe(segment), false);
  });

  test("reads a duration field that ends its run's box", () => {

    // The first run's one entry is a duration alone, the last bytes of its box, under first-sample flags that mark no keyframe, and the next run's first sample is
    // the keyframe.
    const segment = makeContainer("moof", [makeContainer("traf", [ makeTfhdBox({ trackId: VIDEO.id }),
      makeTrunBox({ includeDuration: true, sampleFlagsValue: NON_SYNC, samples: [{ duration: 0 }], useFirstSampleFlags: true }),
      makeTrunBox({ samples: [{}], useFirstSampleFlags: true }) ])]);

    assert.equal(findKeyframe(segment), 1);
    assert.equal(startsWithKeyframe(segment), true);
  });

  test("answers true in one step for a run ahead of the keyframe that declares the largest count its field holds and lists no entry fields", () => {

    // Every sample of the first run takes the header's zero duration and non-sync flags, and a walk of one sample at a time would take billions of steps to answer,
    // which the one-step limit does not allow.
    const segment = makeContainer("moof", [makeContainer("traf", [ makeTfhdBox({ defaultSampleDuration: 0, defaultSampleFlags: NON_SYNC, trackId: VIDEO.id }),
      makeTrunBox({ sampleCount: 0xFFFFFFFF, samples: [] }), makeTrunBox({ samples: [{}], useFirstSampleFlags: true }) ])]);

    assert.equal(inOneStep(() => findKeyframe(segment)), 0xFFFFFFFF);
    assert.equal(inOneStep(() => startsWithKeyframe(segment)), true);
  });
});

describe("splitVideoFrames over FFmpeg's own fragments", { skip: !ffmpegIntegrationEnabled }, () => {

  test("splits every fragment FFmpeg writes for its own test pattern and a tone, rejoining each, numbering the frames and summing to the clip's length", async (t) => {

    // FFmpeg is located the way the options suite's integration rows locate it.
    const codecs = await FfmpegCodecs.probe({ log: silentLog() });

    assert.ok(codecs, "FfmpegCodecs.probe() must succeed for the integration row to run");

    if(!codecs.hasEncoder("h264", "libx264") || !codecs.hasEncoder("aac", "aac")) {

      t.skip("host does not advertise libx264 and the native aac encoder");

      return;
    }

    // The test pattern for a fixed count of frames at a fixed rate, and a tone that ends first so every fragment holds video. The movflags are the livestream process's,
    // with a fragment duration, and the output stays well inside the exec buffer.
    const frames = 60;
    const rate = 30;
    const { stdout } = await execFileAsync(codecs.ffmpegExec, [ "-hide_banner", "-nostats", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=size=160x120:rate=" + rate.toString(), "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.5", "-map", "0:v", "-map", "1:a",
      "-frames:v", frames.toString(), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", rate.toString(), "-c:a", "aac", "-b:a", "32k",
      "-movflags", "default_base_moof+empty_moov+frag_keyframe+skip_sidx+skip_trailer", "-frag_duration", "500000", "-f", "mp4", "pipe:1" ], { encoding: "buffer" });
    const boxes = [...new Mp4BoxParser().consume(stdout)];
    const firstMoof = boxes.findIndex(({ type }) => type === BOX_TYPE_MOOF);
    const track = present(findVideoTrack(Buffer.concat(boxes.slice(0, firstMoof).map(({ bytes }) => bytes))), "the video track of FFmpeg's header");
    const fragments: Buffer[] = [];

    for(let index = firstMoof; index < boxes.length; index += 2) {

      fragments.push(Buffer.concat([ expectAt(boxes, index, "a fragment's moof").bytes, expectAt(boxes, index + 1, "a fragment's mdat").bytes ]));
    }

    assert.ok(fragments.length > 1, "FFmpeg writes the clip as more than one fragment");

    const pieces = fragments.flatMap((fragment) => {

      const split = present(splitVideoFrames(fragment, track), "the pieces of every fragment");

      assert.deepEqual(Buffer.concat(split.map(({ bytes }) => bytes)), fragment, "each fragment's pieces rejoin it exactly");

      return split;
    });

    assert.equal(pieces.length, frames);
    assert.ok(Math.abs(pieces.reduce((total, { duration }) => total + duration, 0) - ((frames * 1000) / rate)) < (1000 / rate), "the durations sum to the clip's length");
  });
});
