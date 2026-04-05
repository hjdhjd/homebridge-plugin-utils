[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/fmp4

# ffmpeg/fmp4

ISO BMFF (fMP4) box parsing utilities for working with fragmented MP4 data.

This module provides lightweight, Buffer-based utilities for inspecting ISO Base Media File Format (ISO BMFF) structures commonly found in fragmented MP4 (fMP4)
streams. It enables locating specific box types, splitting fragments into their moof/mdat components, and detecting keyframe (sync sample) segments by parsing the
TRUN sample flags.

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
matching box, or `null` if no match is found. Does not handle extended-size boxes (64-bit size field) as these are uncommon in fMP4 livestream contexts.

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
