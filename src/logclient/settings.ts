/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/settings.ts: Scalar constants for the Homebridge UI log client.
 */

/* Scalar constants only. This module is the single home for the log client's plain numbers and strings; it deliberately holds no parser data tables (the ANSI regex and
 * the SGR-code-to-level map live in `parser.ts`, beside the code that owns them) and no derived policy. The reconnect-backoff curve the socket uses is deliberately the
 * log client's OWN exponential shape - a 500 ms base climbing to a 5-second ceiling - rather than `defaultRetryBackoff`'s 1-second base and 30-second ceiling: a plugin
 * developer restarts Homebridge frequently while iterating, so the tool should resume the tail snappily rather than lag up to half a minute behind. Both the base and
 * the cap therefore live here, beside the jitter fraction, and the socket layers them into its own backoff policy (see `socket.ts`).
 */

// Default host to connect to when the caller supplies none. The web UI typically runs on the same machine as Homebridge, so loopback is the sensible default.
export const DEFAULT_HOST = "localhost";

// Default homebridge-config-ui-x listen port. The web UI ships with 8581 as its out-of-the-box port; callers override via configuration when a custom port is in use.
export const DEFAULT_PORT = 8581;

// The Socket.IO namespace the live-log stream is served on. The server registers a `log` namespace; clients join it with a `40/log,` connect frame and address it on
// every subsequent message frame.
export const LOG_NAMESPACE = "log";

// The Engine.IO/Socket.IO HTTP path the WebSocket handshake is mounted at. This is the default mount point for homebridge-config-ui-x and is combined with the
// `?EIO=4&transport=websocket&token=<rawjwt>` query string to form the connect URL.
export const SOCKET_PATH = "/socket.io/";

// The pseudo-terminal column width advertised to the server in the `tail-log` request. The server sizes its `tail`/`journalctl` output to this width; 80 columns is the
// conventional terminal width and avoids the server wrapping lines at an unexpectedly narrow boundary.
export const PTY_COLUMNS = 80;

// The pseudo-terminal row count advertised to the server in the `tail-log` request. The server seeds roughly the last 500 lines regardless of this value, so the row
// count is advisory; a conventional 24-row terminal height is advertised for realism.
export const PTY_ROWS = 24;

// The base reconnect delay, in milliseconds, that anchors the log client's jittered exponential backoff curve. Kept small so a healthy session that drops momentarily
// reconnects briskly - a developer who just restarted Homebridge wants the tail back almost immediately, not after a one-second-and-climbing wait. The socket doubles
// this on each successive failed connect attempt (500, 1000, 2000, ...) until the curve reaches the ceiling at `RECONNECT_CAP_MS`.
export const RECONNECT_BASE_MS = 500;

// The maximum reconnect delay, in milliseconds, that caps the log client's exponential backoff curve. This 5-second ceiling is deliberately far lower than
// `defaultRetryBackoff`'s 30-second ceiling: a log-tailing dev tool wants to keep retrying briskly through a Homebridge restart rather than back off to a half-minute
// lag, so the curve plateaus here. Paired with `RECONNECT_BASE_MS`, the socket's backoff climbs 500, 1000, 2000, 4000, then holds at 5000 for every later attempt.
export const RECONNECT_CAP_MS = 5000;

// The fraction of a computed backoff delay used as the maximum random jitter added on top of it. Jitter spreads reconnect attempts so a fleet of clients does not
// stampede the server in lockstep after a shared outage; 0.5 means up to a 50% upward perturbation of each delay.
export const JITTER_FRACTION = 0.5;

// The additional headroom, in milliseconds, added on top of the server's advertised ping interval plus its ping timeout when sizing the liveness watchdog window. The
// server pings on a fixed cadence; the watchdog must allow for one ping interval plus the server's ping timeout plus scheduling slack before concluding the connection
// has gone silent, so this margin is added to that window to avoid a premature fire on a momentarily late ping.
export const MARGIN_MS = 5000;

// The idle gap, in milliseconds, after which a seed-served one-shot window is considered quiescent. When a `--since` (one-shot) window is served from the socket seed the
// source is the never-ending live socket, so the channel needs an explicit terminator: a re-armable quiescence watchdog re-armed on every source line. Once this much
// time elapses with no further source line (and the settle floor below has passed), the seed burst is judged complete and the one-shot ends. Kept small so a quiet log's
// one-shot exits promptly after its seed has drained.
export const SEED_QUIESCENCE_MS = 250;

// The settle floor, in milliseconds, before a seed-served one-shot window may terminate, measured from the snapshot horizon captured at channel entry. The ~500-line seed
// arrives as a fast burst, but a momentary intra-burst stall shorter than this floor must not be mistaken for the end of the burst and truncate the window. Holding the
// quiescence terminator off until the floor has passed guarantees the whole seed burst is given time to arrive before the one-shot can end, so a quiet log terminates at
// roughly this floor rather than at the much later hard cap.
export const SEED_SETTLE_MS = 1000;

// The hard cap, in milliseconds, on a seed-served one-shot window, measured from the snapshot horizon. A perpetually-chatty log keeps producing source lines, which keeps
// re-arming the quiescence terminator indefinitely, so this cap guarantees the one-shot terminates regardless. Because the seed burst is fast (the recent tail, not the
// multi-second whole-file download), the cap is comfortably longer than any legitimate seed burst and so never truncates one - it bounds only the busy-log case where
// post-horizon live lines (filtered out of the window) would otherwise keep the channel open forever.
export const SEED_WINDOW_MAX_MS = 5000;
