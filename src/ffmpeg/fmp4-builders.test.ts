/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/fmp4-builders.test.ts: Unit tests for the ISO BMFF byte-level construction builders in fmp4-builders.ts. Builders earn the same enumerated-criteria coverage as
 * production code per the testing convention - every branch, every error path, every flag combination - because the suites that consume these builders (parser,
 * assembler, fmp4 predicate tests) silently lose their meaning if the builders themselves drift from the wire layouts they encode.
 */
import { HDLR_TYPE_SOUN, SAMPLE_FLAG_NON_SYNC } from "./fmp4.ts";
import { HDLR_TYPE_VIDE, makeBox, makeContainer, makeHdlrBox, makeTrunBox } from "./fmp4-builders.ts";
import { describe, test } from "node:test";
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
    assert.throws(() => makeBox("moo"), { message: /4 ASCII characters/ }, "3-character type must reject");
    assert.throws(() => makeBox("moofx"), { message: /4 ASCII characters/ }, "5-character type must reject");
    assert.throws(() => makeBox(""), { message: /4 ASCII characters/ }, "empty type must reject");
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
    // this shape, so we pin the byte count so the negative test in the predicate suite cannot drift away from the helper's promise.
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
    // predicate's offset arithmetic finds them where it expects. We pin the order here by writing distinguishable values to each slot through the helper's options
    // and verifying the read-back positions.
    const sentinel = SAMPLE_FLAG_NON_SYNC;
    const trun = makeTrunBox({ includeDuration: true, includeSize: true, sampleFlagsValue: sentinel, usePerSampleFlags: true });

    // Box offsets: 8 (version/flags) -> 12 (sample_count) -> 16 (data_offset) -> 20 (duration) -> 24 (size) -> 28 (per-sample flags).
    assert.equal(trun.readUInt32BE(28), sentinel, "per-sample flags slot must follow duration and size slots in canonical order");
    assert.equal(trun.length, 8 + 8 + 4 + 4 + 4 + 4, "total length must reflect every requested optional slot");
  });

  test("sets every requested flag bit independently in the flags header", () => {

    // Coverage for each individual flag-set branch in the helper. Combine all four optional flags and verify each bit is set.
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
