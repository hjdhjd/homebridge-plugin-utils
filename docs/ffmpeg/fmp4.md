[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/fmp4

# ffmpeg/fmp4

ISO BMFF (fMP4) box parsing utilities for working with fragmented MP4 data.

This module provides lightweight, Buffer-based utilities for inspecting ISO Base Media File Format (ISO BMFF) structures commonly found in fragmented MP4 (fMP4)
streams. It enables locating specific box types, splitting fragments into their moof/mdat components, detecting keyframe (sync sample) segments by parsing the TRUN
sample flags, and identifying audio track presence in initialization segments.

These utilities operate on complete Buffers and are independent of FFmpeg processes or streaming pipelines.

## FFmpeg

### FMp4Box

Describes the location of an ISO BMFF box within a buffer.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="offset"></a> `offset` | `number` | The byte offset of the box start (including the header). |
| <a id="size"></a> `size` | `number` | The total box size in bytes (including the header). |

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

### SAMPLE\_FLAG\_NON\_SYNC

```ts
const SAMPLE_FLAG_NON_SYNC: 65536 = 0x00010000;
```

Sample-flags bit indicating a non-sync (non-keyframe) sample. When this bit is clear (0), the sample is a sync sample / IDR frame / keyframe.

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
end?): Nullable<FMp4Box>;
```

Locates the first ISO BMFF box of a given type within a byte range.

Walks the standard box headers (4-byte big-endian size + 4-byte ASCII type) starting at `start` and ending at `end`. Returns the offset and size of the first
matching box. Returns `null` when no box of the requested type is found in range, and also when the walk encounters a box whose declared size is invalid - below
the header size, extending past the search range, or an extended/open-ended size (64-bit size field, uncommon in fMP4 livestream contexts and unsupported here) -
since a malformed size makes it unsafe to keep walking; the two cases are indistinguishable from the return value alone.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `buffer` | `Buffer` | `undefined` | The buffer containing ISO BMFF box data. |
| `type` | `string` | `undefined` | The 4-character ASCII box type to search for (e.g. "moof", "traf", "trun"). Must be exactly 4 characters. |
| `start` | `number` | `0` | Optional. The byte offset to begin searching from. Defaults to 0. |
| `end?` | `number` | `undefined` | Optional. The byte offset to stop searching at. Defaults to the buffer length. |

#### Returns

[`Nullable`](../util.md#nullable)\<[`FMp4Box`](#fmp4box)\>

The box location, or `null` if not found.

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
function isKeyframe(segment): boolean;
```

Determines whether an fMP4 segment contains a keyframe (sync sample) by parsing the TRUN sample flags.

Traverses the box hierarchy `moof -> traf -> trun` and inspects the sample flags to determine if the first sample is a sync sample (keyframe/IDR frame). Checks
`first_sample_flags` first (the common case for fragments generated with `frag_keyframe`), then falls back to per-sample flags if available. Returns `false` if the
box structure cannot be parsed or if the flags indicate a non-sync sample.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `segment` | `Buffer` | A buffer containing a complete fMP4 segment (typically a moof+mdat pair). |

#### Returns

`boolean`

`true` if the segment's first sample is a sync sample (keyframe), `false` otherwise.

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
