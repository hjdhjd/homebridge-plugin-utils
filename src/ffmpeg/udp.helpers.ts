/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/udp.helpers.ts: Shared UDP test helpers for tests that exercise loopback socket flows (RtpDemuxer, FfmpegStreamingProcess health monitor).
 */

/**
 * Shared test helpers for UDP-driven tests.
 *
 * The following primitives cover every loopback socket flow in `src/ffmpeg/`:
 *
 * - {@link reserveEphemeralPort} - bind port 0 on the loopback interface, read the kernel-assigned port back, deterministically release the socket, return the port.
 * - {@link probePortAvailable} - attempt to bind to a specific port on the loopback interface; resolve when the bind succeeds and the socket has been released, or
 *   reject with the kernel error otherwise. Used by tests that verify a socket was released (post-abort, post-dispose, post-short-circuit).
 * - {@link holdPort} - bind and retain a port on the loopback interface, returning an `AsyncDisposable` whose `Symbol.asyncDispose` releases it. Used by tests that
 *   need to force `EADDRINUSE` on a downstream bind.
 * - {@link sendDatagram} - send a single UDP datagram to a loopback port and resolve when the send callback fires.
 * - {@link bindReceiver} - bind an ephemeral receiver socket and accumulate every inbound datagram on a `received` array, returning an `AsyncDisposable` whose
 *   `Symbol.asyncDispose` releases the socket. Used by tests that verify a subject under test forwards datagrams to the correct destination, with the inbound
 *   source endpoint exposed via each entry's `rinfo` so source-port-symmetry assertions are direct.
 *
 * Every helper awaits the completion signal that ends its operation - the `"listening"` event on bind, the `"close"` event on release, the send callback on send -
 * so callers observe deterministic state transitions rather than fire-and-forget resource releases. This matters most for {@link reserveEphemeralPort}: awaiting the
 * `"close"` event before returning the port eliminates the release-vs-rebind race a naive implementation carries.
 *
 * Files matching `*.helpers.ts` are excluded from both the compiled `dist/` build emit (see `tsconfig.build.json`) and the TypeDoc API docs output (see
 * `typedoc.json`) so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import type { RemoteInfo, Socket } from "node:dgram";
import { createDgramSocket, loopbackAddress } from "./dgram-util.ts";
import type { IpFamily } from "./dgram-util.ts";
import type { Nullable } from "../util.ts";
import { once } from "node:events";

// Re-export the production `IpFamily` union so test files can import the type from `udp.helpers.ts` alone without reaching into production modules. The type still
// lives in `dgram-util.ts`; the re-export is a navigation convenience, not a second source.
export type { IpFamily };

// Create a dgram socket and bind it on the loopback interface for the supplied family. Resolves with the bound socket on "listening"; rejects with the kernel error
// if bind fails (typically EADDRINUSE). `events.once` attaches single-shot listeners for both "listening" (resolve) and "error" (reject) and removes both on
// settlement, so the returned socket carries no lingering handlers from the bind step. This mirrors the production bind pattern in `RtpPortAllocator.#acquirePort`.
// Every public helper in this module composes against this primitive so the bind shape lives in exactly one place - a single future tweak to the bind wiring
// (dual-stack, SO_REUSEADDR, etc.) has exactly one site to update.
async function bindLoopback(port: number, ipFamily: IpFamily): Promise<Socket> {

  const socket = createDgramSocket(ipFamily);
  const listening = once(socket, "listening");

  socket.bind(port, loopbackAddress(ipFamily));
  await listening;

  return socket;
}

// Close a dgram socket and wait for the kernel's close to complete. The "close" listener is attached via `events.once` before `socket.close()` is called, mirroring
// Node's internal `socket.close(callback)` ordering so a synchronously-emitted "close" cannot be missed. Callers can sequence a bind-close-rebind flow without a
// release-vs-rebind race because the returned promise resolves only after the underlying handle has been released.
async function closeSocket(socket: Socket): Promise<void> {

  const closed = once(socket, "close");

  socket.close();
  await closed;
}

/**
 * Acquire a free ephemeral UDP port by binding to port 0 on the loopback interface, reading the kernel-assigned port back, and deterministically releasing the
 * socket before returning.
 *
 * Awaiting the close callback (rather than fire-and-forget) eliminates the release-vs-rebind race a naive implementation carries: by the time the caller sees the
 * port number, the socket's underlying handle has been released and the port is truly free for the next `bind`.
 *
 * @param ipFamily - The IP family to bind on. Defaults to `"ipv4"`.
 *
 * @returns The kernel-assigned port number.
 */
export async function reserveEphemeralPort(ipFamily: IpFamily = "ipv4"): Promise<number> {

  const socket = await bindLoopback(0, ipFamily);
  const { port } = socket.address();

  await closeSocket(socket);

  return port;
}

/**
 * Attempt to bind to a specific port on the loopback interface. Resolves when the bind succeeds and the socket has been released; rejects with the kernel error
 * (typically `EADDRINUSE`) otherwise.
 *
 * Used by tests that verify a socket was released - after an abort, an `await using` disposal, or a short-circuit path - by probing whether the port rebinds
 * cleanly. A successful probe proves the subject under test freed its handle; a rejection flags a leak.
 *
 * @param port     - The port to probe on the loopback interface.
 * @param ipFamily - The IP family to probe on. Defaults to `"ipv4"`.
 */
