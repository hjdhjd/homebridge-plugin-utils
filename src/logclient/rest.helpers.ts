/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/rest.helpers.ts: An open log-download response for the suites that drive the REST download, fed by the test and torn down the way the platform tears it.
 *
 * A download body built from a fixed string ends on its own, so it cannot stand in for a server that goes quiet partway through, and a body that merely stays open
 * hangs a reader that the request's abort should have released. This response stays open until its test closes it, and once the request's signal aborts it errors a
 * pending read with the signal's reason, as the platform `fetch` does, so a caller's teardown and the download's stall bound each reach the reader as they would in
 * production. It never ships - the build's emit config excludes every helpers file by name.
 */
import { onAbort } from "../util.ts";

/**
 * An open log-download response and the levers that feed it.
 *
 * @property close    - End the body normally, as a server reaching the end of the file does.
 * @property push     - Deliver more body text, as one chunk.
 * @property response - The 200 response a `fetch` double answers the download with.
 */
export interface OpenDownload {

  readonly close: () => void;
  readonly push: (text: string) => void;
  readonly response: Response;
}

/**
 * Build an open log-download response that delivers `chunks` at once, one chunk each, and then sends nothing more until the test pushes or closes.
 *
 * @param options        - The response's opening content and the request it answers.
 * @param options.chunks - The body text delivered at once, one chunk per entry. Defaults to none.
 * @param options.signal - The signal the download handed `fetch`. Once it aborts, a pending read rejects with its reason. Omitted, the body ignores aborts.
 *
 * @returns The response and the levers that feed it.
 */
export function openDownload({ chunks = [], signal }: { chunks?: readonly string[]; signal?: AbortSignal }): OpenDownload {

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const body = new ReadableStream<Uint8Array>({

    start(streamController): void {

      controller = streamController;

      for(const chunk of chunks) {

        streamController.enqueue(encoder.encode(chunk));
      }
    }
  });

  // Mirror the platform: an aborted request errors its body with the signal's reason, so a read waiting on a silent server rejects rather than hanging. Erroring a body
  // the test already closed and drained does nothing, exactly as the platform has nothing left to tear down there.
  if(signal !== undefined) {

    onAbort(signal, (): void => controller?.error(signal.reason));
  }

  return {

    close: (): void => controller?.close(),
    push: (text: string): void => controller?.enqueue(encoder.encode(text)),
    response: new Response(body, { status: 200 })
  };
}
