/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * backpressure.helpers.ts: Readers of a stream's output for the suites that write through a BackpressureWriter.
 */

/**
 * Readers of a stream's output for a suite that writes through a `BackpressureWriter`. A row reads what a stream has been handed to assert the bytes the writer
 * sent and when, so every suite that does reads through the one loop here rather than draining the stream its own way.
 *
 * Files matching `*.helpers.ts` are excluded from the compiled `dist/` build emit (see `tsconfig.build.json`) and from the TypeDoc API docs output (see
 * `typedoc.json`), so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import type { Nullable } from "./util.ts";
import type { Readable } from "node:stream";

/**
 * Everything `stream` holds buffered at the moment of the call, as one buffer. A read hands back one buffered chunk at a time, so this reads until the stream has
 * nothing more.
 *
 * @param stream - The stream to read.
 *
 * @returns The bytes the stream held buffered, empty when it held none.
 */
export function collect(stream: Readable): Buffer {

  const chunks: Buffer[] = [];

  for(let chunk = stream.read() as Nullable<Buffer>; chunk !== null; chunk = stream.read() as Nullable<Buffer>) {

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * A reader of everything `stream` has passed through so far. Each look appends what the stream holds buffered at that moment to what earlier looks read, so a row
 * asserts the whole output as it stands when the row looks, and a piece written early or late shows as the wrong bytes.
 *
 * @param stream - The stream to read.
 *
 * @returns A function answering every byte the stream has passed through so far.
 */
export function wireOf(stream: Readable): () => Buffer {

  let seen = Buffer.alloc(0);

  return (): Buffer => {

    seen = Buffer.concat([ seen, collect(stream) ]);

    return seen;
  };
}
