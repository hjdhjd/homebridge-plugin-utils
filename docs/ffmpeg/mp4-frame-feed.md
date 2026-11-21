[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/mp4-frame-feed

# ffmpeg/mp4-frame-feed

Feeds an fMP4 stream to a [BackpressureWriter](../backpressure.md#backpressurewriter) one video frame at a time.

FFmpeg passes each frame on as its bytes arrive, so a fragment written into its stdin whole leaves FFmpeg as a burst of frames and then a gap, and a viewer sees
the motion stutter at every fragment. [Mp4FrameFeed](#mp4framefeed) joins the reader and the paced write that fix it:
[splitVideoFrames](fmp4.md#splitvideoframes) cuts each fragment at its video frames, and
[BackpressureWriter.writePaced](../backpressure.md#writepaced) writes the pieces a frame's duration apart, the first after a start delay the
feed reads from the video's own time.

## FFmpeg

### Mp4FrameFeed

Feeds an fMP4 stream to a writer: the stream's header whole, and each fragment as its video frames, the first when the video's own time says it is due and each
later one a frame's duration after the one before it.

The feed is handed a writer and never builds one, so the writer's stream, lifetime, queue limit and clock stay the plugin's own. A fragment arrives once its last
frame is captured, so how late its first frame reaches the feed varies with how many frames it holds and with the network, and writing each first frame as it
arrives would bunch some frames and leave gaps after others. The feed keeps a clock of the video's own time instead: the sum of the video durations it has handed
to the writer since the last header, which is when the next fragment's first frame falls on the video's timeline. A fragment's lateness is its arrival less that
sum, and the feed holds its first frame by a target lateness less its own, so first frames leave the feed at one lateness and every frame keeps the spacing it
was recorded with. The target rises at once to an arrival later than it and falls slowly while arrivals come in earlier, never below the lateness in hand,
and all of that is held to a ceiling above the floor, the smallest lateness of a short window of recent arrivals: an arrival later than the ceiling is held by
nothing and leaves the target at the ceiling. So jitter that recurs is paced at the lateness of the latest late arrival, and a stall leaves the stream no more
than the ceiling behind its floor. The sum, the target and the floor count every fragment handed
to the paced write, so one the writer refuses, drops or rejects has entered each of them, because its frames' time passed in the stream whether or not they
reached FFmpeg.

A fragment the reader cuts goes to the writer's paced write with its start delay. A fragment with no video in it, and one the reader cannot cut, go to its plain
write whole, enter none of the sum, the target and the floor, and are reported through `onUnpaced` once per header for each reason. A fragment before any
header, or after a header that names no video track, goes to the plain write whole and is not reported. So a fragment always reaches FFmpeg, paced or not, as
long as `onUnpaced` does not throw. A fragment written whole is a plain write, so one queued behind a held fragment waits for that fragment's start, and the
held fragment then sends the frames it has left at once, ahead of it. The feed holds no timer, signal or queue of its own and has nothing to dispose.

Every new FFmpeg process needs the stream's header before any fragment, so a plugin hands the feed the header again whenever it starts one, and each header
starts the video's clock, the target and the floor afresh. Fragments already queued when a header is written go out ahead of it, each after its hold, so a
plugin that needs a new process to open on its header builds that process a writer of its own. The fragments' layout is their producer's: a layout the reader
does not know ends the pacing but never the stream, and `onUnpaced` is how a plugin learns that has happened.

The feed never asks for more than 200 ms of added delay: no fragment's first frame is held longer than that. Write each fragment without awaiting the one
before it, because the frames a fragment has left go out at once when the next one is due, and that catch-up is what keeps a late fragment from making every
later one late too. A writer's queue limit therefore needs room for every fragment that arrives within 200 ms, with the one holding and the next, because a
lower limit refuses fragments, and their frames are lost. Saved video a plugin opens a process on goes in with the header, which may carry fragments after it,
or through the writer's plain write, because `writeFragment` reads every arrival as live.

#### Example

```ts
import { BackpressureWriter, Mp4FrameFeed } from "homebridge-plugin-utils";

const writer = new BackpressureWriter(() => ffmpegProcess.stdin ?? null, { signal: session.signal });
const feed = new Mp4FrameFeed(writer, { onUnpaced: (fragment, reason) => log.warn("A fragment is written whole.", { bytes: fragment.length, reason }) });

// The header goes to every new FFmpeg process first.
feed.writeHeader(initSegment).catch((error: unknown) => log.debug("The header write ended early.", { error }));

// Each fragment is issued as it arrives, without awaiting the one before it.
camera.on("fragment", (fragment: Buffer) => {

  feed.writeFragment(fragment).catch((error: unknown) => log.debug("A fragment write ended early.", { error }));
});
```

#### Constructors

##### Constructor

```ts
new Mp4FrameFeed(writer, init?): Mp4FrameFeed;
```

Build a feed over a writer.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `writer` | [`Mp4FrameFeedWriter`](#mp4framefeedwriter) | The writer the feed writes through, typically a [BackpressureWriter](../backpressure.md#backpressurewriter) over an FFmpeg process's stdin. |
| `init?` | [`Mp4FrameFeedInit`](#mp4framefeedinit) | Optional init options. See [Mp4FrameFeedInit](#mp4framefeedinit). |

###### Returns

[`Mp4FrameFeed`](#mp4framefeed)

#### Methods

##### writeFragment()

```ts
writeFragment(fragment): Promise<void>;
```

Write a fragment as its video frames, the first after the start delay the video's own time gives it and each later one when it is due, or whole when there is
no video track to cut it at, when it holds no video, or when the reader cannot cut it.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `fragment` | `Buffer` | One complete fragment of the stream. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

The writer's paced write of the fragment's pieces, or its plain write of the whole fragment.

##### writeHeader()

```ts
writeHeader(header): Promise<void>;
```

Write the stream's header whole, read its video track for the fragments that follow it, and start the video's clock, the target and the floor afresh.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `header` | `Buffer` | The stream's initialization segment, alone or followed by fragments. |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

The writer's plain write of the header.

***

### Mp4FrameFeedInit

Construction options for [Mp4FrameFeed](#mp4framefeed).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="clock"></a> `clock?` | [`Clock`](../clock.md#clock) | The time source the feed reads each fragment's arrival from. Pass the writer's clock: the feed measures a fragment's start delay on this clock and the writer holds it on its own, so the two have to read the same time. Defaults to [systemClock](../clock.md#systemclock), which is the writer's default too. |
| <a id="onunpaced"></a> `onUnpaced?` | (`fragment`, `reason`) => `void` | Called with a fragment the feed is about to write whole although the header named a video track, and why. It fires once per header for each [Mp4UnpacedReason](#mp4unpacedreason), for the first such fragment after it, before that fragment's write is issued, so a plugin decides which reasons earn a log line and writes each once rather than once per fragment. It must not throw. It runs before the fragment's write is issued, so a throw rejects that fragment's [Mp4FrameFeed.writeFragment](#writefragment) with the write never issued. |

***

### Mp4FrameFeedWriter

```ts
type Mp4FrameFeedWriter = Pick<BackpressureWriter, "write" | "writePaced">;
```

The part of a [BackpressureWriter](../backpressure.md#backpressurewriter) an [Mp4FrameFeed](#mp4framefeed) writes through: the plain write and the paced write.

***

### Mp4UnpacedReason

```ts
type Mp4UnpacedReason = "no-video" | "unreadable";
```

Why an [Mp4FrameFeed](#mp4framefeed) wrote a fragment whole although the header before it named a video track, as its `onUnpaced` report states it.

- `"no-video"` - no track fragment in the fragment names the header's video track, as in a fragment of audio alone. A `moof` whose walk of its track fragments
  meets a box the reader cannot read reads this way too, because the walk ends there with no track fragment naming the track.
- `"unreadable"` - the fragment has no `moof` or no `mdat` after it, or the track fragment that names the video track is in a layout the frame reader does not
  know, so it cannot be cut at its frames.
