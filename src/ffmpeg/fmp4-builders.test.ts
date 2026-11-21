/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/fmp4-builders.test.ts: Unit tests for the ISO BMFF byte-level construction builders in fmp4-builders.ts. Builders earn the same enumerated-criteria coverage as
 * production code per the testing convention - every branch, every error path, every flag combination - because the suites that consume these builders (parser,
 * assembler, fmp4 predicate tests) silently lose their meaning if the builders themselves drift from the wire layouts they encode.
 */
import { BOX_HEADER_SIZE, HDLR_TYPE_SOUN, SAMPLE_FLAG_NON_SYNC, findBox, findVideoTrack, hasAudioTrack, splitVideoFrames } from "./fmp4.ts";
import { HDLR_TYPE_VIDE, makeBox, makeContainer, makeFragment, makeHdlrBox, makeInitSegment, makeMdhdBox, makeTfhdBox, makeTkhdBox,
  makeTrunBox } from "./fmp4-builders.ts";
import { describe, test } from "node:test";
import { expectAt, present } from "../testing/index.ts";
import assert from "node:assert/strict";

describe("makeBox", () => {

  test("emits an 8-byte header followed by the payload", () => {

    const payload = Buffer.from([ 0xDE, 0xAD, 0xBE, 0xEF ]);
    const box = makeBox("ftyp", payload);

    assert.equal(box.length, 8 + payload.length, "box length must be header (8) plus payload");
    assert.equal(box.readUInt32BE(0), 12, "size field must encode the total box length in bytes");
    assert.equal(box.subarray(4, 8).toString("ascii"), "ftyp", "type field must be the 4-character ASCII type code");
    assert.deepEqual(box.subarray(8), payload, "payload must follow the header verbatim");
  });

  test("defaults the payload to an empty Buffer when omitted", () => {

    const box = makeBox("free");

    assert.equal(box.length, 8, "no payload yields an 8-byte box (header only)");
    assert.equal(box.readUInt32BE(0), 8, "size field on an empty box is just the header length");
    assert.equal(box.subarray(4, 8).toString("ascii"), "free", "type field must still be present");
  });

  test("encodes large payloads correctly (size field is big-endian)", () => {

    // 256-byte payload + 8-byte header = 264. readUInt32BE must yield 264 not 0x08010000 (would happen if the writer used little-endian).
    const payload = Buffer.alloc(256);
    const box = makeBox("mdat", payload);

    assert.equal(box.readUInt32BE(0), 264, "size field must use big-endian encoding so multi-byte sizes read correctly downstream");
  });

  test("throws when the type code is not exactly 4 characters", () => {

    // The contract per the helper: type codes are exactly 4 ASCII characters per ISO BMFF. The assertion guards against typos like "moo" (3 chars) or "moofx" (5).
    assert.throws(() => makeBox("moo"), { message: /4 ASCII characters/ });
    assert.throws(() => makeBox("moofx"), { message: /4 ASCII characters/ });
    assert.throws(() => makeBox(""), { message: /4 ASCII characters/ });
  });
});

describe("makeContainer", () => {

  test("concatenates child boxes into a parent container's payload", () => {

    const childA = makeBox("free", Buffer.alloc(2));
    const childB = makeBox("skip", Buffer.alloc(2));
    const container = makeContainer("moov", [ childA, childB ]);

    assert.equal(container.subarray(4, 8).toString("ascii"), "moov", "container's type field must be the supplied parent type");
    assert.equal(container.length, 8 + childA.length + childB.length, "container length must be header plus the concatenated children");
    assert.deepEqual(container.subarray(8, 8 + childA.length), childA, "first child must appear in payload position");
    assert.deepEqual(container.subarray(8 + childA.length), childB, "second child must follow the first verbatim");
  });

  test("supports an empty children array (zero-payload container)", () => {

    // An empty container is structurally valid in ISO BMFF and is the natural identity element for the helper. The header must still be present.
    const container = makeContainer("moov", []);

    assert.equal(container.length, 8, "empty container must be 8 bytes (header only, no payload)");
    assert.equal(container.readUInt32BE(0), 8, "size field must reflect just the header length");
  });
});

