[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/fmp4-builders

# ffmpeg/fmp4-builders

Shared ISO BMFF (fMP4) byte-level construction builders.

The parser-aligned construction surface every consumer's tests build fragments and initialization segments on - the library's own parser, assembler, and predicate
suites and downstream plugins alike. Ships on the `homebridge-plugin-utils/testing` entry point alongside the other test doubles (`TestClock`,
`TestRecordingProcessFactory`) so a consumer composes real fMP4 bytes without hand-rolling box headers or re-deriving the wire layouts the predicates read.

Construction layers, from primitive to fullbox builders to the composers over them:

- [makeBox](#makebox) - the primitive: header + payload. Every higher builder composes against this.
- [makeContainer](#makecontainer) - a convenience wrapper that concatenates nested box bytes into a parent container (e.g., `makeContainer("moov", [ trak1, trak2 ])`).
- [makeHdlrBox](#makehdlrbox) / [makeTkhdBox](#maketkhdbox) / [makeMdhdBox](#makemdhdbox) / [makeTfhdBox](#maketfhdbox) / [makeTrunBox](#maketrunbox) - fullbox builders that encode the specific header
  layouts the `fmp4.ts` readers read (`hasAudioTrack` and `findVideoTrack` walk the handler-type field, and `findVideoTrack` reads a track's ID and timescale;
  `findKeyframe`, `isKeyframe` and `startsWithKeyframe` read each run's sample flags and the track fragment header's default flags, and `startsWithKeyframe` the
  durations ahead of the keyframe and the header's default duration; `splitVideoFrames` reads a track fragment's header and its run's entries). Routing every test
  through one parser-aligned construction path means a future tweak to any reader's wire layout has exactly one builder to update.
- [makeInitSegment](#makeinitsegment) / [makeFragment](#makefragment) - composers that build a whole initialization segment from its tracks and a whole fragment from its samples,
  in the layout a stream's producer writes, so a suite feeding a reader or a feed a stream states its tracks and frames rather than assembling their boxes. A
  malformed segment or fragment, one no producer writes, is built from the fullbox builders directly.

**Wire-format constants.** Every wire-format value these builders write lives in `fmp4.ts` (TRUN and TFHD flag bits, sample-flag bits, the handler-type codes),
because the production readers read each of them, and is imported here so the production reader and the construction path share one definition.

## Testing

### InitSegmentTrack

One track of an initialization segment built by [makeInitSegment](#makeinitsegment): its ID and timescale, as [FMp4Track](fmp4.md#fmp4track) holds them, its
media handler, and the version each of its `tkhd` and `mdhd` is written at. A box's version decides the width of its times and duration, and a producer chooses it
for each box on its own.

#### Extends

- [`FMp4Track`](fmp4.md#fmp4track)

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="handler"></a> `handler` | `readonly` | `number` | The track's handler-type code, such as [HDLR\_TYPE\_VIDE](fmp4.md#hdlr_type_vide) for video or `HDLR_TYPE_SOUN` for audio. | - |
| <a id="id"></a> `id` | `readonly` | `number` | The track's `track_ID`, which each of its track fragments names in its `tfhd`. | [`FMp4Track`](fmp4.md#fmp4track).[`id`](fmp4.md#id) |
| <a id="mdhdversion"></a> `mdhdVersion?` | `readonly` | `0` \| `1` | The version of the track's `mdhd`, `0` (the default) or `1`. | - |
| <a id="timescale"></a> `timescale` | `readonly` | `number` | The track's media timescale, the number of duration ticks in one second. | [`FMp4Track`](fmp4.md#fmp4track).[`timescale`](fmp4.md#timescale) |
| <a id="tkhdversion"></a> `tkhdVersion?` | `readonly` | `0` \| `1` | The version of the track's `tkhd`, `0` (the default) or `1`. | - |

***

### TrunSample

One sample's entry in a `trun` built by [makeTrunBox](#maketrunbox). Each field is written only when the run's flags say every entry carries it, and a field the run
carries but the sample omits is written as zero.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="compositionoffset"></a> `compositionOffset?` | `readonly` | `number` | The sample's composition time offset, written signed. |
| <a id="duration"></a> `duration?` | `readonly` | `number` | The sample's duration, in the track's timescale. |
| <a id="flags"></a> `flags?` | `readonly` | `number` | The sample's flags. |
| <a id="size"></a> `size?` | `readonly` | `number` | The sample's size, in bytes. |

***

### makeBox()

```ts
function makeBox(type, payload?): Buffer;
```

Synthesize a minimal ISO BMFF box. Produces a Buffer whose first 4 bytes are the big-endian total size, the next 4 bytes are the 4-character ASCII `type`, and the
remainder is the supplied payload. Each test file wants the same construction helper to exercise different stream shapes; keeping it in one place eliminates drift
between the parser and assembler test suites.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `string` | The 4-character ASCII box type (`"ftyp"`, `"moov"`, `"moof"`, `"mdat"`, ...). Any other length fails the check. |
| `payload?` | `Buffer` | Optional opaque payload bytes. Defaults to an empty buffer. |

#### Returns

`Buffer`

A complete box (header + payload) suitable for feeding to the parser or writing to an in-memory Readable fixture.

***

### makeContainer()

```ts
function makeContainer(type, children): Buffer;
```

Convenience wrapper that builds a container box from a sequence of already-constructed child boxes. The payload is just the concatenation of children, so the
result is equivalent to `makeBox(type, Buffer.concat(children))` - this helper's value is readability at the call site, where nested structures like
`moov -> [ trak -> [ mdia -> [ hdlr ] ] ]` become one-liners instead of a visual ladder of `Buffer.concat` calls.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `string` | The 4-character ASCII box type. |
| `children` | `Buffer`\<`ArrayBufferLike`\>[] | The pre-built child boxes to include as the container's payload. |

#### Returns

`Buffer`

A complete container box.

#### Example

```ts
const hdlr = makeHdlrBox(HDLR_TYPE_SOUN);
const mdia = makeContainer("mdia", [hdlr]);
const trak = makeContainer("trak", [mdia]);
const moov = makeContainer("moov", [trak]);
```

***

### makeFragment()

```ts
function makeFragment(options): Buffer;
```

Build an fMP4 fragment in the layout the family's producers write: a `moof` holding an `mfhd` and the track fragment of `trackId`, then that of `secondTrack`
when one is given, and one `mdat` holding the first track's samples and then the second's. Each track fragment holds a `tfhd` naming its track, a `tfdt` and one
`trun` whose data offset is measured from the start of the `moof` to the track's first sample. Each sample is written into the `mdat` as `size` bytes of zeros,
whether or not its run carries the size.

The first track's fragment is the one a test shapes: its header's defaults and flags, the fields its run's entries carry, and its data offset. The second track's
header sets default-base-is-moof alone, and its run's entries carry each sample's duration and size.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `dataOffset?`: `number`; `header?`: `Omit`\<\{ `baseDataOffset?`: `number`; `defaultBaseIsMoof?`: `boolean`; `defaultSampleDuration?`: `number`; `defaultSampleFlags?`: `number`; `defaultSampleSize?`: `number`; `sampleDescriptionIndex?`: `number`; `trackId`: `number`; \}, `"trackId"`\>; `run?`: `Pick`\<\{ `dataOffset?`: `number`; `includeCompositionOffset?`: `boolean`; `includeDataOffset?`: `boolean`; `includeDuration?`: `boolean`; `includeSize?`: `boolean`; `sampleCount?`: `number`; `sampleFlagsValue?`: `number`; `samples?`: readonly [`TrunSample`](#trunsample)[]; `truncate?`: `boolean`; `useFirstSampleFlags?`: `boolean`; `usePerSampleFlags?`: `boolean`; \}, \| `"includeCompositionOffset"` \| `"includeDataOffset"` \| `"includeDuration"` \| `"includeSize"` \| `"sampleFlagsValue"` \| `"useFirstSampleFlags"` \| `"usePerSampleFlags"`\>; `samples`: readonly [`TrunSample`](#trunsample)[]; `secondTrack?`: \{ `samples`: readonly [`TrunSample`](#trunsample)[]; `trackId`: `number`; \}; `trackId`: `number`; \} | Options that shape the emitted fragment. |
| `options.dataOffset?` | `number` | The first track's data offset as written, in place of the position of its first sample, for a fragment whose run points somewhere other than its samples. |
| `options.header?` | `Omit`\<\{ `baseDataOffset?`: `number`; `defaultBaseIsMoof?`: `boolean`; `defaultSampleDuration?`: `number`; `defaultSampleFlags?`: `number`; `defaultSampleSize?`: `number`; `sampleDescriptionIndex?`: `number`; `trackId`: `number`; \}, `"trackId"`\> | The first track's `tfhd` options, as [makeTfhdBox](#maketfhdbox) takes them, without the track_ID. Defaults to default-base-is-moof alone. |
| `options.run?` | `Pick`\<\{ `dataOffset?`: `number`; `includeCompositionOffset?`: `boolean`; `includeDataOffset?`: `boolean`; `includeDuration?`: `boolean`; `includeSize?`: `boolean`; `sampleCount?`: `number`; `sampleFlagsValue?`: `number`; `samples?`: readonly [`TrunSample`](#trunsample)[]; `truncate?`: `boolean`; `useFirstSampleFlags?`: `boolean`; `usePerSampleFlags?`: `boolean`; \}, \| `"includeCompositionOffset"` \| `"includeDataOffset"` \| `"includeDuration"` \| `"includeSize"` \| `"sampleFlagsValue"` \| `"useFirstSampleFlags"` \| `"usePerSampleFlags"`\> | Which fields the first track's `trun` carries, and the value its first-sample flags hold, as [makeTrunBox](#maketrunbox) takes them. Defaults to each sample's duration and size in its entry and a first-sample-flags field marking a keyframe; a run given replaces that default whole, and the first-sample flags it carries mark a keyframe unless it picks a `sampleFlagsValue`. |
| `options.samples` | readonly [`TrunSample`](#trunsample)[] | The first track's samples, in order. Each is written to the `mdat` as its `size`, and to the run's entries as far as `run` says. |
| `options.secondTrack?` | \{ `samples`: readonly [`TrunSample`](#trunsample)[]; `trackId`: `number`; \} | A second track whose fragment and samples follow the first's. |
| `options.secondTrack.samples` | readonly [`TrunSample`](#trunsample)[] | The second track's samples, in order, each written to the `mdat` as its `size` and to the run's entries with its duration and size. |
| `options.secondTrack.trackId` | `number` | The track_ID of the second track. |
| `options.trackId` | `number` | The track_ID of the first track. |

#### Returns

`Buffer`

A complete fragment, its `moof` followed by its `mdat`.

#### Example

```ts
// A fragment of video frames, then the audio samples that play alongside them.
const fragment = makeFragment({ samples: [ { duration: 3000, size: 40 }, { duration: 3000, size: 12 }, { duration: 3000, size: 18 } ],
  secondTrack: { samples: [ { duration: 1920, size: 7 } ], trackId: 2 }, trackId: 1 });
```

***

### makeHdlrBox()

```ts
function makeHdlrBox(handlerType, truncate?): Buffer;
```

Build a `hdlr` fullbox with the supplied handler_type code. The fullbox layout (box header + version/flags + pre_defined + handler_type + reserved[3] + name) is
exactly what `hasAudioTrack` reads when deciding whether a track is audio. Tests compose an initialization segment by wrapping an hdlr inside `moov -> trak -> mdia`,
with the handler_type selecting the track media type under test.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `handlerType` | `number` | `undefined` | The 32-bit big-endian handler type code. Use `HDLR_TYPE_SOUN` for audio, [HDLR\_TYPE\_VIDE](fmp4.md#hdlr_type_vide) for video, or any other value to exercise the "unknown handler" negative path. |
| `truncate?` | `boolean` | `false` | Optional. When `true`, emits an hdlr whose payload is smaller than the minimum `hasAudioTrack` reads (stops before the handler_type field). Used by the "undersized hdlr" negative test; defaults to `false`. |

#### Returns

`Buffer`

A complete `hdlr` box.

***

### makeInitSegment()

```ts
function makeInitSegment(tracks): Buffer;
```

Build an initialization segment from its tracks: an `ftyp`, then a `moov` holding an `mvhd` and a `trak` for each track in the order given, each `trak` holding
the track's `tkhd` and an `mdia` with its `mdhd` and `hdlr`. These are the boxes `findVideoTrack` and `hasAudioTrack` walk, and past the fields they read and
the file type's brands, every field is written as zero.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `tracks` | readonly [`InitSegmentTrack`](#initsegmenttrack)[] | The segment's tracks, in order. |

#### Returns

`Buffer`

A complete initialization segment.

#### Example

```ts
const header = makeInitSegment([ { handler: HDLR_TYPE_VIDE, id: 1, timescale: 90000 }, { handler: HDLR_TYPE_SOUN, id: 2, timescale: 48000 } ]);
```

***

### makeMdhdBox()

```ts
function makeMdhdBox(options): Buffer;
```

Build an `mdhd` fullbox stating a track's media timescale. Its creation and modification times, and its duration, are 32-bit in version 0 and 64-bit in version 1,
so the timescale `findVideoTrack` reads sits at byte 20 of the box in version 0 and at byte 28 in version 1. Every other field is written as zero.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `timescale`: `number`; `version?`: `0` \| `1`; \} | Options that shape the emitted box. |
| `options.timescale` | `number` | The timescale to write, in ticks per second. |
| `options.version?` | `0` \| `1` | The box version, `0` (the default) or `1`, which decides the width of the times and the duration. |

#### Returns

`Buffer`

A complete `mdhd` box.

***

### makeTfhdBox()

```ts
function makeTfhdBox(options): Buffer;
```

Build a `tfhd` fullbox: a track fragment's header, naming its track and carrying any of the optional fields `splitVideoFrames` and `findKeyframe` read. Each
optional field given sets its flag and is written in the order the spec lays them out after the track_ID: the 64-bit base data offset, the sample description
index, and the default sample duration, size and flags. Default-base-is-moof is set unless asked otherwise, the layout FFmpeg's `default_base_moof` movflag writes.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `baseDataOffset?`: `number`; `defaultBaseIsMoof?`: `boolean`; `defaultSampleDuration?`: `number`; `defaultSampleFlags?`: `number`; `defaultSampleSize?`: `number`; `sampleDescriptionIndex?`: `number`; `trackId`: `number`; \} | Options that shape the emitted box. |
| `options.baseDataOffset?` | `number` | When given, set `TFHD_FLAG_BASE_DATA_OFFSET` and write this 64-bit base data offset. |
| `options.defaultBaseIsMoof?` | `boolean` | When `true`, the default, set `TFHD_FLAG_DEFAULT_BASE_IS_MOOF`. |
| `options.defaultSampleDuration?` | `number` | When given, set `TFHD_FLAG_DEFAULT_SAMPLE_DURATION` and write this default sample duration. |
| `options.defaultSampleFlags?` | `number` | When given, set `TFHD_FLAG_DEFAULT_SAMPLE_FLAGS` and write these default sample flags. |
| `options.defaultSampleSize?` | `number` | When given, set `TFHD_FLAG_DEFAULT_SAMPLE_SIZE` and write this default sample size. |
| `options.sampleDescriptionIndex?` | `number` | When given, set `TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX` and write this sample description index. |
| `options.trackId` | `number` | The track_ID the header names. |

#### Returns

`Buffer`

A complete `tfhd` box.

***

### makeTkhdBox()

```ts
function makeTkhdBox(options): Buffer;
```

Build a `tkhd` fullbox naming a track. Its creation and modification times, and its duration, are 32-bit in version 0 and 64-bit in version 1, so the track_ID
`findVideoTrack` reads sits at byte 20 of the box in version 0 and at byte 28 in version 1. Every other field is written as zero.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `trackId`: `number`; `version?`: `0` \| `1`; \} | Options that shape the emitted box. |
| `options.trackId` | `number` | The track_ID to write. |
| `options.version?` | `0` \| `1` | The box version, `0` (the default) or `1`, which decides the width of the times and the duration. |

#### Returns

`Buffer`

A complete `tkhd` box.

***

### makeTrunBox()

```ts
function makeTrunBox(options): Buffer;
```

Build a `trun` fullbox. Without `samples` it describes a single sample, with the flags and sample-flags bits set to select where the run states that sample's
flags: `isKeyframe` reads a run's first sample from `first_sample_flags` when the run carries them (common path, when `frag_keyframe` movflag is set), from the
per-sample `sample_flags` field otherwise, and from the track fragment header's default when the run states neither. With `samples` it describes a run of any
length, one entry per sample, which is what `splitVideoFrames` and `findKeyframe` read. The helper composes the optional fields in the exact order the spec
mandates so the readers' offset arithmetic matches.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `dataOffset?`: `number`; `includeCompositionOffset?`: `boolean`; `includeDataOffset?`: `boolean`; `includeDuration?`: `boolean`; `includeSize?`: `boolean`; `sampleCount?`: `number`; `sampleFlagsValue?`: `number`; `samples?`: readonly [`TrunSample`](#trunsample)[]; `truncate?`: `boolean`; `useFirstSampleFlags?`: `boolean`; `usePerSampleFlags?`: `boolean`; \} | Options that shape the emitted box. |
| `options.dataOffset?` | `number` | The value written, signed, into the data_offset field. Defaults to `0`. |
| `options.includeCompositionOffset?` | `boolean` | When `true`, set `TRUN_FLAG_SAMPLE_COMPOSITION_OFFSET` and write each sample's composition offset as the last field of its entry. It shapes the entries written for `samples`, and without `samples` it sets the flag bit alone. |
| `options.includeDataOffset?` | `boolean` | When `true`, the default, set `TRUN_FLAG_DATA_OFFSET` and write the data_offset field after the sample count. `false` omits the flag and the field together, the shape of a run that does not say where its samples start. |
| `options.includeDuration?` | `boolean` | When `true`, set `TRUN_FLAG_SAMPLE_DURATION` and reserve a 4-byte per-sample duration slot before the flags slot. |
| `options.includeSize?` | `boolean` | When `true`, set `TRUN_FLAG_SAMPLE_SIZE` and reserve a 4-byte per-sample size slot before the flags slot. |
| `options.sampleCount?` | `number` | The sample count the run declares. Defaults to the number of `samples`, or `1` without them. A count above the entries written declares entries the box does not hold. |
| `options.sampleFlagsValue?` | `number` | The 32-bit value to write into the first_sample_flags field, and without `samples` into the per-sample flags field. Use `0`, the default, for a keyframe; use `SAMPLE_FLAG_NON_SYNC` for a non-keyframe. |
| `options.samples?` | readonly [`TrunSample`](#trunsample)[] | The run's entries, in order. Each entry holds, in this order, the duration when `includeDuration` is set, the size when `includeSize` is set, the flags when `usePerSampleFlags` is set and the composition offset when `includeCompositionOffset` is set. Omit it for the single-sample run the keyframe paths read. |
| `options.truncate?` | `boolean` | Without `samples`, when `true`, emit a trun whose payload stops short of the flags field the predicate would read. Exercises the "insufficient bytes" guard inside `isKeyframe` without changing the declared box size. |
| `options.useFirstSampleFlags?` | `boolean` | When `true`, set `TRUN_FLAG_FIRST_SAMPLE_FLAGS` and emit the first-sample-flags field after the optional data_offset. |
| `options.usePerSampleFlags?` | `boolean` | When `true`, set `TRUN_FLAG_SAMPLE_FLAGS`. Without `samples`, emit a single per-sample flags field after any duration/size slots, regardless of `useFirstSampleFlags`; when `useFirstSampleFlags` is also `true`, `isKeyframe` never reads these trailing bytes, because `first_sample_flags` stands in for the first sample's entry flags and the run holds no other. |

#### Returns

`Buffer`

A complete `trun` box.

## Other

### HDLR\_TYPE\_VIDE

Re-exports [HDLR_TYPE_VIDE](fmp4.md#hdlr_type_vide)
