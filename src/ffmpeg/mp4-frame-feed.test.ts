/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/mp4-frame-feed.test.ts: Unit tests for Mp4FrameFeed over a real BackpressureWriter on a TestClock - the header written whole, a fragment written frame by
 * frame at its due times, a fragment written whole when there is no video track to cut it at, when it holds no video, or when the reader cannot cut it, a later
 * header replacing the track, the report of a fragment written whole firing once per header for each reason before the write, a writer's rejection reaching the
 * caller, the start delay the video's own time gives each fragment, and the target that delay is read from.
 *
 * Every header and fragment is built from invented values through `makeInitSegment` and `makeFragment`, and every timeline is invented. A row reads the stream as
 * the bytes it has been handed so far, so a piece written early or late shows as the wrong bytes at the moment the row looks. Each row on the video's own time
 * hands the feed its writer's clock, and each timing row leaves at least one frame still not due after its advance. The rows that read the target's rule alone
 * hand the feed a writer that records each start delay it asks for, so a row reads every ask exactly, an ask of nothing included.
 */
import { BackpressureOverflowError, BackpressureWriter } from "../backpressure.ts";
import { HDLR_TYPE_SOUN, splitVideoFrames } from "./fmp4.ts";
import { HDLR_TYPE_VIDE, makeFragment, makeInitSegment } from "./fmp4-builders.ts";
import type { Mp4FrameFeedInit, Mp4FrameFeedWriter, Mp4UnpacedReason } from "./mp4-frame-feed.ts";
import { describe, test } from "node:test";
import { drainClock, expectAt, present, settle } from "../testing/index.ts";
import { HbpuAbortError } from "../util.ts";
import { Mp4FrameFeed } from "./mp4-frame-feed.ts";
import { PassThrough } from "node:stream";
import { TestClock } from "../clock-double.ts";
import assert from "node:assert/strict";
import { wireOf } from "../backpressure.helpers.ts";

// The tracks the headers are built from: a video track, another video track a later header names instead, and an audio track.
const VIDEO = { handler: HDLR_TYPE_VIDE, id: 1, timescale: 90000 } as const;
const OTHER_VIDEO = { ...VIDEO, id: 2 } as const;
const AUDIO = { handler: HDLR_TYPE_SOUN, id: 9, timescale: 48000 } as const;

// Audio samples of invented sizes, each as long as the others at the audio timescale.
const AUDIO_SAMPLES = [ { duration: 1920, size: 7 }, { duration: 1920, size: 9 } ] as const;

// A fragment of the video track whose frames last the given milliseconds, each of an invented size, and the pieces the reader cuts it into, so a row reads the
// wire as the pieces sent by then.
function videoFragment(...durations: number[]): { fragment: Buffer; pieces: Buffer[] } {

  const fragment = makeFragment({ samples: durations.map((ms) => ({ duration: (ms * VIDEO.timescale) / 1000, size: 10 })), trackId: VIDEO.id });

  return { fragment, pieces: present(splitVideoFrames(fragment, VIDEO), "the fragment's frames").map(({ bytes }) => bytes) };
}

// A TestClock that counts its monotonic readings, so a row proves a path takes none.
class CountingClock extends TestClock {

  public readings = 0;

  public override monotonic(): number {

    this.readings++;

    return super.monotonic();
  }
}

// A PassThrough that notes the clock's monotonic reading as each write reaches it, so a row reads when every piece left the writer. It flows with nothing reading
// it, so what it is handed never backs up into a drain wait.
class TimedPassThrough extends PassThrough {

  public readonly sentAt: number[] = [];

  readonly #clock: TestClock;

  public constructor(clock: TestClock) {

    super();
    this.#clock = clock;
    this.resume();
  }