describe("makeHdlrBox", () => {

  test("emits the standard 33-byte hdlr layout for a SOUN handler", () => {

    // Standard payload is 25 bytes (version/flags 4 + pre_defined 4 + handler_type 4 + reserved[3] 12 + name terminator 1) plus 8-byte box header = 33 bytes total.
    const hdlr = makeHdlrBox(HDLR_TYPE_SOUN);

    assert.equal(hdlr.length, 8 + 25, "standard hdlr must be 33 bytes (header + 25-byte payload)");
    assert.equal(hdlr.subarray(4, 8).toString("ascii"), "hdlr", "type field must be \"hdlr\"");

    // handler_type sits at payload offset 8 (i.e., box offset 8+8=16). The predicate hasAudioTrack reads exactly this slot.
    assert.equal(hdlr.readUInt32BE(16), HDLR_TYPE_SOUN, "handler_type slot must carry the supplied SOUN code");
  });

  test("emits a SOUN handler distinct from a VIDE handler at the handler_type slot", () => {

    // Negative-path coverage: HDLR_TYPE_VIDE is what hasAudioTrack must reject. The two helpers must produce different bytes at the handler_type slot.
    const sounHdlr = makeHdlrBox(HDLR_TYPE_SOUN);
    const videHdlr = makeHdlrBox(HDLR_TYPE_VIDE);

    assert.notEqual(sounHdlr.readUInt32BE(16), videHdlr.readUInt32BE(16), "SOUN and VIDE handlers must differ at the handler_type slot");
    assert.equal(videHdlr.readUInt32BE(16), HDLR_TYPE_VIDE, "VIDE handler must carry the VIDE code at the handler_type slot");
  });

  test("emits a truncated 16-byte hdlr when truncate=true (skips handler_type)", () => {

    // The truncate path emits a payload of exactly 8 bytes (version/flags + pre_defined), without the handler_type slot. The predicate's bounds check must reject
    // this shape, so we lock in the byte count so the negative test in the predicate suite cannot drift away from the helper's promise.
    const truncated = makeHdlrBox(HDLR_TYPE_SOUN, true);

    assert.equal(truncated.length, 8 + 8, "truncated hdlr must be exactly 16 bytes (header + 8-byte payload, no handler_type)");
    assert.equal(truncated.subarray(4, 8).toString("ascii"), "hdlr", "truncated form must still carry the \"hdlr\" type code");
  });
});

