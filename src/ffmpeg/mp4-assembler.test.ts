/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/mp4-assembler.test.ts: Unit tests for the Mp4SegmentAssembler - init/segment split contract, timeout semantics, signal-aware termination, and
 * AsyncDisposable teardown driven by in-memory fixture Readables.
 */
import { HbpuAbortError, isHbpuAbortReason } from "../util.ts";
import { describe, test } from "node:test";
import type { Mp4Segment } from "./mp4-assembler.ts";
import { Mp4SegmentAssembler } from "./mp4-assembler.ts";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { makeBox } from "./mp4.helpers.ts";

// Advance the generator one step and return the Buffer it yielded. If the generator terminated instead, fail the test with the supplied context. Encapsulating this
// narrow-or-fail pattern keeps each test body free of IteratorResult shape handling and avoids non-null assertions on potentially-done results.
async function nextSegment(iter: AsyncIterator<Buffer>, context: string): Promise<Buffer> {

  const result = await iter.next();

  assert.ok(!result.done, "expected a segment but the generator returned: " + context);

  return result.value;
}

// Advance any generator one step and assert it has terminated. The value type is irrelevant here - only `done` is read - so the parameter is widened to `unknown` and the
// same helper serves both the Buffer segments() iterator and the Mp4Segment stream() iterator. Encapsulates the "no more items" assertion so its intent reads clearly.
async function assertDone(iter: AsyncIterator<unknown>, context: string): Promise<void> {

  const result = await iter.next();

  assert.equal(result.done, true, "expected the generator to be done but it yielded: " + context);
}

// Advance a stream() generator one step and return the Mp4Segment it yielded, mirroring nextSegment for the kind-tagged stream. Fails the test if the generator ended.
async function nextStreamItem(iter: AsyncIterator<Mp4Segment>, context: string): Promise<Mp4Segment> {

  const result = await iter.next();

  assert.ok(!result.done, "expected a stream item but the generator returned: " + context);

  return result.value;
}

describe("Mp4SegmentAssembler - init segment contract", () => {

  test("initSegment resolves with the concatenated pre-moof bytes (ftyp + moov)", async () => {

    const source = new PassThrough();

    await using assembler = new Mp4SegmentAssembler(source);

    const ftyp = makeBox("ftyp", Buffer.from("isomavc1"));
    const moov = makeBox("moov", Buffer.from("movie-metadata"));

    source.write(ftyp);
    source.write(moov);
    // The moof triggers init resolution. The ftyp+moov preceding it becomes the init segment.
    source.write(makeBox("moof", Buffer.from([0x01])));
    source.write(makeBox("mdat", Buffer.from([0x02])));

    const init = await assembler.initSegment;

    assert.deepEqual(init, Buffer.concat([ ftyp, moov ]),
      "initSegment must concatenate every box that arrived before the first moof, verbatim");
  });

  test("segments() does not yield until initSegment resolves", async () => {

    const source = new PassThrough();

    await using assembler = new Mp4SegmentAssembler(source);

    const iter = assembler.segments();

    // Feed a complete init + first media segment. Until the init resolves, the generator must block on the init promise - a premature yield would signal that the
    // ftyp / moov boxes leaked into the media stream.
    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));
    source.write(makeBox("moof"));
    source.write(makeBox("mdat"));

    const segment = await nextSegment(iter, "first media segment after init");

    // First yielded segment must start with the moof box, not ftyp - that is the init-first contract.
    assert.equal(segment.readUInt32BE(4), 0x6D6F6F66);
  });

  test("initSegment rejects with signal.reason when aborted before the first moof arrives", async () => {

    const source = new PassThrough();
    const assembler = new Mp4SegmentAssembler(source);

    // Feed only pre-moof boxes. Abort before the moof that would resolve init.
    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));

    // Give the drain loop a short delay (10ms) to observe the chunks.
    await delay(10);

    const reason = new HbpuAbortError("replaced");

    assembler.abort(reason);

    await assert.rejects(assembler.initSegment, (error: unknown) => error === reason,
      "initSegment must reject with the exact signal reason that tore the assembler down");
  });
});