  public override write(chunk: unknown, encoding?: BufferEncoding | ((_error: Error | null | undefined) => void),
    callback?: (_error: Error | null | undefined) => void): boolean {

    this.sentAt.push(this.#clock.monotonic());

    return super.write(chunk, encoding as BufferEncoding, callback);
  }
}

// A writer that writes nothing and records the start delay of each paced write the feed hands it, so a row reads the feed's asks exactly, an ask of nothing
// included, where a real writer's clock records only the holds it takes. The paced write `refused` counts to, from zero, is refused as a full queue refuses
// one, once its ask is recorded.
function askingWriter(refused?: number): { asks: number[]; writer: Mp4FrameFeedWriter } {

  const asks: number[] = [];

  return { asks, writer: { write: async (): Promise<void> => undefined, writePaced: async (_chunks, options): Promise<void> => {

    asks.push(options?.startDelay ?? 0);

    if((asks.length - 1) === refused) {

      throw new BackpressureOverflowError();
    }
  } } };
}

// Hand a feed over an asking writer a header at the clock's start and then, at each arrival, a fragment of one frame of the given length, and answer the start
// delays the feed asked for. Each arrival is a reading of the row's own invented timeline, in milliseconds on the feed's clock.
async function asksOver(arrivals: readonly (readonly [ number, number ])[]): Promise<number[]> {

  const clock = new TestClock();
  const { asks, writer } = askingWriter();
  const feed = new Mp4FrameFeed(writer, { clock });

  await feed.writeHeader(makeInitSegment([ VIDEO, AUDIO ]));

  for(const [ at, length ] of arrivals) {

    clock.advance(at - clock.monotonic());

    // The asking writer settles each write at once, so each fragment is awaited before the clock moves to the next arrival.
    // eslint-disable-next-line no-await-in-loop
    await feed.writeFragment(videoFragment(length).fragment);
  }

  return asks;
}

describe("Mp4FrameFeed", () => {

  test("writes the header whole", async () => {

    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock: new TestClock() });

    const header = makeInitSegment([ VIDEO, AUDIO ]);

    await new Mp4FrameFeed(writer).writeHeader(header);

    assert.deepEqual(wire(), header);
  });

