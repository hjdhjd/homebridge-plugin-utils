/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/fmp4.test.ts: Unit tests for the stateless ISO BMFF (fMP4) predicates exported from fmp4.ts - findBox, isKeyframe, hasAudioTrack, and splitMoofMdat.
 *
 * These are the one-shot counterparts to the streaming `Mp4BoxParser` / `Mp4SegmentAssembler`: each predicate accepts a complete Buffer and returns a verdict. They are
 * consumed both internally (the parser reuses `BOX_HEADER_SIZE` and the assembler compares box type codes via the `BOX_TYPE_*` constants) and externally (HBUP calls
 * `isKeyframe(buffer)` directly at its timeshift boundary), so the behavioral surface here must stay stable across the parser/assembler refactor.
 */
import { HDLR_TYPE_SOUN, HDLR_TYPE_VIDE, SAMPLE_FLAG_NON_SYNC, makeBox, makeContainer, makeHdlrBox, makeTrunBox } from "./mp4.helpers.ts";
import { describe, test } from "node:test";
import { findBox, hasAudioTrack, isKeyframe, splitMoofMdat } from "./fmp4.ts";
import assert from "node:assert/strict";

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
