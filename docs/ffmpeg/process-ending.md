[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/process-ending

# ffmpeg/process-ending

The ending an FFmpeg process hands its `onFailed` and `onTimeout` callbacks, and the verdict each answers.

A failed or timed-out process hands the matching callback an [FfmpegEnding](#ffmpegending): the reason it ended for and the stderr lines it read. The callback
answers an [FfmpegEndingVerdict](#ffmpegendingverdict): `"handled"` once it has reported the ending itself, or chosen to report nothing, or `"default"` to leave the ending to
whatever is asked next and, in the end, to the process's own report.

## FFmpeg

### FfmpegEnding

The ending a failed or timed-out FFmpeg process hands its `onFailed` or `onTimeout` callback.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="reason"></a> `reason` | `readonly` | [`HbpuAbortError`](../util.md#hbpuaborterror) | The reason the process ended for, final by the time a callback is asked: `"failed"` for `onFailed`, `"timeout"` for `onTimeout`. A failure's `cause` carries the exit information (`{ exitCode, exitSignal }`) for an exit other than with code 0, the underlying `Error` for a spawn failure, or whatever cause the code that aborted the process attached. |
| <a id="stderrlog"></a> `stderrLog` | `readonly` | readonly `string`[] | The stderr lines the process has read so far. The real process hands the same readonly view its `stderrLog` getter returns, not a copy. |

***

### FfmpegEndingVerdict

```ts
type FfmpegEndingVerdict = "default" | "handled";
```

What an `onFailed` or `onTimeout` callback answers. `"handled"` means the callback reported the ending itself, or chose to report nothing, and the process logs
nothing further for it. `"default"` leaves the ending to whatever is asked next, and in the end to the process's own report.

## Testing

### hardwareDecoderRefusalLine

```ts
const hardwareDecoderRefusalLine: string;
```

A stderr line that reports the hardware decoder's refusal, for a suite to hand a process double's `stderrLog`. It is an invented line in the form FFmpeg prints
one, the decoder's context prefix with an invented address and then the setup failure that closes on the refusal's words, and it is built on the text the
package reads the refusal by, so a double handed it reads the refusal as the real process reads it from its child.

#### Example

```ts
import { TestStreamingProcess, hardwareDecoderRefusalLine } from "homebridge-plugin-utils/testing";

// The double marks the options it was handed, as the real process does on the line that reports the refusal.
const proc = new TestStreamingProcess({}, options);

proc.stderrLog = [hardwareDecoderRefusalLine];
```