describe("makeTrunBox", () => {

  test("emits a baseline trun with sample_count=1 and the data_offset flag set", () => {

    // Every emission carries TRUN_FLAG_DATA_OFFSET (per the helper's "always include" comment). The header layout is version(0) + 24-bit flags + sample_count +
    // data_offset.
    const trun = makeTrunBox({ sampleFlagsValue: 0 });

    assert.equal(trun.subarray(4, 8).toString("ascii"), "trun", "type field must be \"trun\"");

    // version/flags is at payload offset 0; sample_count at offset 4; data_offset at offset 8.
    const versionAndFlags = trun.readUInt32BE(8);

    assert.equal(versionAndFlags & 0x00FFFFFF, 0x000001, "data_offset flag (0x000001) must be set in the low 24 bits");

    // Sample_count is at payload offset 4 (box offset 12).
    assert.equal(trun.readUInt32BE(12), 1, "sample_count must be 1 - the helper documents single-sample emission");
  });

  test("includes the first_sample_flags slot when useFirstSampleFlags=true", () => {

    // first_sample_flags is the slot isKeyframe consults when TRUN_FLAG_FIRST_SAMPLE_FLAGS is set. The helper writes the supplied sampleFlagsValue into this slot.
    const keyframe = makeTrunBox({ sampleFlagsValue: 0, useFirstSampleFlags: true });
    const nonKeyframe = makeTrunBox({ sampleFlagsValue: SAMPLE_FLAG_NON_SYNC, useFirstSampleFlags: true });

    // first_sample_flags sits at payload offset 12 (after version/flags 4 + sample_count 4 + data_offset 4) -> box offset 20.
    assert.equal(keyframe.readUInt32BE(20), 0, "keyframe first_sample_flags slot must encode 0 (sync sample)");
    assert.equal(nonKeyframe.readUInt32BE(20), SAMPLE_FLAG_NON_SYNC, "non-keyframe first_sample_flags slot must encode SAMPLE_FLAG_NON_SYNC");

    // The first-sample-flags flag bit must be set in the header.
    assert.notEqual(keyframe.readUInt32BE(8) & 0x000004, 0, "TRUN_FLAG_FIRST_SAMPLE_FLAGS (0x000004) must be set when useFirstSampleFlags=true");
  });

  test("includes the per-sample flags slot when usePerSampleFlags=true", () => {

    // The per-sample path is what isKeyframe falls back to when first_sample_flags is absent. The slot sits after the per-sample duration / size slots if those are
    // also requested; with neither requested, it sits immediately after data_offset (payload offset 12 -> box offset 20).
    const trun = makeTrunBox({ sampleFlagsValue: SAMPLE_FLAG_NON_SYNC, usePerSampleFlags: true });

    assert.equal(trun.readUInt32BE(20), SAMPLE_FLAG_NON_SYNC, "per-sample flags slot must encode the supplied value");
    assert.notEqual(trun.readUInt32BE(8) & 0x000400, 0, "TRUN_FLAG_SAMPLE_FLAGS (0x000400) must be set when usePerSampleFlags=true");
  });

  test("orders per-sample slots correctly: duration, size, flags", () => {

    // The ISO BMFF spec mandates per-sample slot order: duration (if flag set), size (if flag set), flags (if flag set). The helper emits them in this order so the
    // predicate's offset arithmetic finds them where it expects. We assert the order here by writing distinguishable values to each slot through the helper's options
    // and verifying the read-back positions.
    const sentinel = SAMPLE_FLAG_NON_SYNC;
    const trun = makeTrunBox({ includeDuration: true, includeSize: true, sampleFlagsValue: sentinel, usePerSampleFlags: true });

    // Box offsets: 8 (version/flags) -> 12 (sample_count) -> 16 (data_offset) -> 20 (duration) -> 24 (size) -> 28 (per-sample flags).
    assert.equal(trun.readUInt32BE(28), sentinel, "per-sample flags slot must follow duration and size slots in canonical order");
    assert.equal(trun.length, 8 + 8 + 4 + 4 + 4 + 4, "total length must reflect every requested optional slot");
  });

  test("sets every requested flag bit independently in the flags header", () => {

    // Coverage for each individual flag-set branch in the helper. Combine every optional flag and verify each bit is set.
    const trun = makeTrunBox({

      includeDuration: true,
      includeSize: true,
      sampleFlagsValue: 0,
      useFirstSampleFlags: true,
      usePerSampleFlags: true
    });
    const flags = trun.readUInt32BE(8) & 0x00FFFFFF;

    assert.notEqual(flags & 0x000001, 0, "data_offset flag bit must be set");
    assert.notEqual(flags & 0x000004, 0, "first_sample_flags flag bit must be set");
    assert.notEqual(flags & 0x000100, 0, "sample_duration flag bit must be set");
    assert.notEqual(flags & 0x000200, 0, "sample_size flag bit must be set");
    assert.notEqual(flags & 0x000400, 0, "sample_flags flag bit must be set");
  });

  test("omits the per-sample flags slot when truncate=true (and usePerSampleFlags=true)", () => {

    // The truncate path is the negative-test affordance for isKeyframe's "insufficient bytes" guard. With usePerSampleFlags+truncate, the box's declared size still
    // reflects only what was emitted - so the predicate reading past the end must take the bounds-check branch.
    const truncated = makeTrunBox({ includeDuration: true, sampleFlagsValue: 0, truncate: true, usePerSampleFlags: true });

    // With duration + truncate: header(8) + version/flags(4) + sample_count(4) + data_offset(4) + duration(4) = 24 bytes. No per-sample flags slot.
    assert.equal(truncated.length, 24, "truncated form must omit the per-sample flags slot");
  });

  test("does not emit per-sample slots when usePerSampleFlags=false (only first_sample_flags path)", () => {

    // With useFirstSampleFlags=true and usePerSampleFlags=false, the predicate consults first_sample_flags and never reads beyond it. The helper must not emit
    // per-sample slots in this configuration even if includeDuration / includeSize are set, because the trun would then have stale bytes the predicate ignores.
    const trun = makeTrunBox({ includeDuration: true, includeSize: true, sampleFlagsValue: 0, useFirstSampleFlags: true, usePerSampleFlags: false });

    // Expected: header(8) + version/flags(4) + sample_count(4) + data_offset(4) + first_sample_flags(4) = 24 bytes. No per-sample slots even though include flags
    // are set in the header (those slots being missing while the flags are present is a malformed-trun shape - tests that exercise that combination must do so
    // through this helper to keep the construction in one place).
    assert.equal(trun.length, 24, "first_sample_flags path must not emit per-sample slots regardless of includeDuration/includeSize");
  });
});