describe("Mp4SegmentAssembler - media segments generator", () => {

  test("yields each moof/mdat pair as a concatenated Buffer in stream order", async () => {

    const source = new PassThrough();

    await using assembler = new Mp4SegmentAssembler(source);

    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));

    const pairA = Buffer.concat([ makeBox("moof", Buffer.from([0x01])), makeBox("mdat", Buffer.from([0x02])) ]);
    const pairB = Buffer.concat([ makeBox("moof", Buffer.from([0x03])), makeBox("mdat", Buffer.from([ 0x04, 0x05 ])) ]);
    const pairC = Buffer.concat([ makeBox("moof", Buffer.from([0x06])), makeBox("mdat", Buffer.from([0x07])) ]);

    source.write(pairA);
    source.write(pairB);
    source.write(pairC);

    const iter = assembler.segments();

    assert.deepEqual(await nextSegment(iter, "pair A"), pairA);
    assert.deepEqual(await nextSegment(iter, "pair B"), pairB);
    assert.deepEqual(await nextSegment(iter, "pair C"), pairC);
  });

  test("drains queued segments after the source ends and then returns cleanly", async () => {

    const source = new PassThrough();

    await using assembler = new Mp4SegmentAssembler(source);

    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));
    source.write(makeBox("moof"));
    source.write(makeBox("mdat", Buffer.from([0xAA])));
    source.end();

    const segments: Buffer[] = [];

    for await (const segment of assembler.segments()) {

      segments.push(segment);
    }

    assert.equal(segments.length, 1, "queued segment must be surfaced even though the source has already ended");
    assert.equal(isHbpuAbortReason(assembler.signal.reason, "closed"), true,
      "natural source end should abort the assembler's signal with reason \"closed\"");
  });
});

describe("Mp4SegmentAssembler - signal-aware termination", () => {

  test("external abort via abort() terminates the generator and leaves signal.reason intact", async () => {

    const source = new PassThrough();
    const assembler = new Mp4SegmentAssembler(source);

    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));
    source.write(makeBox("moof"));
    source.write(makeBox("mdat"));

    const iter = assembler.segments();

    await nextSegment(iter, "first segment before abort");

    const reason = new HbpuAbortError("shutdown");

    assembler.abort(reason);

    await assertDone(iter, "abort() should terminate the generator cleanly - not throw");
    assert.equal(assembler.signal.reason, reason);
  });

  test("parent signal abort propagates through AbortSignal.any to the assembler's composed signal", async () => {

    const parent = new AbortController();
    const source = new PassThrough();
    const assembler = new Mp4SegmentAssembler(source, { signal: parent.signal });

    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));
    source.write(makeBox("moof"));
    source.write(makeBox("mdat"));

    const iter = assembler.segments();

    await nextSegment(iter, "first segment before parent abort");

    const parentReason = new HbpuAbortError("shutdown");

    parent.abort(parentReason);

    await assertDone(iter, "parent abort must propagate through to the generator");
    assert.equal(assembler.signal.reason, parentReason,
      "AbortSignal.any must preserve the parent's abort reason when the parent aborts first");
  });

  test("per-call signal aborts the generator while the initSegment wait is still pending", async () => {

    // Guards the init-first contract's cancellation semantics: `waitWithSignal` races the init promise against the composed signal, so a per-call abort during the
    // init-wait window terminates the iterator immediately rather than waiting for the assembler's own signal to settle init.
    const source = new PassThrough();

    await using assembler = new Mp4SegmentAssembler(source);

    // Feed only pre-moof boxes - initSegment stays pending for the duration of this test.
    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));

    const perCall = new AbortController();
    const iter = assembler.segments({ signal: perCall.signal });

    // Kick the next() so the generator reaches its init-wait phase, then abort the caller's per-call signal. The generator must return without hanging.
    const firstNext = iter.next();

    await delay(10);

    perCall.abort(new HbpuAbortError("replaced"));

    const result = await firstNext;

    assert.equal(result.done, true, "per-call signal abort must terminate the generator even while initSegment is pending");
    assert.equal(assembler.aborted, false, "per-call signal abort must not propagate to the assembler's own signal");
  });

  test("pre-aborted parent signal aborts the assembler immediately and rejects initSegment", async () => {

    const parent = new AbortController();
    const parentReason = new HbpuAbortError("shutdown");

    parent.abort(parentReason);

    const source = new PassThrough();
    const assembler = new Mp4SegmentAssembler(source, { signal: parent.signal });

    assert.equal(assembler.aborted, true, "composed signal must be aborted the moment the constructor returns");

    await assert.rejects(assembler.initSegment, (error: unknown) => error === parentReason);
  });
});

