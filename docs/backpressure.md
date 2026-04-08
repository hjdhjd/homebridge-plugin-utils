[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / backpressure

# backpressure

Backpressure-aware write queue for Node.js writable streams.

This module provides a utility class for writing data to a writable stream while respecting backpressure signals. It maintains an internal queue and serializes writes,
pausing when the stream signals it isn't ready and resuming when it drains. This is particularly useful when feeding data from an event-driven source (e.g., fMP4
segments from a livestream) into a process stdin that may not consume data as fast as it arrives.

## Utilities

### BackpressureWriter

A backpressure-aware write queue that serializes writes to a writable stream, pausing when the stream signals backpressure and resuming on drain.

The stream is resolved lazily via a getter function on each write, allowing the writer to be created before the stream exists and to handle stream replacement across
process restarts.

#### Example

```ts
// Create a writer that feeds segments to an FFmpeg process stdin.
const writer = new BackpressureWriter(() => ffmpegProcess.stdin ?? null);

// Enqueue segments as they arrive from a livestream source.
livestream.on("segment", (segment) => writer.write(segment));

// When the session ends, close the writer to release pending data.
writer.close();
```

#### Constructors

##### Constructor

```ts
new BackpressureWriter(getStream, onWrite?): BackpressureWriter;
```

Creates a new backpressure-aware write queue.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `getStream` | () => [`Nullable`](util.md#nullable)\<`Writable`\> | A function that returns the current writable stream, or `null` if the stream is unavailable. Evaluated on each write attempt, allowing the writer to be created before the stream exists or to track a stream that changes across process restarts. For a static stream, wrap it in an arrow function: `() => stream`. |
| `onWrite?` | () => `void` | Optional. A callback invoked after each segment is successfully written to the underlying stream. Useful for tracking write statistics. |

###### Returns

[`BackpressureWriter`](#backpressurewriter)

###### Example

```ts
// Lazy resolution...the stream is resolved on each write.
const writer = new BackpressureWriter(() => this.ffmpegProcess?.stdin ?? null, () => segmentCount++);

// Static stream...wrap in an arrow function.
const writer = new BackpressureWriter(() => stream);
```

#### Accessors

##### pending

###### Get Signature

```ts
get pending(): number;
```

Returns the number of segments currently queued and waiting to be written.

###### Returns

`number`

#### Methods

##### close()

```ts
close(): void;
```

Closes the writer, clearing any pending data and removing drain listeners. After closing, all subsequent writes are rejected. This should be called when the
underlying stream is being shut down or the session is ending.

###### Returns

`void`

##### write()

```ts
write(data): boolean;
```

Enqueues data to be written to the stream. If the stream is available and not under backpressure, the data is written immediately. Otherwise, it is queued and
written when the stream signals it is ready via the drain event.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `data` | `Buffer` | The buffer to write to the stream. |

###### Returns

`boolean`

Returns `true` if the data was accepted (stream is available), `false` if the stream is unavailable or the writer has been closed.
