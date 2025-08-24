/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqttclient.ts: MQTT connectivity class for Homebridge plugins.
 */

/**
 * MQTT connectivity and topic management for Homebridge plugins.
 *
 * @module
 */
import type { HomebridgePluginLogging, Nullable } from "./util.js";
import { type MqttClient as MqttJsClient, connect} from "mqtt";
import util from "node:util";

const MQTT_DEFAULT_RECONNECT_INTERVAL = 60;

/**
 * MQTT connectivity and topic management class for Homebridge plugins.
 *
 * This class manages connection, publishing, subscription, and message handling for an MQTT broker, and provides convenience methods for Homebridge accessories to
 * interact with MQTT topics using a standard topic prefix.
 *
 * @example
 *
 * ```ts
 * const mqtt = new MqttClient("mqtt://localhost:1883", "homebridge", log);
 *
 * // Publish a message to a topic.
 * mqtt.publish("device1", "status", "on");
 *
 * // Subscribe to a topic.
 * mqtt.subscribe("device1", "status", (msg) => {
 *
 *   console.log(msg.toString());
 * });
 *
 * // Subscribe to a 'get' topic and automatically publish a value in response.
 * mqtt.subscribeGet("device1", "temperature", "Temperature", () => "21.5");
 *
 * // Subscribe to a 'set' topic and handle value changes.
 * mqtt.subscribeSet("device1", "switch", "Switch", (value) => {
 *
 *   console.log("Switch set to", value);
 * });
 *
 * // Unsubscribe from a topic.
 * mqtt.unsubscribe("device1", "status");
 * ```
 */
export class MqttClient {

  private brokerUrl: string;
  private isConnected: boolean;
  private reconnectInterval: number;
  private log: HomebridgePluginLogging;
  private mqtt: Nullable<MqttJsClient>;
  private subscriptions: { [index: string]: ((cbBuffer: Buffer) => void) | undefined };
  private topicPrefix: string;

  /**
   * Creates a new MQTT client for connecting to a broker and managing topics with a given prefix.
   *
   * @param brokerUrl          - The MQTT broker URL (e.g., "mqtt://localhost:1883").
   * @param topicPrefix        - Prefix to use for all MQTT topics (e.g., "homebridge").
   * @param log                - Logger for debug and info messages.
   * @param reconnectInterval  - Optional. Interval (in seconds) to wait between reconnection attempts. Defaults to 60 seconds.
   *
   * @example
   *
   * ```ts
   * const mqtt = new MqttClient("mqtt://localhost", "homebridge", log);
   * ```
   *
   * @remarks URL must conform to formats supported by {@link https://github.com/mqttjs/MQTT.js | MQTT.js}.
   */
  constructor(brokerUrl: string, topicPrefix: string, log: HomebridgePluginLogging, reconnectInterval = MQTT_DEFAULT_RECONNECT_INTERVAL) {

    this.brokerUrl = brokerUrl;
    this.isConnected = false;
    this.log = log;
    this.mqtt = null;
    this.reconnectInterval = reconnectInterval;
    this.subscriptions = {};
    this.topicPrefix = topicPrefix;

    this.configure();
  }

  /**
   * Initializes and connects the MQTT client to the broker, setting up event handlers for connection, messages, and errors.
   *
   * Catches invalid broker URLs and logs errors. Handles all major MQTT client events internally.
   */
  private configure(): void {

    // Try to connect to the MQTT broker and make sure we catch any URL errors.
    try {

      this.mqtt = connect(this.brokerUrl, { reconnectPeriod: this.reconnectInterval * 1000, rejectUnauthorized: false});

    } catch(error) {

      if(error instanceof Error) {

        switch(error.message) {

          case "Missing protocol":

            this.log.error("MQTT Broker: Invalid URL provided: %s.", this.brokerUrl);

            break;

          default:

            this.log.error("MQTT Broker: Error: %s.", error.message);

            break;
        }
      }
    }

    // We've been unable to even attempt to connect. It's likely we have a configuration issue - we're done here.
    if(!this.mqtt) {

      return;
    }

    // Notify the user when we connect to the broker.
    this.mqtt.on("connect", () => {

      this.isConnected = true;

      // Inform users, while redacting authentication credentials.
      this.log.info("MQTT Broker: Connected to %s (topic: %s).", this.brokerUrl.replace(/^(.*:\/\/.*:)(.*)(@.*)$/, "$1REDACTED$3"), this.topicPrefix);
    });

    // Notify the user when we've disconnected.
    this.mqtt.on("close", () => {

      // We only inform users if we're already connected. Otherwise, we're likely in an error state and that's logged elsewhere.
      if(!this.isConnected) {

        return;
      }

      this.isConnected = false;

      // Inform users.
      this.log.info("MQTT Broker: Connection closed.");
    });

    // Process inbound messages and pass it to the right message handler.
    this.mqtt.on("message", (topic: string, message: Buffer) => {

      this.subscriptions[topic]?.(message);
    });

    // Notify the user when there's a connectivity error.
    this.mqtt.on("error", (error: Error) => {

      const logError = (message: string): void => this.log.error("MQTT Broker: %s. Will retry again in %s minute%s.", message, this.reconnectInterval / 60,
        this.reconnectInterval / 60 > 1 ? "s" : "");

      switch((error as NodeJS.ErrnoException).code) {

        case "ECONNREFUSED":

          logError("Connection refused");

          break;

        case "ECONNRESET":

          logError("Connection reset");

          break;

        case "ENOTFOUND":

          this.mqtt?.end(true);
          this.log.error("MQTT Broker: Hostname or IP address not found.");

          break;

        default:

          logError(util.inspect(error, { sorted: true }));

          break;
      }
    });
  }

