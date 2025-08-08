/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg/rtp.ts: RTP-related utilities to slice and dice RTP streams.
 *
 * This module is heavily inspired by the homebridge and homebridge-camera-ffmpeg source code and borrows from both. Thank you for your contributions to the community.
 */

/**
 * RTP and RTCP packet demultiplexer and UDP port management for FFmpeg-based HomeKit livestreaming.
 *
 * This module supplies classes and helpers to support realtime streaming via FFmpeg in Homebridge and similar HomeKit environments. It enables the demultiplexing of RTP
 * and RTCP packets on a single UDP port, as required by HomeKit and RFC 5761, working around FFmpeg’s lack of native support for RTP/RTCP multiplexing. It also manages
 * the allocation and tracking of UDP ports for RTP and RTCP, helping prevent conflicts in dynamic, multi-session streaming scenarios.
 *
 * Key features:
 *
 * - Demultiplexes RTP and RTCP packets received on a single UDP port, forwarding them to the correct FFmpeg destinations for HomeKit livestream compatibility.
 * - Injects periodic heartbeat messages to keep two-way audio streams alive with FFmpeg’s strict timeout requirements.
 * - Dynamically allocates and reserves UDP ports for RTP/RTCP, supporting consecutive port pairing for correct FFmpeg operation.
 * - Event-driven architecture for integration with plugin or automation logic.
 *
 * Designed for plugin developers and advanced users implementing HomeKit livestreaming, audio/video bridging, or similar applications requiring precise RTP/RTCP handling
 * with FFmpeg.
 *
 * @module
 */
import { EventEmitter, once } from "node:events";
import type { HomebridgePluginLogging } from "../util.js";
import { createSocket } from "node:dgram";

// How often, in seconds, should we heartbeat FFmpeg in two-way audio sessions. This should be less than 5 seconds, which is FFmpeg's input timeout interval.
const TWOWAY_HEARTBEAT_INTERVAL = 3;

/**
 * Utility for demultiplexing RTP and RTCP packets on a single UDP port for HomeKit compatibility.
 *
 * FFmpeg does not support multiplexing RTP and RTCP data on a single UDP port (RFC 5761) and HomeKit requires this for livestreaming. This class listens on a UDP port
 * and demultiplexes RTP and RTCP traffic, forwarding them to separate RTP and RTCP ports as required by FFmpeg.
 *
 * Credit to [dgreif](https://github.com/dgreif), [brandawg93](https://github.com/brandawg93), and [Sunoo](https://github.com/Sunoo) for foundational ideas and
 * collaboration.
 *
 * @example
 *
 * ```ts
 * // Create an RtpDemuxer to split packets for FFmpeg compatibility.
 * const demuxer = new RtpDemuxer("ipv4", 50000, 50002, 50004, log);
 *
 * // Close the demuxer when finished.
 * demuxer.close();
 * ```
 *
 * @see {@link https://tools.ietf.org/html/rfc5761 | RFC 5761}
 * @see {@link https://github.com/homebridge/homebridge-camera-ffmpeg | homebridge-camera-ffmpeg}
 *
 * @category FFmpeg
 */
export class RtpDemuxer extends EventEmitter {

  private heartbeatTimer!: NodeJS.Timeout;
  private heartbeatMsg!: Buffer;
  private _isRunning: boolean;
  private log?: HomebridgePluginLogging;
  private inputPort: number;
  public readonly socket;

  /**
   * Constructs a new RtpDemuxer for a specified IP family and port set.
   *
   * @param ipFamily         - The IP family: "ipv4" or "ipv6".
   * @param inputPort        - The UDP port to listen on for incoming packets.
   * @param rtcpPort         - The UDP port to forward RTCP packets to.
   * @param rtpPort          - The UDP port to forward RTP packets to.
   * @param log              - Logger instance for debug and error messages.
   *
   * @example
   *
   * ```ts
   * const demuxer = new RtpDemuxer("ipv4", 50000, 50002, 50004, log);
   * ```
   */
  constructor(ipFamily: ("ipv4" | "ipv6") , inputPort: number, rtcpPort: number, rtpPort: number, log: HomebridgePluginLogging) {

    super();

    this._isRunning = false;
    this.log = log;
    this.inputPort = inputPort;
    this.socket = createSocket(ipFamily === "ipv6" ? "udp6" : "udp4");

    // Catch errors when they happen on our demuxer.
    this.socket.on("error", (error)  => {

      this.log?.error("RtpDemuxer Error: %s", error);
      this.socket.close();
    });

    // Split the message into RTP and RTCP packets.
    this.socket.on("message", (msg) => {

      // Send RTP packets to the RTP port.
      if(this.isRtpMessage(msg)) {

        this.emit("rtp");
        this.socket.send(msg, rtpPort);

      } else {

        // Save this RTCP message for heartbeat purposes for the RTP port. This works because RTCP packets will be ignored by ffmpeg on the RTP port, effectively
        // providing a heartbeat to ensure FFmpeg doesn't timeout if there's an extended delay between data transmission.
        this.heartbeatMsg = Buffer.from(msg);

        // Clear the old heartbeat timer.
        clearTimeout(this.heartbeatTimer);
        this.heartbeat(rtpPort);

        // RTCP control packets should go to the RTCP port.
        this.socket.send(msg, rtcpPort);
      }
    });

    this.log?.debug("Creating an RtpDemuxer instance - inbound port: %s, RTCP port: %s, RTP port: %s.", this.inputPort, rtcpPort, rtpPort);

    // Take the socket live.
    this.socket.bind(this.inputPort);
    this._isRunning = true;
  }

