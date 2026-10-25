/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/upgrade-peer.helpers.ts: A real WebSocket peer for the rows that drive the production dial, in each shape those rows need.
 *
 * The socket suite reaches its subject through a double everywhere else, and a double never touches the network - so nothing in it exercises the production factory,
 * the dial it is handed, or the teardown a peer actually observes. This peer closes that: it completes a real opening handshake, speaks just enough Engine.IO and
 * Socket.IO for a `LogSocket` to reach its streaming phase, records what arrived and in what order, and resets its connections when a row asks so a stream can be
 * dropped mid-session. In its other shapes it resets a connection at the namespace join, so the connect phase meets a reset once the upgrade is done, or holds a
 * handshake open indefinitely so an abort has a dial in flight to land on. It never ships - the build's emit config excludes every helpers file by name.
 */
import { listenOnLoopback, stopListening } from "../testing/index.ts";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

// The protocol's fixed accept-key salt, concatenated with the client's `Sec-WebSocket-Key` and hashed to answer the handshake.
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The Engine.IO open handshake this peer answers an upgrade with, advertising the ping cadence the socket sizes its liveness watchdog from.
const ENGINE_OPEN_FRAME = "0{\"sid\":\"s1\",\"pingInterval\":25000,\"pingTimeout\":20000}";

// The Socket.IO namespace CONNECT acknowledgement for the `/log` namespace.
const NAMESPACE_CONNECT_FRAME = "40/log,{\"sid\":\"n1\"}";

// The largest payload a WebSocket frame carries in its one-byte length field; anything longer takes the two-byte extended form.
const SHORT_PAYLOAD_MAX = 125;

// The WebSocket opcode for a text frame, and the one for a close frame.
const OPCODE_CLOSE = 0x8;
const OPCODE_TEXT = 0x1;

/** The line this peer delivers once the socket has asked for the tail, so a row asserts against the same string the peer sent. */
export const UPGRADE_PEER_LINE = "a line from the peer";

/**
 * Which shape the peer takes. `answersUpgrade` completes the handshake and speaks the protocol; `neverUpgrades` accepts the TCP connection and answers the upgrade
 * request with nothing at all, leaving the client's dial open for an abort to land on; `resetsOnJoin` completes the upgrade and the Engine.IO open, then answers the
 * namespace join with a TCP RST rather than its acknowledgement, so the connection fails after the upgrade and before the join.
 */
export type UpgradePeerBehavior = "answersUpgrade" | "neverUpgrades" | "resetsOnJoin";

/** The two edges of one accepted connection, armed when the connection is asked about rather than when it arrives, so a row can wait on one that has not landed yet. */
export interface UpgradePeerConnection {

  readonly accepted: Promise<void>;
  readonly ended: Promise<void>;
}

/** A live peer and everything it observed. */
export interface UpgradePeer {

  /** How many connections the peer has accepted, in total. A row asserting that one aborted attempt made one socket reads this. */
  readonly accepted: () => number;

  /** The close codes the peer read off inbound close frames, in arrival order. */
  readonly closeCodes: () => readonly number[];

  /** The two edges of the connection at `index` in accept order. */
  readonly connection: (index: number) => UpgradePeerConnection;

  /** The text of every inbound frame, in arrival order. */
  readonly inbound: () => readonly string[];

  /** What the peer saw and when: `"close-frame"` for an inbound close, `"end-event"` for its own socket ending. A row asserting a teardown's shape reads the order. */
  readonly observed: () => readonly string[];

  /** The port the kernel assigned. */
  readonly port: number;

  /** Reset every connection the peer still holds with a TCP RST rather than a FIN, so the client's socket raises `ECONNRESET` where a hang-up would raise nothing. */
  readonly reset: () => void;

  /** Sever what the peer still holds and release the listening handle. */
  readonly stop: () => Promise<void>;
}