describe("makeTrunBox runs of samples", () => {

  test("writes one entry per sample holding the fields its flags announce, in the spec's order", () => {

    const trun = makeTrunBox({ includeCompositionOffset: true, includeDuration: true, includeSize: true, samples: [
      { compositionOffset: 6000, duration: 3000, flags: 0x02000000, size: 50 }, { compositionOffset: -3000, duration: 3003, flags: 0x01010000, size: 22 } ],
    usePerSampleFlags: true });

    // Box offsets: 8 (version/flags) -> 12 (sample_count) -> 16 (data_offset) -> 20 (the first entry), sixteen bytes to an entry.
    assert.equal(trun.readUInt32BE(8) & 0x00FFFFFF, 0x000F01, "data_offset, duration, size, flags and composition offset flag bits");
    assert.equal(trun.readUInt32BE(12), 2, "sample_count must be the number of samples");
    assert.deepEqual([ trun.readUInt32BE(20), trun.readUInt32BE(24), trun.readUInt32BE(28), trun.readInt32BE(32) ], [ 3000, 50, 0x02000000, 6000 ]);
    assert.deepEqual([ trun.readUInt32BE(36), trun.readUInt32BE(40), trun.readUInt32BE(44), trun.readInt32BE(48) ], [ 3003, 22, 0x01010000, -3000 ],
      "a negative composition offset reads back signed");
    assert.equal(trun.length, 8 + 12 + (2 * 16));
  });

  test("writes only the fields the run carries, a field a sample omits as zero, and nothing for a run that carries none", () => {

    const sized = makeTrunBox({ includeSize: true, samples: [ { size: 9 }, { duration: 77 } ] });

    assert.deepEqual([ sized.readUInt32BE(20), sized.readUInt32BE(24) ], [ 9, 0 ], "a size per entry, the duration left out");
    assert.equal(sized.length, 8 + 12 + 8);

    const bare = makeTrunBox({ samples: [ {}, {}, {} ] });

    assert.equal(bare.readUInt32BE(12), 3, "each sample is declared");
    assert.equal(bare.length, 8 + 12, "and no entry bytes at all");
  });

  test("declares the sample count it is given, which may exceed the entries it writes", () => {

    const trun = makeTrunBox({ includeSize: true, sampleCount: 5, samples: [ { size: 1 }, { size: 2 } ] });

    assert.equal(trun.readUInt32BE(12), 5);
    assert.equal(trun.length, 8 + 12 + 8, "only the entries given are written");
    assert.equal(makeTrunBox({ samples: [] }).readUInt32BE(12), 0, "an empty run declares no samples");
  });

  test("writes the data offset signed, and leaves out the field and its flag when asked", () => {

    assert.equal(makeTrunBox({ dataOffset: -8, samples: [{}] }).readInt32BE(16), -8);
    assert.equal(makeTrunBox({ dataOffset: 120 }).readInt32BE(16), 120, "the single-sample run takes the data offset too");

    const bare = makeTrunBox({ includeDataOffset: false, sampleFlagsValue: 0x00010000, useFirstSampleFlags: true });

    assert.equal(bare.readUInt32BE(8) & 0x00FFFFFF, 0x000004, "the data_offset flag is clear");
    assert.equal(bare.readUInt32BE(16), 0x00010000, "first_sample_flags follows the sample count directly");
  });

  test("sets the composition offset flag bit alone without samples", () => {

    const trun = makeTrunBox({ includeCompositionOffset: true });

    assert.equal(trun.readUInt32BE(8) & 0x00FFFFFF, 0x000801);
    assert.equal(trun.length, 8 + 12);
  });
});