export async function probePortAvailable(port: number, ipFamily: IpFamily = "ipv4"): Promise<void> {

  const socket = await bindLoopback(port, ipFamily);

  await closeSocket(socket);
}

/**
 * Bind and retain a port on the loopback interface, returning an {@link AsyncDisposable} whose `Symbol.asyncDispose` releases it. The returned handle integrates
 * with `await using` so tests consume it as a scoped resource rather than tracking close calls in a finally block.
 *
 * Used by tests that need to force `EADDRINUSE` on a downstream bind - for example, the "bind failure aborts the process" regression guard that holds the port
 * before the subject code attempts its own bind.
 *
 * Pass `0` to hold a kernel-assigned ephemeral port; the assigned port is exposed via the returned handle's `port` field so the test can pass the same value to the
 * subject under test. This is the race-free way to set up a "downstream bind collides with the holder" scenario: the kernel hands one port to the holder
 * atomically, and the subject receives that exact port as its target with no intervening release-and-rebind window.
 *
 * @example
 *
 * ```ts
 * await using holder = await holdPort(0);
 *
 * // ... test body runs while holder.port is occupied; auto-releases at scope exit.
 * ```
 *
 * @param port     - The port to hold on the loopback interface. Pass `0` for kernel-assigned ephemeral allocation.
 * @param ipFamily - The IP family to bind on. Defaults to `"ipv4"`.
 *
 * @returns An `AsyncDisposable` carrying the bound `port` value, whose disposal releases the held port deterministically.
 */
export async function holdPort(port: number, ipFamily: IpFamily = "ipv4"): Promise<AsyncDisposable & { port: number }> {

  const socket = await bindLoopback(port, ipFamily);

  return {

    port: socket.address().port,

    async [Symbol.asyncDispose](): Promise<void> {

      await closeSocket(socket);
    }
  };
}

/**
 * Send a single UDP datagram to the specified port on the loopback interface, resolving when the send callback fires. Opens a fresh sender socket, sends, and
 * releases the socket once the send completes so long-running tests do not accumulate sender handles.
 *
 * @param port     - The destination port on the loopback interface.
 * @param payload  - The datagram payload.
 * @param ipFamily - The IP family to send on. Defaults to `"ipv4"`.
 */
export async function sendDatagram(port: number, payload: Buffer, ipFamily: IpFamily = "ipv4"): Promise<void> {

  const sender = createDgramSocket(ipFamily);

  try {

    const { promise, resolve, reject }: PromiseWithResolvers<void> = Promise.withResolvers();

    sender.send(payload, port, loopbackAddress(ipFamily), (error: Nullable<Error>) => error ? reject(error) : resolve());

    await promise;
  } finally {

    await closeSocket(sender);
  }
}

/**
 * A single received datagram entry on {@link DatagramReceiver.received}: the payload bytes and the kernel-reported remote info from which they originated.
 */
export interface ReceivedDatagram {

  msg: Buffer;
  rinfo: RemoteInfo;
}

/**
 * Receiver handle returned by {@link bindReceiver}.
 *
 * @property port     - The kernel-assigned loopback port the receiver is bound to. Pass to the subject under test as a forwarding destination.
 * @property received - Append-only list of every datagram observed in arrival order. Tests inspect `length` for "no datagrams arrived" assertions and index into the
 *                      array for content / source-endpoint assertions. The `msg` payload is a fresh `Buffer.from(...)` copy so subsequent kernel reuse of the receive
 *                      buffer cannot corrupt held entries.
 */
export interface DatagramReceiver extends AsyncDisposable {

  readonly port: number;
  readonly received: readonly ReceivedDatagram[];
}

/**
 * Bind an ephemeral UDP receiver socket on the loopback interface and accumulate every inbound datagram on the returned handle's `received` array.
 *
 * Used by tests that need to verify a subject under test forwarded a datagram to the expected destination. The receiver records every datagram's payload bytes and
 * source `rinfo` so tests can assert both content and source-endpoint properties (e.g., the source-port-symmetry guarantee of {@link RtpDemuxer}).
 *
 * Payload bytes are copied into a fresh `Buffer` on receipt because Node's dgram subsystem reuses its receive buffers across messages - holding a reference to the
 * raw event buffer would risk later messages overwriting earlier entries in tests that buffer multiple datagrams across awaits. The copy keeps every entry stable for
 * the lifetime of the receiver.
 *
 * @param ipFamily - The IP family to bind on. Defaults to `"ipv4"`.
 *
 * @returns A {@link DatagramReceiver} whose disposal releases the bound socket deterministically.
 */
export async function bindReceiver(ipFamily: IpFamily = "ipv4"): Promise<DatagramReceiver> {

  const socket = await bindLoopback(0, ipFamily);
  const received: ReceivedDatagram[] = [];

  socket.on("message", (msg: Buffer, rinfo: RemoteInfo) => {

    received.push({ msg: Buffer.from(msg), rinfo });
  });

  return {

    port: socket.address().port,
    received,

    async [Symbol.asyncDispose](): Promise<void> {

      await closeSocket(socket);
    }
  };
}
