/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/index.ts: Public barrel for the Homebridge UI log client (the hblog engine).
 */

/** The log client's public surface, re-exported for consumption through the package barrel (`import { HomebridgeLogClient } from "homebridge-plugin-utils"`).
 *
 * This is a curated barrel, not an `export *` of every module: the subsystem has a deliberate public/internal split. The consumer-facing engine (the client, its options
 * and stream type, the domain vocabulary, the line parser/splitter, the filter), the dependency-inversion seams power users need to substitute their own transport (the
 * socket and WebSocket factories plus their production defaults), the lower-level transports that power users may compose directly (`acquireToken`, `downloadLog`,
 * `LogSocket`), and the reusable test doubles are surfaced here. The purely-internal machinery - the Engine.IO/Socket.IO frame codec, the history-plus-live stitch, the
 * URL builders, the scalar settings, and the CLI layer (`config.ts`, `cli-run.ts`, `cli.ts`) - is intentionally NOT re-exported, so those internals can be refactored
 * without a breaking change to the published surface. Every symbol below carries an `@category Log Client` tag (or `@category Testing` for the doubles).
 *
 * The CLI bin (`cli.ts`) does not ride this barrel: a bin must reach its engine through a realpath-canonicalized dynamic import rather than a package specifier, so it is
 * deliberately absent here. See `cli.ts` for that rationale.
 *
 * @module
 */
export type { LogClientCredentials, LogLevel, LogQuantity, LogRecord, TailRequest } from "./types.ts";
export type { HomebridgeLogClientOptions, LogStream } from "./client.ts";
export type { LogSocketFactory, LogSocketInit, LogSocketLike, TokenProvider, WebSocketFactory, WebSocketLike } from "./socket.ts";
export type { AcquireTokenOptions, LogAuthErrorKind, LogAuthErrorOptions } from "./auth.ts";
export type { DownloadLogOptions } from "./rest.ts";
export type { LogFilterCriteria } from "./filter.ts";
export type { TestLogSocketInit } from "./socket-double.ts";
export { LogSocket, WEBSOCKET_OPEN, logSocketFactory, reconnectBackoff, webSocketFactory } from "./socket.ts";
export { LogAuthError, acquireToken, isPermanentAuthError } from "./auth.ts";
export { LogLineSplitter, parseLogLine } from "./parser.ts";
export { TestLogSocket, TestLogSocketFactory, TestWebSocket, TestWebSocketFactory } from "./socket-double.ts";
export { HomebridgeLogClient } from "./client.ts";
export { createLogFilter } from "./filter.ts";
export { downloadLog } from "./rest.ts";