describe("makeTfhdBox", () => {

  test("names the track and sets default-base-is-moof, with no optional field by default", () => {

    const tfhd = makeTfhdBox({ trackId: 3 });

    assert.equal(tfhd.subarray(4, 8).toString("ascii"), "tfhd");
    assert.equal(tfhd.readUInt32BE(8), 0x020000, "version 0 and the default-base-is-moof flag alone");
    assert.equal(tfhd.readUInt32BE(12), 3);
    assert.equal(tfhd.length, 16);
  });

  test("writes each optional field it is given in the spec's order, setting its flag", () => {

    const tfhd = makeTfhdBox({ baseDataOffset: 0x123456789, defaultSampleDuration: 3000, defaultSampleFlags: 0x01010000, defaultSampleSize: 77,
      sampleDescriptionIndex: 1, trackId: 1 });

    // Box offsets: 8 (version/flags) -> 12 (track_ID) -> 16 (base_data_offset, a 64-bit field) -> 24 (index) -> 28 (duration) -> 32 (size) -> 36 (flags).
    assert.equal(tfhd.readUInt32BE(8) & 0x00FFFFFF, 0x02003B);
    assert.equal(tfhd.readBigUInt64BE(16), 0x123456789n);
    assert.deepEqual([ tfhd.readUInt32BE(24), tfhd.readUInt32BE(28), tfhd.readUInt32BE(32), tfhd.readUInt32BE(36) ], [ 1, 3000, 77, 0x01010000 ]);
    assert.equal(tfhd.length, 40);

    // A field left out moves the ones after it up: the default size follows the track_ID directly.
    const sized = makeTfhdBox({ defaultSampleSize: 77, trackId: 1 });

    assert.equal(sized.readUInt32BE(8) & 0x00FFFFFF, 0x020010);
    assert.equal(sized.readUInt32BE(16), 77);
  });

  test("leaves default-base-is-moof clear when asked", () => {

    assert.equal(makeTfhdBox({ defaultBaseIsMoof: false, trackId: 1 }).readUInt32BE(8), 0);
  });
});

describe("makeTkhdBox and makeMdhdBox", () => {

  test("write a version 0 tkhd with its track_ID at byte 20, and a version 1 tkhd with it at byte 28", () => {

    const v0 = makeTkhdBox({ trackId: 5 });
    const v1 = makeTkhdBox({ trackId: 6, version: 1 });

    assert.equal(v0.subarray(4, 8).toString("ascii"), "tkhd");
    assert.deepEqual([ v0.length, v0.readUInt8(8), v0.readUInt32BE(20) ], [ 92, 0, 5 ]);
    assert.deepEqual([ v1.length, v1.readUInt8(8), v1.readUInt32BE(28) ], [ 104, 1, 6 ]);
  });

  test("write a version 0 mdhd with its timescale at byte 20, and a version 1 mdhd with it at byte 28", () => {

    const v0 = makeMdhdBox({ timescale: 90000 });
    const v1 = makeMdhdBox({ timescale: 15360, version: 1 });

    assert.equal(v0.subarray(4, 8).toString("ascii"), "mdhd");
    assert.deepEqual([ v0.length, v0.readUInt8(8), v0.readUInt32BE(20) ], [ 32, 0, 90000 ]);
    assert.deepEqual([ v1.length, v1.readUInt8(8), v1.readUInt32BE(28) ], [ 44, 1, 15360 ]);
  });
});