/* Frame a text payload for the client. A server-to-client frame is unmasked by the protocol, so this is the FIN-and-opcode byte, the length, and the bytes.
 *
 * @param text - The payload to send.
 *
 * @returns The framed bytes.
 */
function textFrame(text: string): Buffer {

  const payload = Buffer.from(text, "utf8");

  if(payload.length > SHORT_PAYLOAD_MAX) {

    const header = Buffer.alloc(4);

    header.writeUInt8(0x80 | OPCODE_TEXT, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(payload.length, 2);

    return Buffer.concat([ header, payload ]);
  }

  const header = Buffer.alloc(2);

  header.writeUInt8(0x80 | OPCODE_TEXT, 0);
  header.writeUInt8(payload.length, 1);

  return Buffer.concat([ header, payload ]);
}

/* Parse every WHOLE frame the buffer holds and answer the remainder. A TCP data event is not a frame: it can carry half of one or two of them, and the transport's
 * own connector sets no-delay on the dial socket, so successive client writes reach here as separate segments rather than coalesced ones. Each guard below returns
 * the buffer untouched and waits for the next chunk rather than parsing a header the bytes do not hold yet.
 *
 * @param buffered - Everything received on this connection and not yet parsed.
 * @param onFrame  - Called once per whole frame with its opcode and its UNMASKED payload.
 *
 * @returns Whatever is left over, to carry into the next chunk.
 */
function readFrames(buffered: Buffer, onFrame: (opcode: number, payload: Buffer) => void): Buffer {

  let rest = buffered;

  for(;;) {

    if(rest.length < 2) {

      return rest;
    }

    const opcode = rest.readUInt8(0) & 0x0F;
    const masked = (rest.readUInt8(1) & 0x80) !== 0;

    let length = rest.readUInt8(1) & 0x7F;
    let offset = 2;

    if(length === 126) {

      if(rest.length < (offset + 2)) {

        return rest;
      }

      length = rest.readUInt16BE(offset);
      offset += 2;
    } else if(length === 127) {

      if(rest.length < (offset + 8)) {

        return rest;
      }

      length = Number(rest.readBigUInt64BE(offset));
      offset += 8;
    }

    const keyOffset = offset;

    if(masked) {

      if(rest.length < (offset + 4)) {

        return rest;
      }

      offset += 4;
    }

    if(rest.length < (offset + length)) {

      return rest;
    }

    const payload = Buffer.from(rest.subarray(offset, offset + length));

    // A client-to-server frame is masked by the protocol, so the payload is the raw bytes exclusive-ored with the four-byte key that preceded them.
    if(masked) {

      for(let index = 0; index < payload.length; index++) {

        payload[index] = payload.readUInt8(index) ^ rest.readUInt8(keyOffset + (index % 4));
      }
    }

    onFrame(opcode, payload);
    rest = rest.subarray(offset + length);
  }
}

/**
 * Stand up the peer on a loopback port.
 *
 * @param behavior - Which shape to take. Defaults to `answersUpgrade`.
 *
 * @returns The peer, bound and listening.
 */
export async function startUpgradePeer(behavior: UpgradePeerBehavior = "answersUpgrade"): Promise<UpgradePeer> {

  const closeCodes: number[] = [];
  const edges = new Map<number, UpgradePeerConnection & { settleAccepted: () => void; settleEnded: () => void }>();
  const held = new Set<Socket>();
  const inbound: string[] = [];
  const observed: string[] = [];

  let accepted = 0;

  /* Arm the two edges for one connection index, whichever side asks first. A row waiting on a connection that has not arrived yet creates the slot; the connection
   * handler then finds it and settles it rather than the row racing a fixed delay against the dial.
   */
  const edgesFor = (index: number): UpgradePeerConnection & { settleAccepted: () => void; settleEnded: () => void } => {

    const existing = edges.get(index);

    if(existing) {

      return existing;
    }

    const arrival: PromiseWithResolvers<void> = Promise.withResolvers();
    const ending: PromiseWithResolvers<void> = Promise.withResolvers();

    const armed = {

      accepted: arrival.promise,
      ended: ending.promise,
      settleAccepted: (): void => arrival.resolve(),
      settleEnded: (): void => ending.resolve()
    };

    edges.set(index, armed);

    return armed;
  };

  const server = createServer();

  server.on("connection", (socket) => {

    const armed = edgesFor(accepted);

    accepted++;
    held.add(socket);

    /* Settle the ending edge on `end` as well as on `close`, whichever lands first. An upgraded socket handed over by the HTTP server is raw, so when the client
     * severs its own half the peer sees `end` immediately while `close` waits on this side's half - a peer watching `close` alone would record nothing at all for a
     * teardown that has already happened.
     */
    const settleEnded = (): void => {

      if(!observed.includes("end-event")) {

        observed.push("end-event");
      }

      armed.settleEnded();
    };

    socket.once("end", settleEnded);

    /* The socket leaves the held set on `close` and on `close` alone. A client's FIN raises `end` while this side's own half is still open, so a socket dropped
     * there would be one the stop never severs, and the listening handle would then wait on it for as long as the runner allows.
     */
    socket.once("close", () => {

      settleEnded();
      held.delete(socket);
    });

    armed.settleAccepted();
  });

  server.on("upgrade", (request, socket) => {

    // The silent shape answers the upgrade request with nothing and holds the connection, so the client's handshake stays unfinished for as long as a row needs it.
    if(behavior === "neverUpgrades") {

      return;
    }

    const key = request.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");

    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    socket.write(textFrame(ENGINE_OPEN_FRAME));

    let buffered: Buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {

      buffered = readFrames(Buffer.concat([ buffered, chunk ]), (opcode, payload) => {

        if(opcode === OPCODE_CLOSE) {

          /* Read the close code off the raw payload AS BYTES. Code 1000 is `0x03 0xE8`, and `0xE8` is not valid UTF-8 - decoding the payload to a string first and
           * re-encoding it turns 1000 into 1007.
           */
          if(payload.length >= 2) {

            closeCodes.push(payload.readUInt16BE(0));
          }

          observed.push("close-frame");

          return;
        }

        const text = payload.toString("utf8");

        inbound.push(text);

        if(text.startsWith("40/log,")) {

          /* The resetting shape answers the join by resetting the connection it arrived on, when the socket has finished its upgrade and waits on the join. The
           * request's own socket is that connection, typed as the TCP socket a reset needs, where the upgrade hands it over typed as a bare stream.
           */
          if(behavior === "resetsOnJoin") {

            request.socket.resetAndDestroy();

            return;
          }

          socket.write(textFrame(NAMESPACE_CONNECT_FRAME));

          return;
        }

        /* Deliver one line once the socket asks for the tail. The payload ends `\r\n` rather than a lone line-feed on purpose: the splitter holds a trailing lone
         * terminator in its carry against a cross-chunk pair, so a payload ending `\n` would deliver no line at all.
         */
        if(text.includes("tail-log")) {

          socket.write(textFrame("42/log," + JSON.stringify([ "stdout", UPGRADE_PEER_LINE + "\r\n" ])));
        }
      });
    });
  });

  const port = await listenOnLoopback(server);

  return {

    accepted: (): number => accepted,
    closeCodes: (): readonly number[] => closeCodes,
    connection: (index: number): UpgradePeerConnection => edgesFor(index),
    inbound: (): readonly string[] => inbound,
    observed: (): readonly string[] => observed,
    port,

    reset: (): void => {

      for(const socket of held) {

        socket.resetAndDestroy();
      }
    },

    stop: async (): Promise<void> => {

      // Sever what is still held before closing: the release waits on every in-flight connection, and an upgraded socket is one the peer itself has to let go of.
      for(const socket of held) {

        socket.destroy();
      }

      await stopListening(server);
    }
  };
}
