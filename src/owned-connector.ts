/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * owned-connector.ts: The connector a library hands undici, holding every socket it vends so a dial still in its handshake can be reached.
 */

/**
 * The connector a library hands undici, so the sockets a dispatcher dials are held by the library rather than only by the pool.
 *
 * A dispatcher owns its connections and vends none of them, which is the right boundary nearly always and leaves a library unable to do what this connector does. It
 * cannot cut a dial that is still in its TCP or TLS handshake when the caller's lifetime ends, because undici's client discards the connector's return value and
 * holds nothing of its own until the connect completes - a socket mid-handshake is reachable through a connector like this one and nowhere else. It cannot let go of
 * everything at teardown without waiting on a peer that is under no obligation to answer. It cannot read the error the dial itself failed with. And it cannot read
 * the error an established connection raised once the dial was over.
 *
 * Those errors earn a paragraph of their own, because nothing about them is guessable from a call site. Observed on 2026-09-19: undici's WebSocket delivered an
 * empty `TypeError` for every opening-handshake failure - a self-signed peer, a hostname mismatch, and a refused port alike - while the connector's own callback
 * received the real error, with its errno, about a millisecond earlier. Observed on 2026-10-24: an open WebSocket the peer resets delivers the same empty `TypeError`
 * as one the peer hangs up on without a close frame, while the socket underneath raised `ECONNRESET` before the WebSocket reported anything. So a consumer that
 * wants to name what went wrong reads `lastDialFailure`, then `lastConnectionFailure`, ahead of the event.
 *
 * The boundary. This module owns sockets and stops there: it builds no dispatcher, logs nothing, and decides nothing about what a failure means. Which protocols to
 * offer and whether to verify the peer's certificate are the caller's own policy, carried through as values rather than judged here.
 *
 * @module
 */
import { buildConnector, errors } from "undici";
import type { Socket } from "node:net";

/* The connector's runtime shape, which is not the shape its declaration states. The package types the callback-based connector as returning `void`, while the
 * implementation hands back the socket it just created (`node_modules/undici/lib/core/connect.js`) - and that returned socket is the only handle there is on a dial
 * still in its handshake. Naming the real return here is what the cast below spends, and the rows that cut a dial in flight are the proof the return is real. The
 * cast goes through `unknown` because the declared type and the real one do not overlap.
 */
type DialingConnector = (options: buildConnector.Options, callback: buildConnector.Callback) => Socket;

/* Whether an error an established socket raised is the socket's own: a system error carrying a numeric `errno`, the platform's report of a network fault such as a
 * peer's reset, or a TLS-layer error, whose `code` opens `ERR_SSL_` and which carries no errno. Anything else an established socket raises is an error something
 * destroyed it with: undici's own, which it raises for a bare FIN and a clean close as well as for its timeouts and teardowns, its parser's, or a caller's. A filter
 * on undici's class alone would keep the parser's error and the caller's, so the test names what to keep rather than what to drop.
 */
function isSocketOwnError(error: Error): boolean {

  return (("errno" in error) && (typeof error.errno === "number")) || (("code" in error) && (typeof error.code === "string") && error.code.startsWith("ERR_SSL_"));
}

/**
 * Construction options for {@link createOwnedConnector}.
 *
 * @category Utilities
 */
export interface OwnedConnectorOptions {

  /**
   * Which application protocols the dial offers while the connection is negotiated. `true` offers `h2` beside `http/1.1`; `false` offers `http/1.1` alone. The caller
   * states it because the connector cannot infer it, and the consequence is the caller's rather than the protocol's: a dialer that upgrades to a WebSocket states
   * `false`, because a WebSocket upgrade cannot run over HTTP/2, while a pooled HTTP client that wants the faster protocol when the peer has it states `true`.
   */
  readonly allowH2: boolean;

  /**
   * Whether the peer's certificate chain must satisfy the platform's verification. It has three states, and the difference between them is the whole reason the field
   * is optional. Omitted leaves the question to the platform, so whatever the process was started with still decides and a user's own `NODE_TLS_REJECT_UNAUTHORIZED`
   * still relaxes it. `true` requires a chain the platform accepts, and no environment setting can relax that. `false` verifies not at all, which is how a caller
   * reaches a device presenting a certificate no chain accepts...a caller that does relax it owns that decision. A caller with no opinion omits it.
   */
  readonly rejectUnauthorized?: boolean;
}

/**
 * A connector that holds every socket it vends, and the two operations that let go of them.
 *
 * @category Utilities
 */
export interface OwnedConnector {

  /**
   * The connector to hand undici - a `Pool`'s or an `Agent`'s `connect` option. Every socket it vends is held from the moment it is created, before any event has
   * fired on it, and a socket that finishes connecting moves from the dialing collection into the established one so a cancellation can reach the first without
   * touching the second.
   */
  readonly connect: buildConnector.connector;

  /**
   * Destroy every socket still connecting, with an error: `reason` itself when it is an `Error` (every `DOMException` is one), and otherwise a fresh
   * `RequestAbortedError`, which is the transport's own class for a signal aborted without a reason. Destroying with an error is what makes the pending request
   * reject with that very object - a socket destroyed with no error emits nothing the connector listens for, and the request would hang until the transport's own
   * connect timer. Sockets that have finished connecting are left alone.
   */
  cutDials(reason: unknown): void;

