/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * owned-connector.test.ts: Unit tests for createOwnedConnector - what a dial leaves behind when it succeeds and when it fails, what an established socket's own
 * errors leave behind and what records nothing, which sockets each operation reaches, the construction options read off a real peer, and the teardown order a
 * consumer has to run its sockets down in.
 *
 * Every row dials a real socket, because what this module is for is the behavior of one: a handshake that never completes, a keepalive connection some other request
 * is using, a certificate nothing trusts, a connection the peer resets or corrupts once it is up. None of that is reachable by calling the connector directly. The
 * rows that read the verification option and the protocol offer share a `node:tls` peer presenting a certificate no store trusts, which is what makes each readable
 * without reaching for anything outside this file.
 */
import { Agent, WebSocket, errors, request } from "undici";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import { describe, test } from "node:test";
import { expectAt, freePort, listenOnLoopback, present, settle, stopListening, waitUntil } from "./testing/index.ts";
import { loopbackCertificateFixture, loopbackPrivateKeyFixture } from "./owned-connector.fixtures.ts";
import type { OwnedConnector } from "./owned-connector.ts";
import type { Socket } from "node:net";
import assert from "node:assert/strict";
import type { buildConnector } from "undici";
import { classifyTransportError } from "./transport-error.ts";
import { createServer as createHttpServer } from "node:http";
import { createOwnedConnector } from "./owned-connector.ts";
import { createServer as createTlsServer } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { hasErrorCode } from "./util.ts";

// The minimal HTTP answer the raw TLS peer writes back, which is all any row on it asks for.
const TLS_RESPONSE = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok";

// The answers the scripted peer writes: one that keeps its connection open for the next request, and one that asks the client to close it.
const KEEP_ALIVE_RESPONSE = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok";
const CLOSING_RESPONSE = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok";

// A TLS record no session can decrypt: an application-data header announcing sixteen bytes, then sixteen zero bytes. Written to the client past the peer's TLS layer
// once the handshake is over, it makes the client's own TLS layer raise the error.
const CORRUPT_TLS_RECORD = Buffer.concat([ Buffer.from([ 0x17, 0x03, 0x03, 0x00, 0x10 ]), Buffer.alloc(16) ]);

// A peer that answers, keeping the counts a row needs to tell a reused connection from a fresh one and a severed socket from a live one.
interface AnsweringRig {

  readonly closed: () => number;
  readonly connections: () => number;
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

// A peer that accepts the connection and never speaks, so a dial against it stays in its handshake for as long as a row needs it there.
interface StallingRig {

  readonly connections: () => number;
  readonly origin: string;
  readonly port: number;
  readonly stop: () => Promise<void>;
}

// A peer presenting a certificate no store trusts, recording the protocols each client offered it.
interface CertificateRig {

  readonly offered: () => readonly string[];
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

// A peer written at the socket level, which a row tells what to do with each request and which ends or resets the connections it holds when the row asks.
interface ScriptedRig {

  readonly closed: () => number;
  readonly end: () => void;
  readonly origin: string;
  readonly reset: () => void;
  readonly stop: () => Promise<void>;
}

// A TLS peer behind a TCP proxy, whose client-facing connections a row writes raw bytes to, or resets, past the peer's TLS layer.
interface TlsProxyRig {