// The boxes the composers nest others in.
const CONTAINERS = [ "mdia", "moof", "moov", "traf", "trak" ];

// Every box in `buffer` in the order it is written, each with its path through the containers above it, so a row reads a composed layout whole.
function boxesOf(buffer: Buffer, parent = ""): { bytes: Buffer; path: string }[] {

  const boxes: { bytes: Buffer; path: string }[] = [];

  for(let offset = 0; offset < buffer.length; offset += buffer.readUInt32BE(offset)) {

    const bytes = buffer.subarray(offset, offset + buffer.readUInt32BE(offset));
    const type = bytes.toString("ascii", 4, 8);

    boxes.push({ bytes, path: parent + type });

    if(CONTAINERS.includes(type)) {

      boxes.push(...boxesOf(bytes.subarray(BOX_HEADER_SIZE), parent + type + "/"));
    }
  }

  return boxes;
}

// The bytes of every box in `boxes` whose type is `type`, in order.
function bytesOfType(boxes: readonly { bytes: Buffer; path: string }[], type: string): Buffer[] {

  return boxes.filter(({ path }) => path.endsWith(type)).map(({ bytes }) => bytes);
}

describe("makeInitSegment", () => {

  test("writes an ftyp, then a moov holding an mvhd and a trak for each track in order, each holding its tkhd and an mdia with its mdhd and hdlr", () => {

    // Each box takes its own version, so a track whose tkhd and mdhd differ is written as given.
    const boxes = boxesOf(makeInitSegment([ { handler: HDLR_TYPE_VIDE, id: 1, timescale: 90000, tkhdVersion: 1 },
      { handler: HDLR_TYPE_SOUN, id: 2, mdhdVersion: 1, timescale: 48000 } ]));
    const trak = [ "moov/trak", "moov/trak/tkhd", "moov/trak/mdia", "moov/trak/mdia/mdhd", "moov/trak/mdia/hdlr" ];

    assert.deepEqual(boxes.map(({ path }) => path), [ "ftyp", "moov", "moov/mvhd", ...trak, ...trak ]);

    // Each track's boxes are the ones the fullbox builders write for its ID, timescale, handler and version.
    assert.deepEqual(bytesOfType(boxes, "tkhd"), [ makeTkhdBox({ trackId: 1, version: 1 }), makeTkhdBox({ trackId: 2 }) ]);
    assert.deepEqual(bytesOfType(boxes, "mdhd"), [ makeMdhdBox({ timescale: 90000 }), makeMdhdBox({ timescale: 48000, version: 1 }) ]);
    assert.deepEqual(bytesOfType(boxes, "hdlr"), [ makeHdlrBox(HDLR_TYPE_VIDE), makeHdlrBox(HDLR_TYPE_SOUN) ]);
  });

  test("writes tracks the readers read back", () => {

    const init = makeInitSegment([ { handler: HDLR_TYPE_SOUN, id: 2, timescale: 48000 }, { handler: HDLR_TYPE_VIDE, id: 7, mdhdVersion: 1, timescale: 15360,
      tkhdVersion: 1 } ]);

    assert.deepEqual(findVideoTrack(init), { id: 7, timescale: 15360 });
    assert.equal(hasAudioTrack(init), true);
    assert.equal(hasAudioTrack(makeInitSegment([{ handler: HDLR_TYPE_VIDE, id: 1, timescale: 90000 }])), false);
  });
});