  /**
   * Publishes a message to a topic for a specific device.
   *
   * Expands the topic using the topic prefix and device ID, then publishes the provided message string.
   *
   * @param id      - The device or accessory identifier.
   * @param topic   - The topic name to publish to.
   * @param message - The message payload to publish.
   *
   * @example
   *
   * ```ts
   * mqtt.publish("device1", "status", "on");
   * ```
   */
  public publish(id: string, topic: string, message: string): void {

    const expandedTopic = this.expandTopic(id, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    this.log.debug("MQTT publish: %s Message: %s.", expandedTopic, message);

    // By default, we publish as: pluginTopicPrefix/id/topic
    this.mqtt?.publish(expandedTopic, message);
  }

  /**
   * Subscribes to a topic for a specific device and registers a handler for incoming messages.
   *
   * The topic is expanded using the prefix and device ID, and the callback will be called for each message received.
   *
   * @param id       - The device or accessory identifier.
   * @param topic    - The topic name to subscribe to.
   * @param callback - Handler function called with the message buffer.
   *
   * @example
   *
   * ```ts
   * mqtt.subscribe("device1", "status", (msg) => {
   *
   *   console.log(msg.toString());
   * });
   * ```
   */
  public subscribe(id: string, topic: string, callback: (cbBuffer: Buffer) => void): void {

    const expandedTopic = this.expandTopic(id, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    this.log.debug("MQTT subscribe: %s.", expandedTopic);

    // Add to our callback list.
    this.subscriptions[expandedTopic] = callback;

    // Tell MQTT we're subscribing to this event.
    // By default, we subscribe as: pluginTopicPrefix/id/topic
    this.mqtt?.subscribe(expandedTopic);
  }

  /**
   * Subscribes to a '<topic>/get' topic and publishes a value in response to "true" messages.
   *
   * When a message "true" is received on the '<topic>/get' topic, this method will publish the result of `getValue()` on the main topic. The log will record each status
   * publication event.
   *
   * @param id       - The device or accessory identifier.
   * @param topic    - The topic name to use.
   * @param type     - A human-readable label for log messages (e.g., "Temperature").
   * @param getValue - Function to get the value to publish as a string.
   * @param log      - Optional logger for status output. Defaults to the class logger.
   *
   * @example
   *
   * ```ts
   * mqtt.subscribeGet("device1", "temperature", "Temperature", () => "21.5");
   * ```
   */
  public subscribeGet(id: string, topic: string, type: string, getValue: () => string, log = this.log): void {

    // Return the current status of a given sensor.
    this.subscribe(id, topic + "/get", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      // When we get the right message, we return the system information JSON.
      if(value !== "true") {

        return;
      }

      this.publish(id, topic, getValue());
      log.info("MQTT: %s status published.", type);
    });
  }

  /**
   * Subscribes to a '<topic>/set' topic and calls a setter when a message is received.
   *
   * The `setValue` function is called with both a normalized value and the raw string. Handles both synchronous and promise-based setters. Logs when set messages are
   * received and when errors occur.
   *
   * @param id        - The device or accessory identifier.
   * @param topic     - The topic name to use.
   * @param type      - A human-readable label for log messages (e.g., "Switch").
   * @param setValue  - Function to call when a value is set. Can be synchronous or return a Promise.
   * @param log       - Optional logger for status output. Defaults to the class logger.
   *
   * @example
   *
   * ```ts
   * mqtt.subscribeSet("device1", "switch", "Switch", (value) => {
   *
   *   console.log("Switch set to", value);
   * });
   * ```
   */
  public subscribeSet(id: string, topic: string, type: string, setValue: (value: string, rawValue: string) => Promise<void> | void, log = this.log): void {

    // Return the current status of a given sensor.
    this.subscribe(id, topic + "/set", (message: Buffer) => {

      const value = message.toString().toLowerCase();

      const logResult = (): void => log.info("MQTT: set message received for %s: %s.", type, value);

      // Set our value and inform the user.
      const result = setValue(value, message.toString());

      // For callbacks that are promises, we wait until they complete before logging the result.
      if(result && typeof result.then === "function") {

        result.then(logResult).catch(error => log.error("MQTT: error seting message received for %s: %s. %s", type, value, error));

        return;
      }

      // Log the outcome.
      logResult();
    });
  }

  /**
   * Unsubscribes from a topic for a specific device, removing its message handler.
   *
   * @param id    - The device or accessory identifier.
   * @param topic - The topic name to unsubscribe from.
   *
   * @example
   *
   * ```ts
   * mqtt.unsubscribe("device1", "status");
   * ```
   */
  public unsubscribe(id: string, topic: string): void {

    const expandedTopic = this.expandTopic(id, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    delete this.subscriptions[expandedTopic];
  }

  /**
   * Expands a topic string into a fully-formed topic path including the prefix and device ID.
   *
   * Returns `null` if the device ID is missing or empty.
   *
   * @param id    - The device or accessory identifier.
   * @param topic - The topic name to expand.
   *
   * @returns The expanded topic string, or `null` if the ID is missing.
   *
   * @example
   *
   * ```ts
   * const topic = mqtt['expandTopic']("device1", "status");
   * // topic = "homebridge/device1/status"
   * ```
   */
  private expandTopic(id: string, topic: string) : Nullable<string> {

    // No id, we're done.
    if(!id) {

      return null;
    }

    return this.topicPrefix + "/" + id + "/" + topic;
  }
}