  test("writes a fragment after a header with a video track frame by frame, each at its due time", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const feed = new Mp4FrameFeed(writer);
    const header = makeInitSegment([ VIDEO, AUDIO ]);
    const fragment = makeFragment({ samples: [ { duration: 9000, size: 10 }, { duration: 4500, size: 11 }, { duration: 9000, size: 12 } ], trackId: VIDEO.id });

    // The feed writes the pieces the reader cuts, so the wire at each moment is the header and the pieces due by then.
    const pieces = present(splitVideoFrames(fragment, VIDEO), "the fragment's frames");
    const upTo = (count: number): Buffer => Buffer.concat([ header, ...pieces.slice(0, count).map(({ bytes }) => bytes) ]);

    await feed.writeHeader(header);

    const written = feed.writeFragment(fragment);

    // The first frame goes out at once.
    assert.deepEqual(wire(), upTo(1));

    await settle();
    clock.advance(99);
    await settle();
    assert.deepEqual(wire(), upTo(1), "the second frame is not yet due");

    clock.advance(1);
    await settle();
    assert.deepEqual(wire(), upTo(2));

    clock.advance(49);
    await settle();
    assert.deepEqual(wire(), upTo(2), "the third frame is not yet due");

    clock.advance(1);
    await written;
    assert.deepEqual(wire(), Buffer.concat([ header, fragment ]));
  });

  test("writes whole a fragment before any header, after a header with no video track, and one the reader cannot cut", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const feed = new Mp4FrameFeed(writer);
    const samples = [ { duration: 9000, size: 10 }, { duration: 9000, size: 11 } ];
    const fragment = makeFragment({ samples, trackId: VIDEO.id });
    const unknownLayout = makeFragment({ header: { defaultBaseIsMoof: false }, samples, trackId: VIDEO.id });
    const audioHeader = makeInitSegment([AUDIO]);
    const videoHeader = makeInitSegment([ VIDEO, AUDIO ]);

    // Each write is issued without a clock advance, so a fragment that reached the wire whole by the time it settled was written whole.
    await feed.writeFragment(fragment);
    assert.deepEqual(wire(), fragment, "a fragment before any header");

    await feed.writeHeader(audioHeader);
    await feed.writeFragment(fragment);
    assert.deepEqual(wire(), Buffer.concat([ fragment, audioHeader, fragment ]), "a fragment after a header with no video track");

    await feed.writeHeader(videoHeader);
    await feed.writeFragment(unknownLayout);
    assert.deepEqual(wire(), Buffer.concat([ fragment, audioHeader, fragment, videoHeader, unknownLayout ]), "a fragment the reader cannot cut");

    assert.deepEqual(clock.requested, [], "nothing was held");
  });

  test("writes a fragment with no video in it whole and reports it as no-video, and a later one whose video the reader cannot cut as unreadable", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const reports: { fragment: Buffer; reason: Mp4UnpacedReason }[] = [];
    const feed = new Mp4FrameFeed(writer, { onUnpaced: (fragment, reason): void => void reports.push({ fragment, reason }) });
    const header = makeInitSegment([ VIDEO, AUDIO ]);

    // A fragment of the audio track alone, as FFmpeg writes when the audio outlasts the video, and a fragment of the video and the audio whose video track
    // fragment is in a layout the reader does not know.
    const audioOnly = makeFragment({ samples: AUDIO_SAMPLES, trackId: AUDIO.id });
    const unknownLayout = makeFragment({ header: { defaultBaseIsMoof: false }, samples: [ { duration: 9000, size: 10 }, { duration: 9000, size: 11 } ],
      secondTrack: { samples: AUDIO_SAMPLES, trackId: AUDIO.id }, trackId: VIDEO.id });

    await feed.writeHeader(header);

    // Issued without a clock advance, so a fragment that reached the wire whole by the time it settled was written whole.
    await feed.writeFragment(audioOnly);
    assert.deepEqual(wire(), Buffer.concat([ header, audioOnly ]));
    assert.equal(reports.length, 1);
    assert.equal(expectAt(reports, 0, "the no-video report").fragment, audioOnly, "the report carries the fragment written whole");
    assert.equal(expectAt(reports, 0, "the no-video report").reason, "no-video", "a fragment with no video in it reports as no-video");

    // The no-video report leaves the unreadable one unspent, so the next fragment the reader cannot cut still reports.
    await feed.writeFragment(unknownLayout);
    assert.deepEqual(wire(), Buffer.concat([ header, audioOnly, unknownLayout ]));
    assert.equal(reports.length, 2);
    assert.equal(expectAt(reports, 1, "the unreadable report").fragment, unknownLayout, "the report carries the fragment written whole");
    assert.equal(expectAt(reports, 1, "the unreadable report").reason, "unreadable");
    assert.deepEqual(clock.requested, [], "nothing was held");
  });

  test("replaces the video track with every header", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const feed = new Mp4FrameFeed(writer);
    const samples = [ { duration: 9000, size: 10 }, { duration: 0, size: 11 } ];
    const first = makeFragment({ samples, trackId: VIDEO.id });
    const second = makeFragment({ samples, trackId: OTHER_VIDEO.id });
    const firstHeader = makeInitSegment([ VIDEO, AUDIO ]);
    const secondHeader = makeInitSegment([ OTHER_VIDEO, AUDIO ]);
    const audioHeader = makeInitSegment([AUDIO]);
    const secondFirstPiece = expectAt(present(splitVideoFrames(second, OTHER_VIDEO), "the second fragment's frames"), 0, "its first frame").bytes;

    // Under the second header, a fragment of the first header's track holds no frame of the second's and goes out whole, while a fragment of the second header's
    // track is held at its second frame.
    await feed.writeHeader(firstHeader);
    await feed.writeHeader(secondHeader);
    await feed.writeFragment(first);

    const held = feed.writeFragment(second);

    assert.deepEqual(wire(), Buffer.concat([ firstHeader, secondHeader, first, secondFirstPiece ]));

    clock.advance(100);
    await held;

    // A header with no video track leaves nothing to cut at.
    await feed.writeHeader(audioHeader);
    await feed.writeFragment(second);
    assert.deepEqual(wire(), Buffer.concat([ firstHeader, secondHeader, first, second, audioHeader, second ]));
    assert.deepEqual(clock.requested, [100], "only the fragment of the header's own track was held");
  });

  test("reports the first fragment the reader cannot cut after each header with a video track, once, with that fragment, before its write", async () => {

    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock: new TestClock() });

    const reports: { fragment: Buffer; wire: Buffer }[] = [];
    const feed = new Mp4FrameFeed(writer, { onUnpaced: (fragment): void => void reports.push({ fragment, wire: Buffer.from(wire()) }) });
    const unreadable = makeFragment({ header: { defaultBaseIsMoof: false }, samples: [{ duration: 9000, size: 10 }], trackId: VIDEO.id });
    const another = makeFragment({ header: { defaultBaseIsMoof: false }, samples: [{ duration: 4500, size: 10 }], trackId: VIDEO.id });

    // Nothing to report before any header, after a header with no video track, or for a fragment the reader cuts.
    await feed.writeFragment(unreadable);
    await feed.writeHeader(makeInitSegment([AUDIO]));
    await feed.writeFragment(unreadable);
    await feed.writeHeader(makeInitSegment([ VIDEO, AUDIO ]));
    await feed.writeFragment(makeFragment({ samples: [{ duration: 0, size: 10 }], trackId: VIDEO.id }));
    assert.equal(reports.length, 0);

    const before = Buffer.from(wire());

    await feed.writeFragment(unreadable);
    await feed.writeFragment(another);

    assert.equal(reports.length, 1, "one report per header");
    assert.equal(expectAt(reports, 0, "the first report").fragment, unreadable, "the report carries the fragment written whole");
    assert.deepEqual(expectAt(reports, 0, "the first report").wire, before, "the report came before the fragment's write was issued");

    await feed.writeHeader(makeInitSegment([ VIDEO, AUDIO ]));
    await feed.writeFragment(another);

    assert.equal(reports.length, 2, "the next header reports again");
    assert.equal(expectAt(reports, 1, "the second report").fragment, another);
  });

  test("hands a writer's rejection to the caller", async () => {

    const stream = new PassThrough();
    const writer = new BackpressureWriter(() => stream, { clock: new TestClock() });
    const feed = new Mp4FrameFeed(writer);
    const reason = new HbpuAbortError("shutdown");
    const header = makeInitSegment([ VIDEO, AUDIO ]);

    await feed.writeHeader(header);
    writer.abort(reason);

    await assert.rejects(feed.writeHeader(header), (error: unknown) => error === reason);
    await assert.rejects(feed.writeFragment(makeFragment({ samples: [ { duration: 9000, size: 10 }, { duration: 0, size: 11 } ], trackId: VIDEO.id })),
      (error: unknown) => error === reason, "the paced write's rejection");
    await assert.rejects(feed.writeFragment(makeFragment({ header: { defaultBaseIsMoof: false }, samples: [{ duration: 9000, size: 10 }], trackId: VIDEO.id })),
      (error: unknown) => error === reason, "the plain write's rejection");
  });
});