describe("Mp4SegmentAssembler - watchdog timeout", () => {

  test("aborts with HbpuAbortError(timeout) when no media segment arrives within the window", async () => {

    const source = new PassThrough();
    const assembler = new Mp4SegmentAssembler(source, { segmentTimeout: 50 });

    // Feed init + first segment. The watchdog arms on init resolution and re-arms after the first mdat. After that we stop feeding; the next segment never arrives and
    // the watchdog must fire.
    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));
    source.write(makeBox("moof"));
    source.write(makeBox("mdat"));

    const iter = assembler.segments();

    await nextSegment(iter, "first segment before timeout");
    await assertDone(iter, "generator must terminate when the watchdog fires");

    assert.equal(assembler.isTimedOut, true, "isTimedOut must be true for an HbpuAbortError(\"timeout\") reason");
    assert.equal(isHbpuAbortReason(assembler.signal.reason, "timeout"), true);
  });

  test("is disabled by default (no timeout option means no watchdog)", async () => {

    const source = new PassThrough();
    const assembler = new Mp4SegmentAssembler(source);

    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));
    source.write(makeBox("moof"));
    source.write(makeBox("mdat"));

    const iter = assembler.segments();

    await nextSegment(iter, "first segment with no watchdog configured");

    // Wait well past any reasonable HKSV watchdog window. Without a timeout option the assembler must stay live.
    await delay(80);

    assert.equal(assembler.aborted, false, "no segmentTimeout option must mean the assembler never self-aborts on stall");

    assembler.abort();

    await assertDone(iter, "manual abort after the wait closes the generator");
  });
});

describe("Mp4SegmentAssembler - AsyncDisposable", () => {

  test("await using aborts the assembler with \"shutdown\" and awaits drain completion by scope exit", async () => {

    const source = new PassThrough();
    let capturedSignal: AbortSignal | undefined;

    {

      await using assembler = new Mp4SegmentAssembler(source);

      capturedSignal = assembler.signal;

      source.write(makeBox("ftyp"));
      source.write(makeBox("moov"));
      source.write(makeBox("moof"));
      source.write(makeBox("mdat"));

      // Let the drain observe the data so initSegment resolves.
      await assembler.initSegment;
    }

    assert.ok(capturedSignal, "the source must have observed the assembler's abort signal during init");
    assert.equal(capturedSignal.aborted, true, "await using must have aborted the signal by the time the block exits");
    assert.equal(isHbpuAbortReason(capturedSignal.reason, "shutdown"), true,
      "default disposal reason is \"shutdown\" per the class contract");
  });

  test("explicit [Symbol.asyncDispose] aborts and awaits drain completion", async () => {

    const source = new PassThrough();
    const assembler = new Mp4SegmentAssembler(source);

    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));
    source.write(makeBox("moof"));
    source.write(makeBox("mdat"));

    await assembler.initSegment;
    await assembler[Symbol.asyncDispose]();

    assert.equal(assembler.aborted, true);
    assert.equal(isHbpuAbortReason(assembler.signal.reason, "shutdown"), true);
  });
});

describe("Mp4SegmentAssembler - source error absorber", () => {

  test("attaches a permanent source error listener to prevent post-drain errors from crashing the host", async () => {

    // Regression guard for the "events.on cleans up its error listener when the iterator terminates, leaving the source unguarded post-drain" crash window.
    // The assembler installs its own permanent absorber at construction that survives drain termination; this test verifies the listener is present before, during,
    // and after the drain's active phase.
    const source = new PassThrough();

    assert.equal(source.listenerCount("error"), 0, "fixture pre-condition: no error listeners on a fresh PassThrough");

    const assembler = new Mp4SegmentAssembler(source);

    assert.ok(source.listenerCount("error") >= 1, "absorber must be attached during construction");

    // Manually dispose to guarantee the drain loop has fully exited before we inspect post-drain state.
    await assembler[Symbol.asyncDispose]();

    assert.equal(source.listenerCount("error"), 1,
      "absorber must remain attached past drain termination - `events.on`'s internal error listener is gone by now, so this one is the only guard");
  });

  test("source error aborts with HbpuAbortError(failed) carrying the underlying error on cause", async () => {

    const source = new PassThrough();
    const assembler = new Mp4SegmentAssembler(source);

    source.write(makeBox("ftyp"));

    // Give the drain loop a short delay (10ms) to observe the chunk, then surface an error on the source. destroy() emits "error" on the stream.
    await delay(10);

    const boom = new Error("source exploded");

    source.destroy(boom);

    await assert.rejects(assembler.initSegment, (error: unknown) => {

      return isHbpuAbortReason(error, "failed") && (error.cause === boom);
    });

    assert.equal(isHbpuAbortReason(assembler.signal.reason, "failed"), true);
  });
});