  readonly origin: string;
  readonly reset: () => void;
  readonly stop: () => Promise<void>;
  readonly write: (bytes: Buffer) => void;
}

/* Track a server's accepted sockets so its stop can sever them before closing. `stopListening` waits for the handle to be released, and the release waits on every
 * in-flight connection - so a rig holding a keepalive socket the pool has not let go of would wait out the whole test timeout rather than closing. The two counts
 * are what let a row tell a reused connection from a fresh one, and a severed socket from a live one.
 *
 * @returns The ledger: `add` registers a socket and arms its own close bookkeeping, `closed` and `opened` report the running counts, `held` answers every socket
 *          still open, for a rig that acts on them, and `sever` destroys everything still held, which is what a rig's stop calls first.
 */
function socketLedger(): { add: (socket: Socket) => void; closed: () => number; held: () => readonly Socket[]; opened: () => number; sever: () => void } {

  const live = new Set<Socket>();

  let closed = 0;
  let opened = 0;

  return {

    add: (socket: Socket): void => {

      opened++;
      live.add(socket);

      socket.once("close", () => {

        closed++;
        live.delete(socket);
      });
    },

    closed: (): number => closed,
    held: (): readonly Socket[] => [...live],
    opened: (): number => opened,

    sever: (): void => {

      for(const socket of live) {

        socket.destroy();
      }
    }
  };
}

/* A loopback HTTP peer that answers `200` to anything and counts what it accepted and what has since closed.
 *
 * @returns The rig, bound and listening.
 */
async function startAnsweringRig(): Promise<AnsweringRig> {

  const ledger = socketLedger();

  const server = createHttpServer((incoming, response) => {

    incoming.resume();
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });

  server.on("connection", (socket) => ledger.add(socket));

  const port = await listenOnLoopback(server);

  return {

    closed: ledger.closed,
    connections: ledger.opened,
    origin: "http://127.0.0.1:" + port.toString(),

    stop: async (): Promise<void> => {

      ledger.sever();

      await stopListening(server);
    }
  };
}

/* A bare loopback peer that accepts a connection, reads nothing back to the caller and writes nothing at all. Dialed as an `https:` origin, its silence leaves the
 * TLS handshake permanently unfinished, so the socket stays in the connector's dialing collection for as long as a row needs it there. That is what makes the
 * dialing half of `cutDials` and `release` observable without a certificate in the picture. The same silence over a plain `ws:` dial leaves the other state a row
 * needs: the connect completes and the upgrade underneath it goes unanswered, which is why the port is vended beside the origin.
 *
 * @returns The rig, bound and listening.
 */
async function startStallingRig(): Promise<StallingRig> {

  const ledger = socketLedger();

  const server = createNetServer((socket) => {

    ledger.add(socket);
    socket.resume();
  });

  const port = await listenOnLoopback(server);

  return {

    connections: ledger.opened,
    origin: "https://127.0.0.1:" + port.toString(),
    port,

    stop: async (): Promise<void> => {

      ledger.sever();

      await stopListening(server);
    }
  };
}

/* A loopback TLS peer presenting the self-signed identity from this module's fixtures, answering a minimal `200` to whatever it is sent. Its `ALPNCallback` receives
 * the protocols the client offered and records them, then picks `http/1.1` every time, so every row on this rig negotiates the same protocol whatever it was
 * offered and the offer itself is what a row reads.
 *
 * @returns The rig, bound and listening.
 */
async function startCertificateRig(): Promise<CertificateRig> {

  const ledger = socketLedger();

  let offered: readonly string[] = [];

  const server = createTlsServer({

    ALPNCallback: ({ protocols }): string => {

      offered = [...protocols];

      return "http/1.1";
    },

    cert: loopbackCertificateFixture,
    key: loopbackPrivateKeyFixture
  }, (socket) => {

    ledger.add(socket);
    socket.on("data", () => socket.write(TLS_RESPONSE));
  });

  const port = await listenOnLoopback(server);

  return {

    offered: (): readonly string[] => offered,
    origin: "https://127.0.0.1:" + port.toString(),

    stop: async (): Promise<void> => {

      ledger.sever();

      await stopListening(server);
    }
  };
}

/* A loopback peer that reads each request's head and hands its connection to `onRequest`, which answers it, resets it or leaves it be. `end` sends every connection
 * the peer holds a bare FIN and `reset` sends each a TCP RST, each a way a peer drops a connection, and `closed` counts the connections that have closed, which is
 * how a row knows the client has seen the end it was sent.
 *
 * @param onRequest - What the peer does with a connection once a request's head has arrived on it.
 *
 * @returns The rig, bound and listening.
 */
async function startScriptedRig(onRequest: (socket: Socket) => void): Promise<ScriptedRig> {

  const ledger = socketLedger();

  const server = createNetServer((socket) => {

    let head = "";

    ledger.add(socket);

    socket.on("data", (chunk: Buffer) => {

      head += chunk.toString("latin1");

      if(head.includes("\r\n\r\n")) {

        head = "";
        onRequest(socket);
      }
    });
  });

  const port = await listenOnLoopback(server);

  return {

    closed: ledger.closed,

    end: (): void => {

      for(const socket of ledger.held()) {

        socket.end();
      }
    },

    origin: "http://127.0.0.1:" + port.toString(),

    reset: (): void => {

      for(const socket of ledger.held()) {

        socket.resetAndDestroy();
      }
    },

    stop: async (): Promise<void> => {

      ledger.sever();

      await stopListening(server);
    }
  };
}

/* A loopback TLS peer presenting the self-signed identity from this module's fixtures and answering a minimal `200`, reached through a TCP proxy that pipes each
 * client connection to it. `write` and `reset` act on the proxy's client-facing legs, so the bytes and the RST reach the client's socket without passing the
 * peer's TLS layer. The stop destroys every leg the proxy holds and the peer's own sockets before it closes the servers, because a leg left open holds its
 * server's close and the run never exits. Each socket here swallows its errors: the client's alert over a corrupt record and a reset leg reach the rig as
 * errors, and what a row reads is the client's side.
 *
 * @returns The rig, bound and listening.
 */
async function startTlsProxyRig(): Promise<TlsProxyRig> {

  const clientLegs = socketLedger();
  const peerSockets = socketLedger();
  const upstreamLegs = socketLedger();

  const peer = createTlsServer({ cert: loopbackCertificateFixture, key: loopbackPrivateKeyFixture }, (socket) => {

    peerSockets.add(socket);
    socket.on("error", () => { /* The client's side is the reading. */ });
    socket.on("data", () => socket.write(TLS_RESPONSE));
  });

  const peerPort = await listenOnLoopback(peer);

  const proxy = createNetServer((client) => {

    const upstream = connectNet(peerPort, "127.0.0.1");

    clientLegs.add(client);
    upstreamLegs.add(upstream);
    client.on("error", () => { /* The client's side is the reading. */ });
    upstream.on("error", () => { /* The client's side is the reading. */ });
    client.pipe(upstream);
    upstream.pipe(client);
  });

  const port = await listenOnLoopback(proxy);

  return {

    origin: "https://127.0.0.1:" + port.toString(),

    reset: (): void => {

      for(const leg of clientLegs.held()) {

        leg.resetAndDestroy();
      }
    },

    stop: async (): Promise<void> => {

      clientLegs.sever();
      upstreamLegs.sever();
      peerSockets.sever();

      await stopListening(proxy);
      await stopListening(peer);
    },

    write: (bytes: Buffer): void => {

      for(const leg of clientLegs.held()) {

        leg.write(bytes);
      }
    }
  };
}

/* A connector that dials through `connector` and keeps each socket a successful dial vends, so a row can read the established socket's own state. It wraps the
 * callback rather than the connector, so the connector's own listeners are on the socket before the row's copy of it is kept.
 *
 * @param connector - The owned connector to dial through.
 * @param vended    - Where each vended socket is kept, in dial order.
 *
 * @returns The connector to hand an `Agent`.
 */
function keepingVended(connector: OwnedConnector, vended: Socket[]): buildConnector.connector {

  return (options, callback): void => connector.connect(options, (...args) => {

    const [ error, socket ] = args;

    if(error === null) {

      vended.push(socket);
    }

    callback(...args);
  });
}

/* Issue one request through `agent` and drain its body, so the connection returns to the pool rather than staying checked out.
 *
 * @param agent  - The dispatcher to send through.
 * @param origin - The origin to send to.
 *
 * @returns The status the peer answered with.
 */
async function fetchStatus(agent: Agent, origin: string): Promise<number> {

  const response = await request(origin + "/", { dispatcher: agent });

  await response.body.text();

  return response.statusCode;
}

/* Abandon one WebSocket upgrade mid-handshake, tear down in the order the connector documents, and answer how many connections the peer accepted in total.
 *
 * The peer accepts the TCP connection and answers nothing, so the dial completes, the socket moves into the connector's established collection, and the upgrade
 * request underneath it stays unanswered - which is the state a caller's lifetime ending has to unwind.
 *
 * @returns The peer's accepted-connection count once a second dial would have had time to arrive.
 */
async function abandonedUpgradeConnections(): Promise<number> {

  const rig = await startStallingRig();
  const connector = createOwnedConnector({ allowH2: false });
  const agent = new Agent({ allowH2: false, connect: connector.connect, pipelining: 0 });
  const ws = new WebSocket("ws://127.0.0.1:" + rig.port.toString() + "/", { dispatcher: agent });

  // An abandoned handshake raises both of these, and neither is what this reads: the subject is what the peer saw, not what the client was told.
  ws.addEventListener("error", () => { /* Not this reading's subject. */ });
  ws.addEventListener("close", () => { /* Not this reading's subject. */ });

  await waitUntil(() => rig.connections() >= 1, { description: "the dial to reach the peer" });

  // The documented order: the dispatcher's destroy first, so the pending request fails outright and takes its socket with it, then the close and the release.
  void agent.destroy();
  ws.close(1000);
  connector.release();

  /* One settling window before the count is read. A second dial reaches the peer within a few milliseconds when it comes at all, and an ABSENCE cannot be waited for
   * by predicate, so this is a dwell rather than a poll - long enough that a reading of one is silence rather than a race.
   */
  await delay(250);

  const connections = rig.connections();

  await rig.stop();

  return connections;
}

describe("createOwnedConnector", () => {

  test("a dial that succeeds leaves no dial failure behind", async (t) => {

    const rig = await startAnsweringRig();
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);
    assert.equal(connector.lastDialFailure, undefined, "a dial that connected leaves nothing for a reader to report");
  });

  test("a refused dial is recorded with the errno the platform raised", async (t) => {

    const port = await freePort();
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
    });

    await assert.rejects(fetchStatus(agent, "http://127.0.0.1:" + port.toString()));

    assert.ok(hasErrorCode(connector.lastDialFailure, "ECONNREFUSED"), "the refused dial must be recorded with the errno the platform raised");
  });

