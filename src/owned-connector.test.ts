/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * owned-connector.test.ts: Unit tests for createOwnedConnector - what a dial leaves behind when it succeeds and when it fails, which sockets each operation
 * reaches, the construction options read off a real peer, and the teardown order a consumer has to run its sockets down in.
 *
 * Every row dials a real socket, because what this module is for is the behavior of one: a handshake that never completes, a keepalive connection some other request
 * is using, a certificate nothing trusts. None of that is reachable by calling the connector directly. The rows that read the verification option and the protocol
 * offer share a `node:tls` peer presenting a certificate no store trusts, which is what makes both readable without reaching for anything outside this file.
 */
import { Agent, WebSocket, errors, request } from "undici";
import { describe, test } from "node:test";
import { freePort, listenOnLoopback, present, settle, stopListening, waitUntil } from "./testing/index.ts";
import { loopbackCertificateFixture, loopbackPrivateKeyFixture } from "./owned-connector.fixtures.ts";
import type { Socket } from "node:net";
import assert from "node:assert/strict";
import { classifyTransportError } from "./transport-error.ts";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createOwnedConnector } from "./owned-connector.ts";
import { createServer as createTlsServer } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { hasErrorCode } from "./util.ts";

// The minimal HTTP answer the raw TLS peer writes back, which is all any row on it asks for.
const TLS_RESPONSE = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok";

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

/* Track a server's accepted sockets so its stop can sever them before closing. `stopListening` waits for the handle to be released, and the release waits on every
 * in-flight connection - so a rig holding a keepalive socket the pool has not let go of would wait out the whole test timeout rather than closing. The two counts
 * are what let a row tell a reused connection from a fresh one, and a severed socket from a live one.
 *
 * @returns The ledger: `add` registers a socket and arms its own close bookkeeping, `closed` and `opened` report the running counts, and `sever` destroys
 *          everything still held, which is what a rig's stop calls first.
 */
function socketLedger(): { add: (socket: Socket) => void; closed: () => number; opened: () => number; sever: () => void } {

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
