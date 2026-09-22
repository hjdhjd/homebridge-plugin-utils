/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/socket-teardown.helpers.ts: A dial and a WebSocket that write every teardown operation into one log, so a row reads the order rather than inferring it.
 *
 * The order the socket ends an attempt in is a contract the module documents and nothing could observe: the dispatcher's destroy and the WebSocket's close leave
 * separate traces, and the connector's release leaves none at all - it crosses no boundary a row can reach. One shared log answers that, because a single array written
 * by all three is the only artifact that carries their relative order. It never ships - the build's emit config excludes every helpers file by name.
 */
import type { OwnedDial, OwnedDialFactory, OwnedDialInit } from "./socket.ts";
import { TestWebSocket, TestWebSocketFactory } from "./socket-double.ts";
import { Agent } from "undici";
import type { OwnedConnector } from "../owned-connector.ts";
import { createOwnedConnector } from "../owned-connector.ts";

/**
 * The teardown operations a recorded attempt writes, named once so a row asserts against the same vocabulary the recorder uses and a typo is a compile error rather
 * than a silent miss.
 */
export type TeardownOperation = "agent.destroy" | "connector.release" | "ws.close";

/** A dial and a WebSocket wired to one shared log, and the pieces a row hands {@link LogSocketInit}. */
export interface TeardownRecorder {

  /** Every teardown operation the socket ran, in the order it ran them. */
  readonly calls: readonly TeardownOperation[];

  /** The dial factory to inject, vending a real connector and a real dispatcher whose destroy and release are recorded. */
  readonly ownedDialFactory: OwnedDialFactory;

  /** The WebSocket factory to inject, vending the one recorded socket for every dial. It is the suite's own double, so a row drives it exactly as any other row does. */
  readonly webSockets: TestWebSocketFactory;
}

// The WebSocket half of the log. A subclass rather than a wrapper because the recorded socket must stay the double every other row drives - the emit methods, the
// readyState flip and the sent-frame capture are all still wanted, and only the close needs to say when it happened.
class RecordingWebSocket extends TestWebSocket {

  readonly #calls: TeardownOperation[];

  public constructor(calls: TeardownOperation[]) {

    super();

    this.#calls = calls;
  }

  public override close(code = 1000): void {

    this.#calls.push("ws.close");

    super.close(code);
  }
}

/* The dispatcher half of the log. A real `Agent` subclass rather than a stand-in object, because the dispatcher is handed to a WebSocket factory that needs the real
 * class, and because the destroy the socket discards through `markHandled` has to be a real settling promise for that discard to mean anything.
 *
 * The override hands the transport a callback rather than calling `super.destroy()`, and that is what keeps the log honest: the promise-returning form re-enters
 * through `this.destroy` to reach its own callback form, so an override that called it would see its own call a second time and write a second entry. The callback
 * form terminates where it is called. A null error is what the no-argument form passes too, so the transport still destroys with its own `ClientDestroyedError`.
 */
class RecordingAgent extends Agent {

  readonly #calls: TeardownOperation[];

  public constructor(options: Agent.Options, calls: TeardownOperation[]) {

    super(options);

    this.#calls = calls;
  }

  public override destroy(): Promise<void> {

    this.#calls.push("agent.destroy");

    return new Promise<void>((resolve) => super.destroy(null, () => resolve()));
  }
}

/* The connector half of the log. A delegating object rather than a subclass, because `OwnedConnector` is an interface its own factory satisfies with an object
 * literal and there is no class to extend.
 *
 * Two members are forwarded in the shapes their declarations ask for rather than by reference. `lastDialFailure` is a getter, so it is forwarded as a getter and a
 * reader sees the current value rather than a snapshot taken when this object was built. `cutDials` is declared as a method, so handing its function along bare would
 * separate it from the object it was read off; the call stays inside a wrapper for that reason, even though this row never reaches it.
 */
function recordRelease(connector: OwnedConnector, calls: TeardownOperation[]): OwnedConnector {

  return {

    connect: connector.connect,
    cutDials: (reason: unknown): void => connector.cutDials(reason),

    get lastDialFailure(): Error | undefined {

      return connector.lastDialFailure;
    },

    release: (): void => {

      calls.push("connector.release");

      connector.release();
    }
  };
}

/**
 * Build a dial and a WebSocket that record every teardown operation the socket runs on them, into one log.
 *
 * The WebSocket factory vends one fixed socket for every dial, which is what makes the log readable: a row that drives a single attempt reads three entries and knows
 * they all belong to that attempt. `TestWebSocketFactory` still records the real connect URL of every call, so nothing a URL-asserting row wants is given up.
 *
 * @returns The shared log, and the two factories a row injects. See {@link TeardownRecorder}.
 */
export function recordTeardownOrder(): TeardownRecorder {

  const calls: TeardownOperation[] = [];

  return {

    calls,
    ownedDialFactory: ({ allowH2 }: OwnedDialInit): OwnedDial => {

      const connector = createOwnedConnector({ allowH2 });

      return { agent: new RecordingAgent({ allowH2, connect: connector.connect, pipelining: 0 }, calls), connector: recordRelease(connector, calls) };
    },
    webSockets: new TestWebSocketFactory(new RecordingWebSocket(calls))
  };
}