describe("Mp4SegmentAssembler - kind-tagged stream", () => {

  test("stream() yields one init item carrying the initialization bytes, then a media item per fragment in order", async () => {

    const source = new PassThrough();

    await using assembler = new Mp4SegmentAssembler(source);

    const ftyp = makeBox("ftyp", Buffer.from("isomavc1"));
    const moov = makeBox("moov", Buffer.from("movie-metadata"));
    const pairA = Buffer.concat([ makeBox("moof", Buffer.from([0x01])), makeBox("mdat", Buffer.from([0x02])) ]);
    const pairB = Buffer.concat([ makeBox("moof", Buffer.from([0x03])), makeBox("mdat", Buffer.from([ 0x04, 0x05 ])) ]);

    source.write(ftyp);
    source.write(moov);
    source.write(pairA);
    source.write(pairB);

    const iter = assembler.stream();

    // The first item is the init segment, tagged "init", carrying exactly the concatenated pre-moof bytes - the same bytes the initSegment promise resolves with.
    const first = await nextStreamItem(iter, "the init item");

    assert.equal(first.kind, "init", "the first item must be the initialization segment");
    assert.deepEqual(first.bytes, Buffer.concat([ ftyp, moov ]), "the init item must carry the concatenated pre-moof bytes verbatim");
    assert.deepEqual(first.bytes, await assembler.initSegment, "the init item bytes must equal what initSegment resolves with");

    // Each subsequent item is a media fragment, tagged "media", in stream order.
    const second = await nextStreamItem(iter, "media pair A");

    assert.equal(second.kind, "media");
    assert.deepEqual(second.bytes, pairA);

    const third = await nextStreamItem(iter, "media pair B");

    assert.equal(third.kind, "media");
    assert.deepEqual(third.bytes, pairB);
  });

  test("stream() drains queued media after the source ends, then returns cleanly", async () => {

    const source = new PassThrough();

    await using assembler = new Mp4SegmentAssembler(source);

    const ftyp = makeBox("ftyp");
    const moov = makeBox("moov");
    const pair = Buffer.concat([ makeBox("moof"), makeBox("mdat", Buffer.from([0xAA])) ]);

    source.write(ftyp);
    source.write(moov);
    source.write(pair);
    source.end();

    const collected: Mp4Segment[] = [];

    for await (const item of assembler.stream()) {

      collected.push({ bytes: item.bytes, kind: item.kind });
    }

    // Exactly one init item then the single queued media item, both surfaced before the generator returns on the natural source end - no assembled segment is lost.
    assert.deepEqual(collected, [ { bytes: Buffer.concat([ ftyp, moov ]), kind: "init" }, { bytes: pair, kind: "media" } ]);
    assert.equal(isHbpuAbortReason(assembler.signal.reason, "closed"), true, "natural source end aborts the assembler's signal with reason \"closed\"");
  });

  test("stream() returns cleanly when the assembler aborts mid-stream, without hanging on the parked waiter", async () => {

    const source = new PassThrough();

    const assembler = new Mp4SegmentAssembler(source);

    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));
    source.write(makeBox("moof"));
    source.write(makeBox("mdat", Buffer.from([0xAA])));

    const iter = assembler.stream()[Symbol.asyncIterator]();

    // Drain the init item and the single queued media item, leaving the generator parked awaiting the next fragment.
    assert.equal((await nextStreamItem(iter, "the init item")).kind, "init");
    assert.equal((await nextStreamItem(iter, "the queued media item")).kind, "media");

    assembler.abort(new HbpuAbortError("shutdown"));

    await assertDone(iter, "after abort");
  });

  test("stream() returns without yielding when aborted before the initialization segment arrives", async () => {

    const source = new PassThrough();

    const assembler = new Mp4SegmentAssembler(source);

    // Feed only pre-moof boxes so init never resolves, then abort before requesting anything from the stream.
    source.write(makeBox("ftyp"));
    source.write(makeBox("moov"));

    await delay(10);

    const iter = assembler.stream()[Symbol.asyncIterator]();

    assembler.abort(new HbpuAbortError("replaced"));

    // A pre-init abort ends the stream with nothing yielded, mirroring segments()'s return-on-init-reject behavior.
    await assertDone(iter, "pre-init abort");
  });
});