describe("Mp4FrameFeed - the video's own time", () => {

  test("starts each fragment's first frame at once when the fragments arrive on the video's own time", async () => {

    // The clock starts a second in, so every arrival is late by the same second, and a feed that held a fragment by its own lateness would show it.
    const clock = new TestClock(1000);
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const feed = new Mp4FrameFeed(writer, { clock });
    const header = makeInitSegment([ VIDEO, AUDIO ]);
    const first = videoFragment(50, 50);
    const second = videoFragment(50, 50);

    await feed.writeHeader(header);

    const written = [feed.writeFragment(first.fragment)];

    assert.deepEqual(wire(), Buffer.concat([ header, ...first.pieces.slice(0, 1) ]), "the first frame goes out as its fragment arrives");

    await settle();
    clock.advance(49);
    await settle();
    assert.deepEqual(wire(), Buffer.concat([ header, ...first.pieces.slice(0, 1) ]), "the second frame is not yet due");

    // The next fragment arrives 100 ms on, when its first frame falls on the video's own time.
    clock.advance(51);
    await settle();
    written.push(feed.writeFragment(second.fragment));
    assert.deepEqual(wire(), Buffer.concat([ header, ...first.pieces, ...second.pieces.slice(0, 1) ]), "the next first frame goes out as its fragment arrives");

    await settle();
    clock.advance(49);
    await settle();
    assert.deepEqual(wire(), Buffer.concat([ header, ...first.pieces, ...second.pieces.slice(0, 1) ]), "the next second frame is not yet due");

    clock.advance(1);
    await Promise.all(written);
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment, second.fragment ]));
    assert.deepEqual(clock.requested, [ 50, 50 ], "no first frame waited for a start");
  });

  test("the target rises at once to a later arrival, and the fragments after it are held to it as it falls", async () => {

    // A 500 ms frame on the video's own time, then a 600 ms frame arriving 100 ms late, which raises the target to 100 at once, and then 500 ms frames back on
    // the video's own time, each held to the target as it falls 1 ms in each half second between arrivals.
    assert.deepEqual(await asksOver([ [ 0, 500 ], [ 600, 600 ], [ 1100, 500 ], [ 1600, 500 ] ]), [ 0, 0, 99, 98 ]);
  });

  test("the target falls 2 ms for each second between arrivals and never below the arrival in hand", async () => {

    // A frame arriving 100 ms late raises the target to 100. The next two arrive on the video's own time a second apart and are held to the target as it falls to
    // 98 and 96. The one after arrives 95 ms late, above the 94 the target would fall to, so the target stops at 95 and that frame asks nothing, and the next,
    // on the video's own time again a second later, is held to 93.
    assert.deepEqual(await asksOver([ [ 100, 1100 ], [ 1100, 1000 ], [ 2100, 905 ], [ 3100, 1095 ], [ 4100, 1000 ] ]), [ 0, 98, 96, 0, 93 ]);
  });

  test("a stall past the ceiling is asked no hold, and the target it leaves is the ceiling, 200 ms above the floor", async () => {

    // A second-long frame on the video's own time sets the floor, and then a stall: the next frame arrives 500 ms late, 300 ms past the ceiling, so it asks no
    // hold and the target is held to the ceiling. A second later the next arrives on the video's own time and is held to the ceiling less a second's fall.
    assert.deepEqual(await asksOver([ [ 0, 1000 ], [ 1500, 1500 ], [ 2500, 1000 ] ]), [ 0, 0, 198 ]);
  });

  test("a target the ceiling holds fades back to the arrivals' own lateness within the ceiling divided by the rate of its fall", async () => {

    // A stall leaves the target at the ceiling, 200 ms above the arrivals on the video's own time. Each second-long frame after it arrives on the video's own time
    // and is held to the target as it falls 2 ms a second, so the frame 100 seconds after the stall asks nothing.
    const asks = await asksOver([ [ 0, 1000 ], [ 1200, 1200 ], ...Array.from({ length: 100 }, (_, second): [ number, number ] => [ 2200 + (1000 * second), 1000 ]) ]);

    assert.deepEqual(asks, [ 0, 0, ...Array.from({ length: 100 }, (_, second) => 198 - (2 * second)) ]);
  });

  for(const [ gap, ask, counted ] of [ [ 1999, 50, true ], [ 2000, 149, false ] ] as const) {

    test("an arrival " + (counted ? "a millisecond less than the floor's window before the newest still sets the floor" :
      "exactly the floor's window before the newest has left the floor's window"), async () => {

      // A frame on the video's own time, then a stall the gap after it, 299 ms late at 1999 ms and 300 ms late at 2000 ms. While the first arrival is in the
      // floor's window the ceiling 200 ms above it holds the stall's target to 200, and once it has left, the stall's own lateness is the floor and the target.
      // Half a second on, the next arrival, 149 or 150 ms late, reads the target the stall left, less half a second's fall.
      assert.deepEqual(await asksOver([ [ 0, 1700 ], [ gap, 650 ], [ gap + 500, 500 ] ]), [ 0, 0, ask ]);
    });
  }

  test("a header starts the target, the floor and the video's clock afresh", async () => {

    const clock = new TestClock();
    const { asks, writer } = askingWriter();
    const feed = new Mp4FrameFeed(writer, { clock });
    const header = makeInitSegment([ VIDEO, AUDIO ]);

    // A second-long frame on the video's own time puts a lateness of nothing in the floor. Half a second later a header starts the stream over and a frame
    // arrives 500 ms late on the new stream's time, and a second after it another 50 ms less late, held to the first one's lateness less a second's fall. A floor
    // that kept the arrival from before the header would hold the first frame's target to the ceiling above it, and the second would ask nothing. The target
    // and the clock start afresh as well, though no ask shows the target's start or the clock's: the target before a header never stands above the first
    // lateness after it, and a clock carried across a header moves every lateness after it by one amount, where the rule reads only their differences.
    await feed.writeHeader(header);
    await feed.writeFragment(videoFragment(1000).fragment);
    clock.advance(500);
    await feed.writeHeader(header);
    await feed.writeFragment(videoFragment(1050).fragment);
    clock.advance(1000);
    await feed.writeFragment(videoFragment(1000).fragment);

    assert.deepEqual(asks, [ 0, 0, 48 ]);
  });

  test("a header after a quiet gap starts the floor afresh, so the old stream's arrival holds no target of the new stream's down", async () => {

    const clock = new TestClock();
    const { asks, writer } = askingWriter();
    const feed = new Mp4FrameFeed(writer, { clock });
    const header = makeInitSegment([ VIDEO, AUDIO ]);

    // A 100 ms frame on the video's own time, then nothing for a second, so the clock runs well past the video's time. A header then starts the stream over, a
    // 550 ms frame arrives 50 ms after it, and half a second on the next arrives 50 ms less late, held to the first one's lateness less half a second's fall. A
    // header that kept the floor would hold both targets to the ceiling above the old stream's arrival, and the second frame would ask nothing, whether or not
    // the video's clock carried over with it.
    await feed.writeHeader(header);
    await feed.writeFragment(videoFragment(100).fragment);
    clock.advance(1000);
    await feed.writeHeader(header);
    clock.advance(50);
    await feed.writeFragment(videoFragment(550).fragment);
    clock.advance(500);
    await feed.writeFragment(videoFragment(550).fragment);

    assert.deepEqual(asks, [ 0, 0, 49 ]);
  });

  test("a fragment the writer refuses still enters the target and the floor, because the rule reads its arrival before the write is issued", async () => {

    const clock = new TestClock();
    const { asks, writer } = askingWriter(2);
    const feed = new Mp4FrameFeed(writer, { clock });

    // One-frame fragments. The first arrives on the video's own time and the second 100 ms late, which raises the target to 100. The third, which the writer
    // refuses, arrives 400 ms early, so it puts that lateness in the floor and holds the target to the ceiling 200 ms above it. A second later the fourth, 300 ms
    // early, is held to that target less a second's fall, which it reads only if the refused fragment entered the target. Half a second on, the fifth arrives
    // past the ceiling and asks nothing, and a quarter second after it the sixth, 300 ms early again, is held to the ceiling the refused fragment's lateness
    // still sets, less a quarter second's fall, which it reads only if that fragment entered the floor.
    await feed.writeHeader(makeInitSegment([ VIDEO, AUDIO ]));

    for(const [ at, length ] of [ [ 0, 1000 ], [ 1100, 1000 ], [ 1600, 900 ], [ 2600, 200 ], [ 3100, 550 ], [ 3350, 500 ] ] as const) {

      clock.advance(at - clock.monotonic());

      const written = feed.writeFragment(videoFragment(length).fragment);

      // eslint-disable-next-line no-await-in-loop
      await ((at === 1600) ? assert.rejects(written, BackpressureOverflowError) : written);
    }

    assert.deepEqual(asks, [ 0, 0, 200, 98, 0, 99.5 ]);
  });

  test("one fragment in every few arriving more than a fragment's length late leaves every frame after the first late one within a millisecond of a frame apart",
    async () => {

      const clock = new TestClock();
      const stream = new TimedPassThrough(clock);

      await using writer = new BackpressureWriter(() => stream, { clock });

      const feed = new Mp4FrameFeed(writer, { clock });
      const written = [feed.writeHeader(makeInitSegment([ VIDEO, AUDIO ]))];

      // Fragments of four 25 ms frames, ten a second, each issued as it arrives without awaiting the one before it. The third of every five arrives 150 ms late,
      // more than a fragment's length, and the fourth arrives right behind it, 60 ms late.
      const lateBy = new Map([ [ 2, 150 ], [ 3, 60 ] ]);

      for(let index = 0; index < 20; index++) {

        const arrival = (100 * index) + (lateBy.get(index % 5) ?? 0);

        // Every wait that falls due before the arrival ends first, each at its own deadline, so each piece leaves at the reading it was due at.
        for(let due = clock.nextDeadline; (due !== null) && (due <= arrival); due = clock.nextDeadline) {

          clock.advanceToNext();
          // eslint-disable-next-line no-await-in-loop
          await settle();
        }

        clock.advance(arrival - clock.monotonic());
        written.push(feed.writeFragment(videoFragment(25, 25, 25, 25).fragment));
        // eslint-disable-next-line no-await-in-loop
        await settle();
      }

      await drainClock(clock);
      await Promise.all(written);

      // The header is the first write, and the first late fragment is the third, so its first frame is the ninth piece after the header.
      const frames = stream.sentAt.slice(1 + (2 * 4));
      const spacing = frames.slice(1).map((at, index) => at - expectAt(frames, index, "the frame before it"));

      assert.equal(frames.length, 18 * 4);
      assert.deepEqual(spacing.filter((gap) => Math.abs(gap - 25) >= 1), [],
        "every frame after the first late one leaves within a millisecond of a frame after the one before it");
    });

  test("a header starts the video's clock afresh, emptying the sum and the window", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const feed = new Mp4FrameFeed(writer, { clock });
    const header = makeInitSegment([ VIDEO, AUDIO ]);
    const before = videoFragment(400).fragment;
    const after = videoFragment(50, 50);

    // A 400 ms frame arrives 500 ms in. Measured against it, a fragment 100 ms later would be 300 ms less late and wait the 200 ms the ceiling allows, but a
    // header comes between them.
    clock.advance(500);
    await feed.writeHeader(header);
    await feed.writeFragment(before);
    await feed.writeHeader(header);
    clock.advance(100);

    const written = feed.writeFragment(after.fragment);

    assert.deepEqual(wire(), Buffer.concat([ header, before, header, ...after.pieces.slice(0, 1) ]), "the first fragment after the header starts at once");

    await settle();
    clock.advance(49);
    await settle();
    assert.deepEqual(wire(), Buffer.concat([ header, before, header, ...after.pieces.slice(0, 1) ]), "its second frame is not yet due");

    clock.advance(1);
    await written;
    assert.deepEqual(wire(), Buffer.concat([ header, before, header, after.fragment ]));
    assert.deepEqual(clock.requested, [50]);
  });

  test("reports each reason once per header, before its write, independently of the other", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const reports: { fragment: Buffer; reason: Mp4UnpacedReason; sent: Buffer }[] = [];
    const feed = new Mp4FrameFeed(writer, { clock, onUnpaced: (fragment, reason): void => void reports.push({ fragment, reason, sent: Buffer.from(wire()) }) });
    const header = makeInitSegment([ VIDEO, AUDIO ]);
    const audioOnly = makeFragment({ samples: AUDIO_SAMPLES, trackId: AUDIO.id });
    const unreadable = makeFragment({ header: { defaultBaseIsMoof: false }, samples: [{ duration: 9000, size: 10 }], trackId: VIDEO.id });

    await feed.writeHeader(header);
    await feed.writeFragment(audioOnly);
    await feed.writeFragment(audioOnly);
    await feed.writeFragment(unreadable);
    await feed.writeFragment(unreadable);
    await feed.writeFragment(audioOnly);

    assert.deepEqual(reports.map(({ reason }) => reason), [ "no-video", "unreadable" ], "each reason reports once, the no-video report spending nothing of the other");
    assert.equal(expectAt(reports, 0, "the no-video report").fragment, audioOnly);
    assert.deepEqual(expectAt(reports, 0, "the no-video report").sent, header, "the report came before its fragment's write was issued");
    assert.equal(expectAt(reports, 1, "the unreadable report").fragment, unreadable);
    assert.deepEqual(expectAt(reports, 1, "the unreadable report").sent, Buffer.concat([ header, audioOnly, audioOnly ]));

    // The next header reports each reason again, in the order its fragments meet them.
    await feed.writeHeader(header);
    await feed.writeFragment(unreadable);
    await feed.writeFragment(audioOnly);

    assert.deepEqual(reports.map(({ reason }) => reason), [ "no-video", "unreadable", "unreadable", "no-video" ]);
    assert.deepEqual(wire(), Buffer.concat([ header, audioOnly, audioOnly, unreadable, unreadable, audioOnly, header, unreadable, audioOnly ]));
    assert.deepEqual(clock.requested, [], "nothing was held");
  });

  test("a fragment written whole reads no clock and changes no delay, between paced fragments, before any header and after a header with no video track",
    async () => {

      const clock = new CountingClock();
      const stream = new PassThrough();
      const wire = wireOf(stream);

      await using writer = new BackpressureWriter(() => stream, { clock });

      const feed = new Mp4FrameFeed(writer, { clock });
      const audioHeader = makeInitSegment([AUDIO]);
      const videoHeader = makeInitSegment([ VIDEO, AUDIO ]);
      const audioOnly = makeFragment({ samples: AUDIO_SAMPLES, trackId: AUDIO.id });
      const unreadable = makeFragment({ header: { defaultBaseIsMoof: false }, samples: [{ duration: 9000, size: 10 }], trackId: VIDEO.id });
      const first = videoFragment(300).fragment;
      const second = videoFragment(100).fragment;

      await feed.writeFragment(first);
      assert.equal(clock.readings, 0, "a fragment before any header reads no clock");

      await feed.writeHeader(audioHeader);
      await feed.writeFragment(first);
      assert.equal(clock.readings, 0, "a fragment after a header with no video track reads no clock");

      // A 300 ms frame arrives 200 ms in, and 250 ms later come a fragment of each kind written whole and then the next frame, 50 ms less late, which waits those
      // 50 ms less the half millisecond the target falls in the 250 ms between the paced arrivals.
      clock.advance(200);
      await feed.writeHeader(videoHeader);
      await feed.writeFragment(first);
      clock.advance(250);

      const readings = clock.readings;

      await feed.writeFragment(audioOnly);
      await feed.writeFragment(unreadable);
      assert.equal(clock.readings, readings, "a fragment written whole between paced ones reads no clock");

      const written = feed.writeFragment(second);

      await settle();
      assert.deepEqual(wire(), Buffer.concat([ first, audioHeader, first, videoHeader, first, audioOnly, unreadable ]), "the next fragment waits for its start");

      clock.advance(49);
      await settle();
      assert.deepEqual(wire(), Buffer.concat([ first, audioHeader, first, videoHeader, first, audioOnly, unreadable ]), "the next fragment is not yet due");

      clock.advance(1);
      await written;
      assert.deepEqual(wire(), Buffer.concat([ first, audioHeader, first, videoHeader, first, audioOnly, unreadable, second ]));
      assert.deepEqual(clock.requested, [49.5], "the delay is the one the paced fragments give alone");
    });

  test("a wall clock stepped back between arrivals changes no delay", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    await using writer = new BackpressureWriter(() => stream, { clock });

    const feed = new Mp4FrameFeed(writer, { clock });
    const header = makeInitSegment([ VIDEO, AUDIO ]);
    const first = videoFragment(50, 50);
    const second = videoFragment(50, 50);

    await feed.writeHeader(header);

    const written = [feed.writeFragment(first.fragment)];

    await settle();
    clock.advance(100);
    await settle();

    // The wall clock is set back a second between the arrivals, while the monotonic reading moves on, so the next fragment still arrives on the video's own time.
    clock.advance(-1000);
    written.push(feed.writeFragment(second.fragment));
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment, ...second.pieces.slice(0, 1) ]), "the next fragment starts at once");

    await settle();
    clock.advance(49);
    await settle();
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment, ...second.pieces.slice(0, 1) ]), "its second frame is not yet due");

    clock.advance(1);
    await Promise.all(written);
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment, second.fragment ]));
    assert.deepEqual(clock.requested, [ 50, 50 ]);
  });

  test("counts the time of a fragment the writer refuses, because its frames' time passed in the stream whether or not they reached FFmpeg", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();
    const wire = wireOf(stream);

    // A queue limit of one refuses a fragment issued while the one before it still holds a frame.
    await using writer = new BackpressureWriter(() => stream, { clock, highWaterMark: 1 });

    const feed = new Mp4FrameFeed(writer, { clock });
    const header = makeInitSegment([ VIDEO, AUDIO ]);
    const first = videoFragment(50, 50);
    const refused = videoFragment(50, 50);
    const third = videoFragment(50, 50);

    await feed.writeHeader(header);

    const written = [feed.writeFragment(first.fragment)];

    await settle();
    clock.advance(10);
    await assert.rejects(feed.writeFragment(refused.fragment), BackpressureOverflowError);

    // The third fragment arrives 150 ms in. Counting the refused fragment's 100 ms, its first frame falls 200 ms into the video, 50 ms less late than the first
    // fragment's, so it waits those 50 ms less the fraction of a millisecond the target falls in the 150 ms since the first arrival.
    await settle();
    clock.advance(140);
    await settle();
    written.push(feed.writeFragment(third.fragment));
    await settle();
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment ]), "the third fragment waits for its start");

    clock.advance(49);
    await settle();
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment ]), "the third fragment is not yet due");

    clock.advance(1);
    await settle();
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment, ...third.pieces.slice(0, 1) ]));

    clock.advance(49);
    await settle();
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment, ...third.pieces.slice(0, 1) ]), "its second frame is not yet due");

    clock.advance(1);
    await Promise.all(written);
    assert.deepEqual(wire(), Buffer.concat([ header, first.fragment, third.fragment ]));
  });

  test("takes a report that reads the fragment alone", async () => {

    const clock = new TestClock();
    const stream = new PassThrough();

    await using writer = new BackpressureWriter(() => stream, { clock });

    // A report of one parameter is a report the init accepts, so a plugin that logs every reason the same way names none.
    const reports: Buffer[] = [];
    const onUnpaced: Mp4FrameFeedInit["onUnpaced"] = (fragment: Buffer): void => {

      reports.push(fragment);
    };

    const feed = new Mp4FrameFeed(writer, { clock, onUnpaced });
    const audioOnly = makeFragment({ samples: AUDIO_SAMPLES, trackId: AUDIO.id });

    await feed.writeHeader(makeInitSegment([ VIDEO, AUDIO ]));
    await feed.writeFragment(audioOnly);

    assert.equal(reports.length, 1);
    assert.equal(expectAt(reports, 0, "the report"), audioOnly);
  });
});
