[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/fmp4

# ffmpeg/fmp4

ISO BMFF (fMP4) box parsing utilities for working with fragmented MP4 data.

This module provides lightweight, Buffer-based utilities for inspecting ISO Base Media File Format (ISO BMFF) structures commonly found in fragmented MP4 (fMP4)
streams. It enables locating specific box types, splitting fragments into their moof/mdat components, finding a fragment's first keyframe (sync sample) from its
samples' flags and whether a decoder can take the fragment from its first byte, identifying audio track presence in initialization segments, finding an
initialization segment's video track, and cutting a fragment into pieces that each end where one of that track's frames ends, with the frame's duration, for a
paced write.

These utilities operate on complete Buffers and are independent of FFmpeg processes or streaming pipelines.

## FFmpeg

### FMp4Box

Describes the location of an ISO BMFF box within a buffer.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="offset"></a> `offset` | `readonly` | `number` | The byte offset of the box start (including the header). |
| <a id="size"></a> `size` | `readonly` | `number` | The total box size in bytes (including the header). |

***

### FMp4Track

A track of an fMP4 stream as [findVideoTrack](#findvideotrack) reads it from an initialization segment: what a track fragment names it by, and the unit its durations are in.

#### Extended by

- [`InitSegmentTrack`](fmp4-builders.md#initsegmenttrack)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="id"></a> `id` | `readonly` | `number` | The track's `track_ID`, which each of its track fragments names in its `tfhd`. |
| <a id="timescale"></a> `timescale` | `readonly` | `number` | The track's media timescale, the number of duration ticks in one second. |

***

### BOX\_HEADER\_SIZE

```ts
const BOX_HEADER_SIZE: 8 = 8;
```

ISO BMFF box header size in bytes: 4 bytes big-endian size + 4 bytes ASCII type.

***

### HDLR\_TYPE\_SOUN

```ts
const HDLR_TYPE_SOUN: 1936684398 = 0x736F756E;
```

Handler-type code for audio tracks in ISO BMFF `hdlr` boxes: ASCII `"soun"` encoded as a 32-bit big-endian integer. Compared against the `handler_type` field of
each track's `hdlr` fullbox to identify the audio track during init-segment inspection.

***

### HDLR\_TYPE\_VIDE

```ts
const HDLR_TYPE_VIDE: 1986618469 = 0x76696465;
```

Handler-type code for video tracks in ISO BMFF `hdlr` boxes: ASCII `"vide"` encoded as a 32-bit big-endian integer. Compared against the `handler_type` field of
each track's `hdlr` fullbox to find the video track during init-segment inspection.

***

### SAMPLE\_FLAG\_NON\_SYNC

```ts
const SAMPLE_FLAG_NON_SYNC: 65536 = 0x00010000;
```

Sample-flags bit indicating a non-sync (non-keyframe) sample. When this bit is clear (0), the sample is a sync sample / IDR frame / keyframe.

***

### TFHD\_FLAG\_BASE\_DATA\_OFFSET

```ts
const TFHD_FLAG_BASE_DATA_OFFSET: 1 = 0x000001;
```

TFHD fullbox flags bit indicating that a 64-bit `base_data_offset` field follows the track_ID, so the track fragment's data offsets are measured from that
position rather than from the moof.

***

### TFHD\_FLAG\_DEFAULT\_BASE\_IS\_MOOF

```ts
const TFHD_FLAG_DEFAULT_BASE_IS_MOOF: 131072 = 0x020000;
```

TFHD fullbox flags bit indicating that the track fragment's data offsets are measured from the start of its moof, the layout FFmpeg's `default_base_moof` movflag
writes.

***

### TFHD\_FLAG\_DEFAULT\_SAMPLE\_DURATION

```ts
const TFHD_FLAG_DEFAULT_SAMPLE_DURATION: 8 = 0x000008;
```

TFHD fullbox flags bit indicating that a 4-byte `default_sample_duration` field follows, the duration of every sample whose TRUN entry carries none.

***

### TFHD\_FLAG\_DEFAULT\_SAMPLE\_FLAGS

```ts
const TFHD_FLAG_DEFAULT_SAMPLE_FLAGS: 32 = 0x000020;
```

TFHD fullbox flags bit indicating that a 4-byte `default_sample_flags` field follows, the flags of every sample whose TRUN entry carries none.

***

### TFHD\_FLAG\_DEFAULT\_SAMPLE\_SIZE

```ts
const TFHD_FLAG_DEFAULT_SAMPLE_SIZE: 16 = 0x000010;
```

TFHD fullbox flags bit indicating that a 4-byte `default_sample_size` field follows, the size of every sample whose TRUN entry carries none.

***

### TFHD\_FLAG\_SAMPLE\_DESCRIPTION\_INDEX

```ts
const TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX: 2 = 0x000002;
```

TFHD fullbox flags bit indicating that a 4-byte `sample_description_index` field follows, after the base data offset if present.

***

### TRUN\_FLAG\_DATA\_OFFSET

```ts
const TRUN_FLAG_DATA_OFFSET: 1 = 0x000001;
```

TRUN fullbox flags bit indicating that a `data_offset` field follows the sample_count in the box header.

***

### TRUN\_FLAG\_FIRST\_SAMPLE\_FLAGS

```ts
const TRUN_FLAG_FIRST_SAMPLE_FLAGS: 4 = 0x000004;
```

TRUN fullbox flags bit indicating that a `first_sample_flags` field follows (after `data_offset` if present). When this flag is set, the first sample's flags are
stored in a dedicated header field rather than in the per-sample entries - the common arrangement for fragments emitted with FFmpeg's `frag_keyframe` movflag.

***

### TRUN\_FLAG\_SAMPLE\_COMPOSITION\_OFFSET

```ts
const TRUN_FLAG_SAMPLE_COMPOSITION_OFFSET: 2048 = 0x000800;
```

TRUN fullbox flags bit indicating that each sample entry carries a 4-byte composition time offset, the last field of the entry.

***

### TRUN\_FLAG\_SAMPLE\_DURATION

```ts
const TRUN_FLAG_SAMPLE_DURATION: 256 = 0x000100;
```

TRUN fullbox flags bit indicating that each sample entry carries a 4-byte duration field.

***

### TRUN\_FLAG\_SAMPLE\_FLAGS

```ts
const TRUN_FLAG_SAMPLE_FLAGS: 1024 = 0x000400;
```

TRUN fullbox flags bit indicating that each sample entry carries a 4-byte sample_flags field.

***

### TRUN\_FLAG\_SAMPLE\_SIZE

```ts
const TRUN_FLAG_SAMPLE_SIZE: 512 = 0x000200;
```

TRUN fullbox flags bit indicating that each sample entry carries a 4-byte size field.

***

### findBox()

```ts
function findBox(
   buffer, 
   type, 
   start?, 
   end?
): Nullable<FMp4Box>;
```

Locates the first ISO BMFF box of a given type within a byte range.

Walks the standard box headers (4-byte big-endian size + 4-byte ASCII type) starting at `start` and ending at `end`. Returns the offset and size of the first
matching box. Returns `null` when no box of the requested type is found in range, and also when the walk encounters a box whose declared size is invalid - below
the header size, extending past the search range, or an extended/open-ended size (64-bit size field, uncommon in fMP4 livestream contexts and unsupported here) -
since a malformed size makes it unsafe to keep walking; every rejection reason collapses to the same null return, so callers cannot distinguish which one
occurred from the return value alone.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `buffer` | `Buffer` | `undefined` | The buffer containing ISO BMFF box data. |
| `type` | `string` | `undefined` | The 4-character ASCII box type to search for (e.g. "moof", "traf", "trun"). Must be exactly 4 characters. |
| `start?` | `number` | `0` | Optional. The byte offset to begin searching from. Defaults to 0. |
| `end?` | `number` | `undefined` | Optional. The byte offset to stop searching at. Defaults to the buffer length. |

#### Returns

[`Nullable`](../util.md#nullable)\<[`FMp4Box`](#fmp4box)\>

The box location, or `null` if not found.

***

### findKeyframe()

```ts
function findKeyframe(segment, track?): Nullable<number>;
```

Finds the first keyframe (sync sample) in an fMP4 fragment, as its index among the samples of the track fragment it reads.

Reads the first `moof`'s track fragment whose `tfhd` names `track`, or the moof's first track fragment when no track is given, and walks every `trun` in it in
order, counting samples across them, to the first sample whose flags clear the non-sync bit. A sample's flags are read where the fragment states them: the first
sample of a run takes the run's first-sample flags, else its entry's flags, else the `tfhd`'s default sample flags, and every later sample takes its entry's flags,
else that default. A sample whose flags are stated nowhere, as in a track fragment with no `tfhd`, is no keyframe. The default is read only for a sample whose
flags its run does not state, and only from a `tfhd` that holds its track_ID and every field its flags announce; a default only the initialization segment
states, in its `trex`, is not read.

The first run's first-sample flags, or its first entry's, are read even when it declares no samples, so the fragment's first sample answers from what it states
alone. A run that declares no samples adds nothing to the index, and past the first run it holds no keyframe.

A caller handing a decoder the fragment as its first asks [startsWithKeyframe](#startswithkeyframe) rather than comparing this index with zero, because samples of no duration
can stand ahead of a keyframe that a decoder still shows first.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `segment` | `Buffer` | A buffer containing a complete fMP4 fragment (typically a moof followed by its mdat). No `mdat` is read. |
| `track?` | [`FMp4Track`](#fmp4track) | Optional. The track whose track fragment to read, typically the video track [findVideoTrack](#findvideotrack) read from the stream's initialization segment. Without it, the moof's first track fragment is read. |

#### Returns

[`Nullable`](../util.md#nullable)\<`number`\>

The zero-based index of the first keyframe among the track fragment's samples, or `null` when it holds none: when the segment has no `moof`, when no track
         fragment names `track` (or, without one, the moof holds none), when every sample's flags mark it non-sync or are stated nowhere, or when the walk reaches
         a run too short for its fixed header or a flags field that lies past its run's box before it finds a keyframe.

#### Remarks

**Hot path.** A plugin reads every fragment of a live stream through this, so the walk allocates nothing per sample and stops at the first keyframe. A
run whose entries carry no flags is answered in one step, because every sample after its first takes the same default, so a run that declares billions of
samples it does not list costs no more than one that declares two. A run whose entries do carry flags is read one entry at a time, never past its box.

***

### findVideoTrack()

```ts
function findVideoTrack(initSegment): Nullable<FMp4Track>;
```

Finds an fMP4 initialization segment's video track: the first track whose media handler is `"vide"`, as its track ID and its media timescale.

Traverses `moov -> trak -> mdia -> hdlr` as [hasAudioTrack](#hasaudiotrack) does, passing over a track with no `mdia`, no `hdlr` or an `hdlr` too short to name its handler,
and reads the first video track's `tkhd` for its ID and its `mdhd` for its timescale. Each of those fullboxes holds its field after a creation and a modification
time that are 32-bit in version 0 and 64-bit in version 1, and no later version is defined, so the field is read from byte 20 of the box or from byte 28.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `initSegment` | `Buffer` | A buffer containing a complete fMP4 initialization segment (typically ftyp + moov), or one followed by fragments. |

#### Returns

[`Nullable`](../util.md#nullable)\<[`FMp4Track`](#fmp4track)\>

The video track, or `null` when the segment has no video track, when that track's `tkhd` or `mdhd` is missing, too short or of a version above 1, or when
         its timescale is zero.

***

### hasAudioTrack()

```ts
function hasAudioTrack(initSegment): boolean;
```

Determines whether an fMP4 initialization segment contains an audio track by inspecting the handler type in each track's media handler box.

Traverses the box hierarchy `moov -> trak -> mdia -> hdlr` for every track in the init segment and checks the handler_type field for "soun" (0x736F756E). This is the
standard ISO BMFF mechanism for identifying track media types - "soun" for audio, "vide" for video, "subt" for subtitles, etc.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `initSegment` | `Buffer` | A buffer containing a complete fMP4 initialization segment (typically ftyp + moov). |

#### Returns

`boolean`

`true` if the init segment contains at least one audio track, `false` otherwise.

***

### isKeyframe()

```ts
function isKeyframe(segment, track?): boolean;
```

Determines whether an fMP4 fragment holds a keyframe (sync sample) anywhere in the track fragment it reads: [findKeyframe](#findkeyframe)'s answer compared with `null`.

A producer that cuts its fragments by time rather than at keyframes leaves a keyframe wherever the cut falls, often after the first sample, so every sample of
every run counts, each read as [findKeyframe](#findkeyframe) reads it.

A caller handing a decoder the fragment as its first asks [startsWithKeyframe](#startswithkeyframe) instead, because a keyframe somewhere in the fragment is not always the first
sample a decoder shows.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `segment` | `Buffer` | A buffer containing a complete fMP4 fragment (typically a moof followed by its mdat). |
| `track?` | [`FMp4Track`](#fmp4track) | Optional. The track whose track fragment to read, as [findKeyframe](#findkeyframe) takes it. Without it, the moof's first track fragment is read. |

#### Returns

`boolean`

`true` if the track fragment holds a sync sample (keyframe), `false` otherwise.

***

### splitMoofMdat()

```ts
function splitMoofMdat(fragment): Nullable<{
  mdat: Buffer;
  moof: Buffer;
}>;
```

Splits an fMP4 fragment into its moof and mdat components.

Locates the `mdat` box and returns everything before it as the moof portion (which includes the moof box and any preceding metadata boxes) and everything from the
mdat box to the end of the fragment as the mdat portion. The returned buffers are subarray views into the original buffer, so no data is copied. Returns `null` if
the mdat box cannot be found.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `fragment` | `Buffer` | A buffer containing a complete fMP4 fragment. |

#### Returns

[`Nullable`](../util.md#nullable)\<\{
  `mdat`: `Buffer`;
  `moof`: `Buffer`;
\}\>

An object with `moof` and `mdat` sub-buffers, or `null` if the structure cannot be parsed.

***

### splitVideoFrames()

```ts
function splitVideoFrames(fragment, track): Nullable<PacedChunk[]>;
```

Cuts an fMP4 fragment into pieces that each end where one of a track's frames ends, each carrying that frame's duration, for
[BackpressureWriter.writePaced](../backpressure.md#writepaced).

Reads the first `moof`'s track fragment whose `tfhd` names `track`, and that fragment's one `trun`. A sample's size and duration come from its `trun` entry when
the run carries them and from the `tfhd`'s defaults otherwise, never from the initialization segment. The first frame starts at the moof's start plus the run's
data offset, read signed, and each frame follows the one before it. Piece k runs from the end of piece k - 1, or the fragment's start for the first, to the end of
frame k, and the last piece runs to the fragment's end, so the pieces join back to the fragment exactly and carry every other track's samples and every box
around them along with the video. A duration is the frame's ticks times 1000 over the track's timescale, in milliseconds. The pieces are `subarray` views over
`fragment`, so no bytes are copied.

A fragment none of whose track fragments names `track` holds no frame of it, as the fragment of audio alone that FFmpeg writes when a clip's audio outlasts its
video does. There is nothing in it to cut at, so it answers an empty list, which a caller tells apart from `null`, the answer for a fragment that holds the
track and cannot be cut. The walk of the track fragments ends at a box it cannot read, so a fragment whose track fragments break off that way before one names
the track answers the empty list too.

The reader knows one layout, the one FFmpeg's `default_base_moof` movflag writes: data offsets measured from the moof, and one run per track fragment. A
fragment it cannot read answers `null` - one with no `moof`, no `mdat` after it, or a track fragment that names the track in any other layout - which is how a
caller learns its producer's layout is not one this reader paces.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `fragment` | `Buffer` | A buffer containing a complete fMP4 fragment (a moof followed by its mdat). |
| `track` | [`FMp4Track`](#fmp4track) | The track to cut at, typically the video track [findVideoTrack](#findvideotrack) read from the stream's initialization segment. Its timescale must be positive, as [findVideoTrack](#findvideotrack) answers it, because each duration is divided by it. |

#### Returns

[`Nullable`](../util.md#nullable)\<[`PacedChunk`](../backpressure.md#pacedchunk)[]\>

The pieces, an empty list when no track fragment names the track, or `null` when the fragment has no `moof` or no `mdat` after it,
         when the track fragment that names the track has a `tfhd` too short for a field its flags announce, one that does not set default-base-is-moof or one
         that carries a base data offset, when it holds other than exactly one `trun` or that run carries no data offset, when the run declares no samples or its
         entries run past its box, when a sample's size or duration is neither in its entry nor a `tfhd` default, when a sample is empty, or when any frame lies
         outside the payload of the `mdat` that follows the `moof`.

#### Remarks

**Trust boundary.** The walk is bounded by the payload: every sample holds at least one byte, and every frame lies inside the `mdat` that follows the
`moof`. A malformed run can still declare a sample for every byte of that payload, each answered as a piece of its own. This is safe for trusted sources like
FFmpeg, where each sample is a whole frame. A caller feeding fragments from a source it does not trust bounds them first, because a fragment's size bounds the
pieces it can answer.

***

### startsWithKeyframe()

```ts
function startsWithKeyframe(segment, track?): boolean;
```

Determines whether an fMP4 fragment starts with a keyframe (sync sample): whether a decoder handed the fragment as its first, from its first byte, shows a
keyframe first.

Answers from [findKeyframe](#findkeyframe): a keyframe that is the first sample starts the fragment, and a keyframe at a later index does when every sample ahead of it,
in the track fragment [findKeyframe](#findkeyframe) reads, states a duration of zero. A sample of zero duration takes no time on the track's timeline, so the keyframe
behind it is the first picture the fragment presents, and some packagers put the parameter sets in such a sample, flagged non-sync, ahead of each keyframe. A
sample's duration is read where the fragment states it: its entry's when its run carries per-sample durations, else the `tfhd`'s default sample duration, read
only from a `tfhd` that holds its track_ID and every field its flags announce. A duration stated nowhere is not zero, and a default only the initialization
segment states, in its `trex`, is not read.

Each keyframe reader answers its own question: this one whether a decoder can be handed the fragment as its first, [isKeyframe](#iskeyframe) whether the fragment holds a
keyframe anywhere, and [findKeyframe](#findkeyframe) where the keyframe sits.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `segment` | `Buffer` | A buffer containing a complete fMP4 fragment (typically a moof followed by its mdat). No `mdat` is read. |
| `track?` | [`FMp4Track`](#fmp4track) | Optional. The track whose track fragment to read, as [findKeyframe](#findkeyframe) takes it. Without it, the moof's first track fragment is read. |

#### Returns

`boolean`

`true` when the track fragment's first keyframe is its first sample or every sample ahead of it states a duration of zero, `false` when it holds no
         keyframe, when a sample ahead of the keyframe states a duration other than zero or states none, or when a duration field ahead of the keyframe lies past
         its run's box.

#### Remarks

A run whose entries carry no durations is answered in one step from the default, and a run whose entries do carry them is read one entry at a time,
never past its box, so the walk is bounded by the bytes the fragment holds whatever count a run declares.

#### Example

```ts
const video = findVideoTrack(initSegment);

// Hold a recording back until a fragment arrives that a decoder can take from its first byte.
if(video && startsWithKeyframe(fragment, video)) {

  recording.start(initSegment, fragment);
}
```
