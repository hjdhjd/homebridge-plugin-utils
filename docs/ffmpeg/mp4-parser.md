[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/mp4-parser

# ffmpeg/mp4-parser

Pure stateful byte-to-record parser for ISO BMFF (fMP4) box streams.

This module ships the streaming counterpart to the static predicates in [fmp4](fmp4.md). The predicates (`findBox`, `isKeyframe`, `hasAudioTrack`,
`splitMoofMdat`) answer one-shot questions about a complete Buffer. [Mp4BoxParser](#mp4boxparser) solves a different problem: incrementally consuming an unbounded byte stream
(typically FFmpeg stdout producing fMP4 fragments) and emitting each complete box as it becomes available.

The parser is intentionally signal-free, event-free, and allocation-light. It carries only the bytes of an incomplete trailing box across calls and hands out
zero-copy `subarray` views whenever possible. Resource lifetime, async consumption, and cancellation are not this class's job - those belong to the composing
caller (see [Mp4SegmentAssembler](mp4-assembler.md#mp4segmentassembler)).

## FFmpeg

### Mp4BoxParser

Pure stateful parser that converts a stream of ISO BMFF byte chunks into discrete [Mp4Box](#mp4box) records.

Feed each chunk from the byte source through [Mp4BoxParser.consume](#consume) and iterate the returned values for every complete box now available. The parser carries
only the bytes of an incomplete trailing box across calls; chunk boundaries in the middle of a box are handled transparently. A single chunk may produce zero, one, or
many boxes depending on how the stream falls on chunk boundaries.

The class is intentionally signal-free and event-free. It performs one job, synchronously, and leaves resource lifecycle and async consumption to the composing
caller - typically [Mp4SegmentAssembler](mp4-assembler.md#mp4segmentassembler) for fMP4 streams driven by an FFmpeg process.

#### Remarks

**Trust boundary.** The parser does not bound the size field it reads from the wire. A source that claims a multi-gigabyte box size would cause the parser
to accumulate incoming chunks into its internal pending buffer until the declared box completes. This is safe for trusted sources like FFmpeg stdout, where the
size field reflects the actual payload. Callers feeding untrusted byte streams (e.g., user-uploaded media, network input from arbitrary peers) should impose their
own bound - either by truncating chunks that would exceed a budget, or by wrapping the parser in a guard that rejects implausibly large declared sizes before
feeding the chunk.

#### Example

```ts
import { BOX_TYPE_MDAT, Mp4BoxParser } from "homebridge-plugin-utils";

const parser = new Mp4BoxParser();

for(const box of parser.consume(chunk)) {

  if(box.type === BOX_TYPE_MDAT) {

    // We have just received a complete mdat box.
  }
}
```

#### See

Mp4SegmentAssembler

#### Constructors

##### Constructor

```ts
new Mp4BoxParser(): Mp4BoxParser;
```

###### Returns

[`Mp4BoxParser`](#mp4boxparser)

#### Methods

##### consume()

```ts
consume(chunk): Iterable<Mp4Box>;
```

Feed the parser a new byte chunk and yield every complete box now available.

The iterable is single-pass: consume it with a `for...of` loop (or spread into an array) before the next call to `consume`. Emitted `bytes` are typically
zero-copy subarray views over the input chunk; copy with `Buffer.from()` if you intend to hold a box past the upstream chunk's lifetime.

Chunk boundaries in the middle of a box are handled internally: the incomplete trailing bytes are stashed and prepended to the next call's input.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `chunk` | `Buffer` | A contiguous slice of box-stream bytes from the source. |

###### Returns

`Iterable`\<[`Mp4Box`](#mp4box)\>

An iterable of every box contained in (or completed by) this chunk, in stream order.

***

### Mp4Box

A complete parsed ISO BMFF box emitted by [Mp4BoxParser](#mp4boxparser).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="bytes"></a> `bytes` | `Buffer` | The complete box bytes, including the 8-byte header. The buffer is typically a zero-copy subarray view over the feed chunk; consumers that need to hold it past the iteration loop should copy with `Buffer.from()` if the upstream chunk lifetime is suspect. |
| <a id="type"></a> `type` | `number` | The box type encoded as a 32-bit big-endian integer. Compare against the `BOX_TYPE_*` constants exported from this module; numeric comparison avoids the per-box string allocation that an ASCII tag comparison would incur. |

***

### BOX\_TYPE\_FTYP

```ts
const BOX_TYPE_FTYP: 1718909296 = 0x66747970;
```

ISO BMFF box type code for the `ftyp` (file type) box, encoded as a 32-bit big-endian integer. Useful for branching on [Mp4Box.type](#type) without re-encoding
the 4-character ASCII tag on every comparison.

***

### BOX\_TYPE\_MDAT

```ts
const BOX_TYPE_MDAT: 1835295092 = 0x6D646174;
```

ISO BMFF box type code for the `mdat` (media data) box. The mdat box carries the sample payload for the preceding `moof` in an fMP4 fragment and is the end-of-segment
marker that [Mp4SegmentAssembler](mp4-assembler.md#mp4segmentassembler) watches for.

***

### BOX\_TYPE\_MOOF

```ts
const BOX_TYPE_MOOF: 1836019558 = 0x6D6F6F66;
```

ISO BMFF box type code for the `moof` (movie fragment) box. Marks the start of a new fMP4 media fragment; the first `moof` in a stream also marks the end of the
initialization segment.

***

### BOX\_TYPE\_MOOV

```ts
const BOX_TYPE_MOOV: 1836019574 = 0x6D6F6F76;
```

ISO BMFF box type code for the `moov` (movie) box. Part of the initialization segment that precedes the first `moof` in an fMP4 stream.