  /**
   * The first network or TLS error any established socket raised since the connector's most recent successful connect: `undefined` before any connect, and
   * `undefined` again after each one that succeeds. It records only an error the socket itself raised: a system error carrying a numeric `errno`, such as a peer's
   * reset, or a TLS-layer error whose `code` opens `ERR_SSL_`, such as a corrupt record after the handshake. An error the transport destroys the socket with is left
   * out, as is one a caller destroys it with that carries neither mark, and undici destroys an HTTP socket with an error of its own when the peer ends it with a
   * bare FIN or a `Connection: close`, so a bare FIN, a clean close and {@link OwnedConnector.release | release} record nothing. The first such error stands,
   * because the errors a socket raises after it are its consequences, and it is held as the socket raised it, so its `errno` and its `cause` chain are intact.
   *
   * One slot serves every socket the connector holds, so on a pool a second socket's error is dropped while the first is held, and any successful connect clears
   * the slot. It is a getter, so a caller reads the current value rather than a snapshot taken when this object was built.
   */
  readonly lastConnectionFailure: Error | undefined;

  /**
   * The error the most recent dial vended: `undefined` before any dial, and `undefined` again after one that succeeded, so it describes the most recent dial and
   * nothing older. It is a getter, so a caller reads the current value rather than a snapshot taken when this object was built.
   */
  readonly lastDialFailure: Error | undefined;

  /**
   * Destroy every socket still held: a connecting one with a fresh `ClientDestroyedError`, so a request cut this way classifies exactly as an ordinary pool reset
   * already does, and an established one with a bare destroy, because nothing is pending on the connector's side of an established socket - a request in flight on
   * one meets the dispatcher's own destroy instead.
   */
  release(): void;
}

/**
 * Build a connector that tracks every socket it vends, from the moment it is vended.
 *
 * A dial is held from the vend rather than from the completed connect because nobody else can reach a socket mid-handshake. That is the whole reason this exists: a
 * cancellation, a deadline, a pool reset and a teardown all reduce to one operation - cut the dials still in flight - and none of them could reach a connecting
 * socket without it.
 *
 * The two collections are two because the operations differ. A cancellation must end a dial and must never touch a connection some other request is using, so a
 * socket moves out of the dialing collection and into the established one the moment its connect completes. Neither operation clears a collection itself - a
 * destroyed dial leaves through its own connector callback, and a destroyed established socket leaves through its close handler - which keeps each of them the live
 * picture of what is actually held.
 *
 * @param options - Which protocols to offer, and whether to verify the peer's certificate. See {@link OwnedConnectorOptions}.
 *
 * @returns The connector, and the operations that let its sockets go.
 *
 * @example
 *
 * ```ts
 * import { Agent } from "undici";
 * import { createOwnedConnector } from "homebridge-plugin-utils";
 *
 * // The dispatcher dials through the connector, so a teardown reaches sockets the pool would never vend.
 * const connector = createOwnedConnector({ allowH2: true });
 * const dispatcher = new Agent({ allowH2: true, connect: connector.connect });
 *
 * // Later, when this caller's lifetime ends.
 * await dispatcher.destroy();
 * connector.release();
 * ```
 *
 * @category Utilities
 */
export function createOwnedConnector({ allowH2, rejectUnauthorized }: OwnedConnectorOptions): OwnedConnector {

  const dialing = new Set<Socket>();
  const established = new Set<Socket>();

  /* An omitted `rejectUnauthorized` passes no key at all, which is not the same as passing the key with `undefined`: the transport reads a present `undefined` as
   * `true` and locks the environment out, while an absent key leaves the platform's own answer in place for `NODE_TLS_REJECT_UNAUTHORIZED` to relax. The spread is
   * conditional for exactly that reason.
   */
  const dial = buildConnector({ allowH2, keepAlive: true, ...((rejectUnauthorized === undefined) ? {} : { rejectUnauthorized }) }) as unknown as DialingConnector;

  let lastConnectionFailure: Error | undefined;
  let lastDialFailure: Error | undefined;

  return {

    connect: (connectOptions, callback): void => {

      /* The callback fires on a socket event - `connect`, `secureConnect`, or `error` - and never synchronously inside the inner call, so the binding below is
       * assigned by the time it runs. A connect that failed vends its error and no socket, so the success arm is what the established tracking hangs off; reaching
       * for a socket on the failure arm would fault inside the transport's own error path, where nothing is left to catch it.
       */
      const socket = dial(connectOptions, (...vended) => {

        const [ error, vendedSocket ] = vended;

        dialing.delete(socket);

        // Record what this dial vended, for a reader that cannot get at it any other way. The module doc states the observation this answers to.
        lastDialFailure = error ?? undefined;

        /* A successful connect clears the connection record, and from here the socket's own errors set it. The listener goes on in this callback, ahead of every
         * listener undici adds once the callback hands it the socket, so the record is in place before a request rejects or a WebSocket event fires. It records on
         * `error` rather than reading the socket's error at `close`, because a TLS error after the handshake leaves the socket open, so no `close` follows it.
         */
        if(error === null) {

          lastConnectionFailure = undefined;
          established.add(vendedSocket);
          vendedSocket.once("close", () => established.delete(vendedSocket));
          vendedSocket.on("error", (socketError: Error) => {

            lastConnectionFailure ??= isSocketOwnError(socketError) ? socketError : undefined;
          });
        }

        callback(...vended);
      });

      dialing.add(socket);
    },

    cutDials: (reason: unknown): void => {

      for(const socket of dialing) {

        socket.destroy((reason instanceof Error) ? reason : new errors.RequestAbortedError());
      }
    },

    get lastConnectionFailure(): Error | undefined {

      return lastConnectionFailure;
    },

    get lastDialFailure(): Error | undefined {

      return lastDialFailure;
    },

    release: (): void => {

      for(const socket of dialing) {

        socket.destroy(new errors.ClientDestroyedError());
      }

      for(const socket of established) {

        socket.destroy();
      }
    }
  };
}