  /**
   * Sends periodic heartbeat messages to the RTP port to keep the FFmpeg process alive.
   *
   * This is necessary because FFmpeg times out input streams if it does not receive data for more than five seconds.
   *
   * @param port - The RTP port to send the heartbeat to.
   */
  private heartbeat(port: number): void {

    // Clear the old heartbeat timer.
    clearTimeout(this.heartbeatTimer);

    // Send a heartbeat to FFmpeg every few seconds to keep things open. FFmpeg has a five-second timeout in reading input, and we want to be comfortably within the
    // margin for error to ensure the process continues to run.
    this.heartbeatTimer = setTimeout(() => {

      this.log?.debug("Sending ffmpeg a heartbeat.");

      this.socket.send(this.heartbeatMsg, port);
      this.heartbeat(port);

    }, TWOWAY_HEARTBEAT_INTERVAL * 1000);
  }

  /**
   * Closes the demuxer, its socket, and any heartbeat timers.
   *
   * @example
   *
   * ```ts
   * demuxer.close();
   * ```
   */
  public close(): void {

    this.log?.debug("Closing the RtpDemuxer instance on port %s.", this.inputPort);

    clearTimeout(this.heartbeatTimer);
    this.socket.close();
    this._isRunning = false;
    this.emit("rtp");
  }

  /**
   * Extracts the RTP payload type from a UDP packet.
   *
   * Used internally to distinguish RTP from RTCP messages.
   *
   * @param message - The UDP packet buffer.
   *
   * @returns The RTP payload type as a number.
   */
  private getPayloadType(message: Buffer): number {

    return message.readUInt8(1) & 0x7f;
  }

  /**
   * Determines if the provided UDP packet is an RTP message.
   *
   * @param message - The UDP packet buffer.
   *
   * @returns `true` if the packet is RTP, `false` if RTCP.
   */
  private isRtpMessage(message: Buffer): boolean {

    const payloadType = this.getPayloadType(message);

    return (payloadType > 90) || (payloadType === 0);
  }

  /**
   * Indicates if the demuxer is running and accepting packets.
   *
   * @returns `true` if running, otherwise `false`.
   *
   * @example
   *
   * ```ts
   * if(demuxer.isRunning) {
   *   // Demuxer is active.
   * }
   * ```
   */
  public get isRunning(): boolean {

    return this._isRunning;
  }
}

/**
 * Allocates and tracks UDP ports for RTP and RTCP to avoid port conflicts in environments with high network activity.
 *
 * This utility class is used to find and reserve available UDP ports for demuxing FFmpeg streams or other network activities.
 *
 * @example
 *
 * ```ts
 * const allocator = new RtpPortAllocator();
 *
 * // Reserve two consecutive ports for RTP and RTCP.
 * const rtpPort = await allocator.reserve("ipv4", 2);
 *
 * // Cancel reservation if not needed.
 * allocator.cancel(rtpPort);
 * ```
 *
 * @category FFmpeg
 */
export class RtpPortAllocator {

  private portsInUse: { [index: number]: boolean };

  /**
   * Instantiates a new RTP port allocator and tracker.
   */
  constructor() {

    // Initialize our in use tracker.
    this.portsInUse = {};
  }

