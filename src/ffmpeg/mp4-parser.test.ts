/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/mp4-parser.test.ts: Unit tests for the Mp4BoxParser - byte-to-record parsing across chunk boundaries, type-code discrimination, corruption handling.
 */
import { BOX_TYPE_FTYP, BOX_TYPE_MDAT, BOX_TYPE_MOOF, BOX_TYPE_MOOV, Mp4BoxParser } from "./mp4-parser.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { expectAt } from "../testing.helpers.ts";
import { makeBox } from "./mp4.helpers.ts";

describe("Mp4BoxParser - single-chunk parsing", () => {

  test("yields each box type as a 32-bit integer matching the exported BOX_TYPE_* constants", () => {

    const parser = new Mp4BoxParser();
    const stream = Buffer.concat([ makeBox("ftyp"), makeBox("moov"), makeBox("moof"), makeBox("mdat") ]);
    const boxes = Array.from(parser.consume(stream));

    assert.deepEqual(boxes.map((box) => box.type), [ BOX_TYPE_FTYP, BOX_TYPE_MOOV, BOX_TYPE_MOOF, BOX_TYPE_MDAT ]);
  });

  test("preserves payload bytes verbatim in Mp4Box.bytes", () => {

    const parser = new Mp4BoxParser();
    const payload = Buffer.from("deadbeef", "hex");
    const stream = makeBox("mdat", payload);
    const boxes = Array.from(parser.consume(stream));
    const box = expectAt(boxes, 0, "parsed box");

    assert.equal(box.bytes.length, stream.length, "emitted box must include header + payload");
    assert.deepEqual(Buffer.from(box.bytes), stream, "emitted bytes must match the original box verbatim");
  });

  test("handles multiple boxes in one chunk and yields them in stream order", () => {

    const parser = new Mp4BoxParser();
    const first = makeBox("moof", Buffer.from([0x01]));
    const second = makeBox("mdat", Buffer.from([ 0x02, 0x03 ]));
    const boxes = Array.from(parser.consume(Buffer.concat([ first, second ])));

    assert.equal(boxes.length, 2);
    assert.deepEqual(Buffer.from(expectAt(boxes, 0, "first box").bytes), first);
    assert.deepEqual(Buffer.from(expectAt(boxes, 1, "second box").bytes), second);
  });

  test("yields nothing when the chunk is too short to contain a box header", () => {

    const parser = new Mp4BoxParser();

    assert.deepEqual(Array.from(parser.consume(Buffer.from([ 0x00, 0x00 ]))), []);
  });
});

describe("Mp4BoxParser - cross-chunk reassembly", () => {

  test("reassembles a box whose header is split across two chunks", () => {

    const parser = new Mp4BoxParser();
    const box = makeBox("mdat", Buffer.from("abcd"));

    // Split in the middle of the 8-byte header so the first chunk does not even carry a complete header. The second call must produce the full box.
    const first = Array.from(parser.consume(box.subarray(0, 4)));
    const second = Array.from(parser.consume(box.subarray(4)));

    assert.deepEqual(first, []);
    assert.equal(second.length, 1);
    assert.deepEqual(Buffer.from(expectAt(second, 0, "reassembled box").bytes), box);
  });

  test("reassembles a box whose payload is split across multiple chunks", () => {

    const parser = new Mp4BoxParser();
    const payload = Buffer.alloc(32, 0xAB);
    const box = makeBox("moof", payload);

    // Three-way split: complete header in the first chunk, half the payload in the second, the rest in the third. Only the third call should yield a complete box.
    const firstChunk = box.subarray(0, 10);
    const secondChunk = box.subarray(10, 20);
    const thirdChunk = box.subarray(20);

    assert.deepEqual(Array.from(parser.consume(firstChunk)), []);
    assert.deepEqual(Array.from(parser.consume(secondChunk)), []);

    const final = Array.from(parser.consume(thirdChunk));

    assert.equal(final.length, 1);
    assert.deepEqual(Buffer.from(expectAt(final, 0, "final box").bytes), box);
  });

  test("emits completed boxes and carries the trailing partial to the next call", () => {

    const parser = new Mp4BoxParser();
    const complete = makeBox("ftyp", Buffer.from("isomavc1"));
    const trailing = makeBox("moov", Buffer.from("partial-payload-data"));

    // First chunk: one complete box + the first few bytes of the next. The parser should emit the first box and hold the remainder.
    const partialTail = trailing.subarray(0, 5);
    const firstBoxes = Array.from(parser.consume(Buffer.concat([ complete, partialTail ])));

    assert.equal(firstBoxes.length, 1);
    assert.deepEqual(Buffer.from(expectAt(firstBoxes, 0, "completed box").bytes), complete);

    // Second chunk: the rest of the second box. The parser should now emit the trailing box in full.
    const secondBoxes = Array.from(parser.consume(trailing.subarray(5)));

    assert.equal(secondBoxes.length, 1);
    assert.deepEqual(Buffer.from(expectAt(secondBoxes, 0, "trailing box").bytes), trailing);
  });

  test("emits multiple boxes completed across a chunk boundary in a single call", () => {

    const parser = new Mp4BoxParser();
    const a = makeBox("moof", Buffer.from([0x11]));
    const b = makeBox("mdat", Buffer.from([ 0x22, 0x33 ]));
    const c = makeBox("moof", Buffer.from([0x44]));

    // First chunk carries `a` plus partial `b`. Second chunk carries the rest of `b` plus all of `c`. The second call should emit `b` and `c` together.
    const firstChunk = Buffer.concat([ a, b.subarray(0, 3) ]);
    const secondChunk = Buffer.concat([ b.subarray(3), c ]);

    const firstBoxes = Array.from(parser.consume(firstChunk));

    assert.equal(firstBoxes.length, 1);
    assert.deepEqual(Buffer.from(expectAt(firstBoxes, 0, "box a").bytes), a);

    const secondBoxes = Array.from(parser.consume(secondChunk));

    assert.equal(secondBoxes.length, 2);
    assert.deepEqual(Buffer.from(expectAt(secondBoxes, 0, "box b").bytes), b);
    assert.deepEqual(Buffer.from(expectAt(secondBoxes, 1, "box c").bytes), c);
  });
});

describe("Mp4BoxParser - corruption handling", () => {

  test("stops emitting and resets pending state when a size field is below the header size", () => {

    const parser = new Mp4BoxParser();
    const good = makeBox("moof", Buffer.from([ 0x01, 0x02 ]));

    // A second "box" whose declared size (4) is smaller than the 8-byte header. The parser should emit the good box, abort the bad one, and reset so subsequent good
    // input still works.
    const corrupt = Buffer.alloc(8);

    corrupt.writeUInt32BE(4, 0);
    corrupt.write("mdat", 4, 4, "ascii");

    const firstBoxes = Array.from(parser.consume(Buffer.concat([ good, corrupt ])));

    assert.equal(firstBoxes.length, 1, "well-formed box should emit before the parser aborts on the corrupt one");
    assert.deepEqual(Buffer.from(expectAt(firstBoxes, 0, "good box").bytes), good);

    // Recovery: feeding a fresh well-formed box after corruption should yield it normally. The parser's internal pending state was reset on the corruption abort.
    const recovery = makeBox("mdat", Buffer.from([0xFF]));
    const secondBoxes = Array.from(parser.consume(recovery));

    assert.equal(secondBoxes.length, 1);
    assert.deepEqual(Buffer.from(expectAt(secondBoxes, 0, "recovery box").bytes), recovery);
  });
});