  test("lastDialFailure describes the most recent dial and nothing older", async (t) => {

    const rig = await startAnsweringRig();
    const port = await freePort();
    const connector = createOwnedConnector({ allowH2: false });
    const dead = new Agent({ connect: connector.connect });
    const live = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await dead.destroy();
      await live.destroy();
      await rig.stop();
    });

    await assert.rejects(fetchStatus(dead, "http://127.0.0.1:" + port.toString()));

    assert.ok(hasErrorCode(connector.lastDialFailure, "ECONNREFUSED"), "the refused dial must be recorded with the errno the platform raised");
    assert.equal(await fetchStatus(live, rig.origin), 200);
    assert.equal(connector.lastDialFailure, undefined, "a dial that succeeded clears what the one before it left");
  });

  test("cutDials rejects a dial still in its handshake with the very reason it was cut with", async (t) => {

    const rig = await startStallingRig();
    const connector = createOwnedConnector({ allowH2: false, rejectUnauthorized: false });
    const agent = new Agent({ connect: connector.connect });
    const reason = new Error("the caller's own lifetime ended.");

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    const inFlight = assert.rejects(fetchStatus(agent, rig.origin), (error: unknown) => {

      assert.equal(error, reason, "the rejection must be the very object the dial was cut with");

      return true;
    });

    await waitUntil(() => rig.connections() >= 1, { description: "the dial to reach the peer" });

    connector.cutDials(reason);

    await inFlight;
  });

  test("cutDials with a reason that is not an Error rejects the dial as the transport's own reasonless abort", async (t) => {

    const rig = await startStallingRig();
    const connector = createOwnedConnector({ allowH2: false, rejectUnauthorized: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    const inFlight = assert.rejects(fetchStatus(agent, rig.origin), errors.RequestAbortedError);

    await waitUntil(() => rig.connections() >= 1, { description: "the dial to reach the peer" });

    connector.cutDials("gone");

    await inFlight;
  });

  test("cutDials leaves an established connection alone", async (t) => {

    const rig = await startAnsweringRig();
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    /* Let one macrotask turn pass before the second request. The transport returns a just-finished connection to its pool on a later turn, so a request issued in the
     * same turn as the first one's last byte finds no idle connection and dials a second - which would read here as a connection the cut had taken away.
     */
    await settle();

    const established = rig.connections();

    connector.cutDials(new Error("the caller's own lifetime ended."));

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    // A connection that was cut and dialed again would answer just as well, so the count is what tells the two apart.
    assert.equal(rig.connections(), established, "the second request must travel over the connection the first one established");
  });

  test("release cuts a dial still in its handshake as the pool-reset interruption", async (t) => {

    const rig = await startStallingRig();
    const connector = createOwnedConnector({ allowH2: false, rejectUnauthorized: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      await agent.destroy();
      await rig.stop();
    });

    const inFlight = assert.rejects(fetchStatus(agent, rig.origin), errors.ClientDestroyedError);

    await waitUntil(() => rig.connections() >= 1, { description: "the dial to reach the peer" });

    connector.release();

    await inFlight;
  });

  test("release destroys an established connection", async (t) => {

    const rig = await startAnsweringRig();
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);
    assert.equal(rig.closed(), 0, "the keepalive connection must still be open before the release");

    connector.release();

    await waitUntil(() => rig.closed() >= 1, { description: "the peer to observe its own socket close" });
  });

  test("a peer whose certificate does not verify fails the dial with the platform's own verdict", async (t) => {

    const rig = await startCertificateRig();
    const connector = createOwnedConnector({ allowH2: false, rejectUnauthorized: true });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    await assert.rejects(fetchStatus(agent, rig.origin));

    const failure = present(connector.lastDialFailure, "the rejected peer's own verdict");

    assert.ok(hasErrorCode(failure, "DEPTH_ZERO_SELF_SIGNED_CERT"), "the dial must carry the platform's own certificate verdict");

    // The verdict is what the classifier reads, so this row drives the certificate kind end to end from a real handshake rather than from a hand-built error.
    assert.deepEqual(classifyTransportError(failure), { cause: failure, code: "DEPTH_ZERO_SELF_SIGNED_CERT", kind: "certificate" });
  });

  test("a peer whose certificate does not verify is reached when verification is off", async (t) => {

    const rig = await startCertificateRig();
    const connector = createOwnedConnector({ allowH2: false, rejectUnauthorized: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);
    assert.equal(connector.lastDialFailure, undefined, "the same peer the row above turned away must be reached with verification off");
  });

  test("allowH2 offers HTTP/2 beside HTTP/1.1", async (t) => {

    const rig = await startCertificateRig();
    const connector = createOwnedConnector({ allowH2: true, rejectUnauthorized: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    // The peer picks `http/1.1` whatever it is offered, so what the client put on the table is the reading rather than what came back.
    assert.deepEqual(rig.offered(), [ "http/1.1", "h2" ]);
  });

  test("allowH2 off offers HTTP/1.1 alone", async (t) => {

    const rig = await startCertificateRig();
    const connector = createOwnedConnector({ allowH2: false, rejectUnauthorized: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);
    assert.deepEqual(rig.offered(), ["http/1.1"]);
  });

  /* The order the connector documents for a consumer's teardown: destroy the dispatcher, then release the connector. Destroying the dispatcher first fails the
   * request still pending under an unanswered upgrade outright and takes its socket with it, so the transport has nothing to retry in any later turn and the peer
   * sees the one connection the dial made and no other.
   *
   * The reading lives here, on a direct dial, because a consumer that wraps the connector invokes its `connect` once whatever happens afterwards, so only a dial
   * made here shows the peer's count.
   */
  test("the documented teardown order leaves the peer exactly one connection", async () => {

    assert.equal(await abandonedUpgradeConnections(), 1, "the documented order must leave the transport nothing to re-dial");
  });
});

describe("createOwnedConnector - the connection record", () => {

  test("a peer's reset of a request in flight on a keep-alive connection is recorded with ECONNRESET, the very error the request rejects with", async (t) => {

    const rig = await startScriptedRig((socket) => socket.resetAndDestroy());
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    await assert.rejects(fetchStatus(agent, rig.origin), (error: unknown) => {

      // The transport rejects a request in flight with the error its socket raised, so the record is readable here and is that same object.
      assert.ok(hasErrorCode(connector.lastConnectionFailure, "ECONNRESET"), "the reset must be recorded with the errno the platform raised");
      assert.equal(error, connector.lastConnectionFailure, "the record must hold the very error the socket raised, its errno and cause chain intact");

      return true;
    });
  });

  test("a bare FIN the peer sends on an idle keep-alive connection records nothing", async (t) => {

    const rig = await startScriptedRig((socket) => socket.write(KEEP_ALIVE_RESPONSE));
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    rig.end();

    // The client closes its side once the transport has destroyed the socket over the FIN, so the peer's count of closed connections marks the record as final.
    await waitUntil(() => rig.closed() >= 1, { description: "the client to close the connection the peer ended" });

    assert.equal(connector.lastConnectionFailure, undefined, "the transport destroys the socket with an error of its own over a bare FIN, which is no record");
  });

  test("a response that asks for Connection: close records nothing", async (t) => {

    const rig = await startScriptedRig((socket) => socket.write(CLOSING_RESPONSE));
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    // The transport closes the connection the response asked it to close, so the peer's count of closed connections marks the record as final.
    await waitUntil(() => rig.closed() >= 1, { description: "the client to close the connection its response asked it to close" });

    assert.equal(connector.lastConnectionFailure, undefined, "the transport destroys the socket with an error of its own over a clean close, which is no record");
  });

  test("release records nothing", async (t) => {

    const rig = await startAnsweringRig();
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    connector.release();

    await waitUntil(() => rig.closed() >= 1, { description: "the peer to observe its own socket close" });

    assert.equal(connector.lastConnectionFailure, undefined, "a release destroys its sockets bare, which raises no error to record");
  });

  test("a TLS error after the handshake is recorded while the socket stays open", async (t) => {

    const rig = await startTlsProxyRig();
    const connector = createOwnedConnector({ allowH2: false, rejectUnauthorized: false });
    const vended: Socket[] = [];
    const agent = new Agent({ connect: keepingVended(connector, vended) });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    rig.write(CORRUPT_TLS_RECORD);

    await waitUntil(() => connector.lastConnectionFailure !== undefined, { description: "the client's TLS layer to raise its error over the corrupt record" });

    assert.match(classifyTransportError(connector.lastConnectionFailure).code ?? "", /^ERR_SSL_/u, "the record must be the TLS layer's own error");

    // Nothing destroys an idle socket over a TLS error, so no close follows it, and a record read at the socket's close would hold nothing.
    await settle(5);

    assert.equal(expectAt(vended, 0, "the socket the dial vended").destroyed, false, "the socket must stay open after the TLS error it raised");
  });

  test("a later error the socket raises does not replace the first", async (t) => {

    const rig = await startTlsProxyRig();
    const connector = createOwnedConnector({ allowH2: false, rejectUnauthorized: false });
    const raised: unknown[] = [];
    const vended: Socket[] = [];
    const agent = new Agent({ connect: keepingVended(connector, vended) });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    expectAt(vended, 0, "the socket the dial vended").on("error", (error: unknown) => raised.push(error));
    rig.write(CORRUPT_TLS_RECORD);

    await waitUntil(() => connector.lastConnectionFailure !== undefined, { description: "the client's TLS layer to raise its error over the corrupt record" });

    const first = connector.lastConnectionFailure;

    rig.reset();

    await waitUntil(() => raised.some((error) => hasErrorCode(error, "ECONNRESET")), { description: "the socket to raise the reset that followed" });

    assert.equal(connector.lastConnectionFailure, first, "the first error the socket raised must stand, the reset after it being its consequence");
  });

  test("a successful connect clears what an earlier connection recorded", async (t) => {

    const rig = await startScriptedRig((socket) => socket.write(KEEP_ALIVE_RESPONSE));
    const connector = createOwnedConnector({ allowH2: false });
    const agent = new Agent({ connect: connector.connect });

    t.after(async (): Promise<void> => {

      connector.release();

      await agent.destroy();
      await rig.stop();
    });

    assert.equal(await fetchStatus(agent, rig.origin), 200);

    rig.reset();

    await waitUntil(() => connector.lastConnectionFailure !== undefined, { description: "the reset of the idle connection to be recorded" });

    assert.ok(hasErrorCode(connector.lastConnectionFailure, "ECONNRESET"), "the idle connection's reset must be recorded first");

    // The reset connection is gone, so the next request dials again, and that dial's success clears what the reset left.
    assert.equal(await fetchStatus(agent, rig.origin), 200);
    assert.equal(connector.lastConnectionFailure, undefined, "a successful connect must clear the record an earlier connection left");
  });
});
