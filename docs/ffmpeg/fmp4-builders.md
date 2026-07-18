[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/fmp4-builders

# ffmpeg/fmp4-builders

Shared ISO BMFF (fMP4) byte-level construction builders.

The parser-aligned construction surface every consumer's tests build fragments and initialization segments on - the library's own parser, assembler, and predicate
suites and downstream plugins alike. Ships on the package's main export alongside the other test doubles (`TestClock`, `TestRecordingProcessFactory`) so a consumer
composes real fMP4 bytes without hand-rolling box headers or re-deriving the wire layouts the predicates read.

Construction layers, from primitive to fullbox builders:

- [makeBox](#makebox) - the primitive: header + payload. Every higher builder composes against this.
- [makeContainer](#makecontainer) - a convenience wrapper that concatenates nested box bytes into a parent container (e.g., `makeContainer("moov", [ trak1, trak2 ])`).
- [makeHdlrBox](#makehdlrbox) / [makeTrunBox](#maketrunbox) - fullbox builders that encode the specific header layouts the `fmp4.ts` predicates read (`hasAudioTrack` walks the
  handler-type field; `isKeyframe` walks TRUN flags). Routing every test through one parser-aligned construction path means a future tweak to either predicate's wire
  layout has exactly one builder to update.

**Wire-format constants.** Anything the production parser reads lives in `fmp4.ts` (TRUN flag bits, sample-flag bits, the audio handler-type code) and is imported
here so the production reader and the construction path share one definition. Test-only values production never consumes - the video handler-type code, used as a
negative-path handler for `hasAudioTrack` - live in this module, which keeps the production surface to exactly what production needs.

## Variables

### HDLR\_TYPE\_VIDE

```ts
const HDLR_TYPE_VIDE: 1986618469 = 0x76696465;
```

Handler-type code for video tracks in ISO BMFF `hdlr` boxes: ASCII `"vide"` encoded as a 32-bit big-endian integer. Defined here rather than in `fmp4.ts` because
production never inspects it - `hasAudioTrack` compares each track's handler_type against `HDLR_TYPE_SOUN` and any non-match (including `"vide"`) is treated
uniformly as "not audio." Tests need a concrete non-audio value to exercise the negative path of that predicate, so the constant lives with the test builders.

## Functions

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
| `payload` | `Buffer` | Optional opaque payload bytes. Defaults to an empty buffer. |

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
| `handlerType` | `number` | `undefined` | The 32-bit big-endian handler type code. Use `HDLR_TYPE_SOUN` for audio, [HDLR\_TYPE\_VIDE](#hdlr_type_vide) for video, or any other value to exercise the "unknown handler" negative path. |
| `truncate` | `boolean` | `false` | Optional. When `true`, emits an hdlr whose payload is smaller than the minimum `hasAudioTrack` reads (stops before the handler_type field). Used by the "undersized hdlr" negative test; defaults to `false`. |

#### Returns

`Buffer`

A complete `hdlr` box.

***

### makeTrunBox()

```ts
function makeTrunBox(options): Buffer;
```

Build a `trun` fullbox describing a single sample, with the flags and sample-flags bits set to select one of the keyframe-detection paths `isKeyframe` supports.
`isKeyframe` reads the flags to decide whether to consult `first_sample_flags` (common path, when `frag_keyframe` movflag is set) or fall back to the per-sample
`sample_flags` field. The helper composes the optional fields in the exact order the spec mandates so the predicate's offset arithmetic matches.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `includeDuration?`: `boolean`; `includeSize?`: `boolean`; `sampleFlagsValue`: `number`; `truncate?`: `boolean`; `useFirstSampleFlags?`: `boolean`; `usePerSampleFlags?`: `boolean`; \} | Options that shape the emitted box. |
| `options.includeDuration?` | `boolean` | When `true`, set `TRUN_FLAG_SAMPLE_DURATION` and reserve a 4-byte per-sample duration slot before the flags slot. |
| `options.includeSize?` | `boolean` | When `true`, set `TRUN_FLAG_SAMPLE_SIZE` and reserve a 4-byte per-sample size slot before the flags slot. |
| `options.sampleFlagsValue` | `number` | The 32-bit value to write into the chosen flags field (first_sample_flags or per-sample flags). Use `0` for a keyframe; use `SAMPLE_FLAG_NON_SYNC` for a non-keyframe. |
| `options.truncate?` | `boolean` | When `true`, emit a trun whose payload stops short of the flags field the predicate would read. Exercises the "insufficient bytes" guard inside `isKeyframe` without changing the declared box size. |
| `options.useFirstSampleFlags?` | `boolean` | When `true`, set `TRUN_FLAG_FIRST_SAMPLE_FLAGS` and emit the first-sample-flags field after the optional data_offset. |
| `options.usePerSampleFlags?` | `boolean` | When `true`, set `TRUN_FLAG_SAMPLE_FLAGS` and emit a single per-sample flags field after any duration/size slots. Ignored when `useFirstSampleFlags` is also `true` because the predicate consults first_sample_flags first. |

#### Returns

`Buffer`

A complete `trun` box.