  /**
   * Finds an available UDP port by attempting to bind a new socket.
   *
   * Loops until an available port not already marked as in use is found.
   *
   * @param ipFamily         - "ipv4" or "ipv6".
   * @param port             - Optional. The port to try to bind to. If 0, selects a random port.
   *
   * @returns A promise resolving to the available port number, or `-1` on error.
   */
  private async getPort(ipFamily: string, port = 0): Promise<number> {

    try {

      // Keep looping until we find what we're looking for: local UDP ports that are unspoken for.
      for(;;) {

        // Create a datagram socket, so we can use it to find a port.
        const socket = createSocket(ipFamily === "ipv6" ? "udp6" : "udp4");

        // Exclude this socket from Node's reference counting so we don't have issues later.
        socket.unref();

        // Listen for the bind event.
        const eventListener = once(socket, "listening");

        // Bind to the port in question. If port is set to 0, we'll get a randomly generated port generated for us.
        socket.bind(port);

        // Ensure we wait for the socket to be bound.
        // eslint-disable-next-line no-await-in-loop
        await eventListener;

        // Retrieve the port number we've gotten from the bind request.
        const assignedPort = socket.address().port;

        // We're done with the socket, let's cleanup.
        socket.close();

        // Check to see if the port is one we're already using. If it is, try again.
        if(this.portsInUse[assignedPort]) {

          continue;
        }

        // Now let's mark the port in use.
        this.portsInUse[assignedPort] = true;

        // Return the port.
        return assignedPort;
      }
    } catch(error) {

      return -1;
    }
  }

  /**
   * Internal method to reserve one or two consecutive UDP ports for FFmpeg or network use.
   *
   * If two ports are reserved, ensures they are consecutive for RTP and RTCP usage. Returns the first port in the sequence, or `-1` if we're unable to allocate.
   *
   * @param ipFamily         - Optional. "ipv4" or "ipv6". Defaults to "ipv4".
   * @param portCount        - Optional. The number of consecutive ports to reserve (1 or 2). Defaults to 1.
   * @param attempts         - Internal. The number of allocation attempts. Used for recursion.
   *
   * @returns A promise resolving to the first reserved port, or `-1` if unavailable.
   */
  private async _reserve(ipFamily: ("ipv4" | "ipv6") = "ipv4", portCount: (1 | 2) = 1, attempts = 0): Promise<number> {

    // Sanity check and make sure we're not requesting any more than two ports at a time, or if we've exceeded our attempt limit.
    if(![ 1, 2 ].includes(portCount) || (attempts > 10)) {

      return -1;
    }

    let firstPort = 0;

    // Find the appropriate number of ports being requested.
    for(let i = 0; i < portCount; i++) {

      // eslint-disable-next-line no-await-in-loop
      const assignedPort = await this.getPort(ipFamily, firstPort ? firstPort + 1 : 0);

      // We haven't gotten a port, let's try again.
      if(assignedPort === -1) {

        // If we've gotten the first port of a pair of ports, make sure we release it here.
        if(firstPort) {

          this.cancel(firstPort);
        }

        // We still haven't found what we're looking for...keep looking.
        return this._reserve(ipFamily, portCount, attempts++);
      }

      // We've seen the first port we may be looking for, let's save it.
      if(!firstPort) {

        firstPort = assignedPort;
      }
    }

    // Return the first port we've found.
    return firstPort;
  }

  /**
   * Reserves one or two consecutive UDP ports for FFmpeg or network use.
   *
   * If two ports are reserved, ensures they are consecutive for RTP and RTCP usage. Returns the first port in the sequence, or `-1` if we're unable to allocate.
   *
   * @param ipFamily         - Optional. "ipv4" or "ipv6". Defaults to "ipv4".
   * @param portCount        - Optional. The number of consecutive ports to reserve (1 or 2). Defaults to 1.
   *
   * @returns A promise resolving to the first reserved port, or `-1` if unavailable.
   *
   * @remarks FFmpeg currently lacks the ability to specify both the RTP and RTCP ports. FFmpeg always assumes, by convention, that when you specify an RTP port, the RTCP
   * port is the RTP port + 1. In order to work around that challenge, we need to always ensure that when we reserve multiple ports for RTP (primarily for two-way audio
   * use cases) that we we are reserving consecutive ports only.
   *
   * @example
   *
   * ```ts
   * // Reserve a single port.
   * const port = await allocator.reserve();
   *
   * // Reserve two consecutive ports for RTP/RTCP.
   * const rtpPort = await allocator.reserve("ipv4", 2);
   * ```
   */
  public async reserve(ipFamily: ("ipv4" | "ipv6") = "ipv4", portCount: (1 | 2) = 1): Promise<number> {

    return this._reserve(ipFamily, portCount);
  }

  /**
   * Cancels and releases a previously reserved port, making it available for future use.
   *
   * @param port - The port number to release.
   *
   * @example
   *
   * ```ts
   * allocator.cancel(50000);
   * ```
   */
  public cancel(port: number): void {

    delete this.portsInUse[port];
  }
}