describe("makeFragment", () => {

  test("writes a moof holding an mfhd and each track's fragment, then an mdat holding each track's samples, each run pointing at its track's first sample", () => {

    const video = [ { duration: 3000, size: 10 }, { duration: 3000, size: 20 } ];
    const audio = [{ duration: 1920, size: 7 }];
    const fragment = makeFragment({ samples: video, secondTrack: { samples: audio, trackId: 2 }, trackId: 1 });
    const boxes = boxesOf(fragment);
    const traf = [ "moof/traf", "moof/traf/tfhd", "moof/traf/tfdt", "moof/traf/trun" ];
    const mdat = expectAt(bytesOfType(boxes, "mdat"), 0, "the mdat");
    const payload = (fragment.length - mdat.length) + BOX_HEADER_SIZE;

    assert.deepEqual(boxes.map(({ path }) => path), [ "moof", "moof/mfhd", ...traf, ...traf, "mdat" ]);
    assert.deepEqual(bytesOfType(boxes, "tfhd"), [ makeTfhdBox({ trackId: 1 }), makeTfhdBox({ trackId: 2 }) ]);

    // The first run carries each sample's duration and size and a keyframe's first-sample flags unless asked otherwise, and the second each sample's duration and
    // size. Each data offset is measured from the moof, which opens the fragment.
    assert.deepEqual(bytesOfType(boxes, "trun"), [
      makeTrunBox({ dataOffset: payload, includeDuration: true, includeSize: true, samples: video, useFirstSampleFlags: true }),
      makeTrunBox({ dataOffset: payload + 30, includeDuration: true, includeSize: true, samples: audio })
    ]);
    assert.equal(mdat.length, BOX_HEADER_SIZE + 37, "the mdat holds every sample's bytes");
  });

  test("writes the header options, run fields and data offset it is given into the first track's fragment, and a fragment of one track alone", () => {

    const samples = [ { size: 10 }, { size: 20 } ];
    const boxes = boxesOf(makeFragment({ dataOffset: -16, header: { defaultSampleDuration: 3000, sampleDescriptionIndex: 1 }, run: { includeSize: true }, samples,
      trackId: 5 }));

    assert.deepEqual(boxes.map(({ path }) => path), [ "moof", "moof/mfhd", "moof/traf", "moof/traf/tfhd", "moof/traf/tfdt", "moof/traf/trun", "mdat" ]);
    assert.deepEqual(bytesOfType(boxes, "tfhd"), [makeTfhdBox({ defaultSampleDuration: 3000, sampleDescriptionIndex: 1, trackId: 5 })]);
    assert.deepEqual(bytesOfType(boxes, "trun"), [makeTrunBox({ dataOffset: -16, includeSize: true, samples })]);
    assert.equal(expectAt(bytesOfType(boxes, "mdat"), 0, "the mdat").length, BOX_HEADER_SIZE + 30);
  });

  test("writes the first-sample flags a run picks, and a keyframe's when it picks none", () => {

    const samples = [ { duration: 3000, size: 10 }, { duration: 3000, size: 20 } ];
    const run = { includeDuration: true, includeSize: true, useFirstSampleFlags: true } as const;
    const runOf = (fragment: Buffer): Buffer => expectAt(bytesOfType(boxesOf(fragment), "trun"), 0, "the run");

    // Box offsets within the run: 16 (data_offset) -> 20 (first_sample_flags).
    assert.equal(runOf(makeFragment({ run: { ...run, sampleFlagsValue: SAMPLE_FLAG_NON_SYNC }, samples, trackId: 1 })).readUInt32BE(20), SAMPLE_FLAG_NON_SYNC);
    assert.equal(runOf(makeFragment({ run, samples, trackId: 1 })).readUInt32BE(20), 0);
  });

  test("lays out samples the frame reader cuts at the sizes it was given", () => {

    const sizes = [ 10, 20, 30 ];
    const fragment = makeFragment({ samples: sizes.map((size) => ({ duration: 900, size })), secondTrack: { samples: [{ duration: 1920, size: 7 }], trackId: 2 },
      trackId: 1 });
    const pieces = present(splitVideoFrames(fragment, { id: 1, timescale: 90000 }), "the fragment's pieces");
    const start = present(findBox(fragment, "mdat"), "the fragment's mdat").offset + BOX_HEADER_SIZE;

    // Each piece but the last ends where its frame ends, and the last carries the audio sample after the video.
    assert.deepEqual(pieces.map(({ bytes }) => (bytes.byteOffset - fragment.byteOffset) + bytes.length), [ start + 10, start + 30, fragment.length ]);
    assert.deepEqual(pieces.map(({ duration }) => duration), [ 10, 10, 10 ]);
  });
});
