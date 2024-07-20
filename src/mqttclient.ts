/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqttclient.ts: MQTT connectivity class for Homebridge plugins.
 */
import { HomebridgePluginLogging } from "./util.js";
import mqtt from "mqtt";
import util from "node:util";

const MQTT_DEFAULT_RECONNECT_INTERVAL = 60;

export class MqttClient {

  private brokerUrl: string;
  private isConnected: boolean;
  private reconnectInterval: number;
  private log: HomebridgePluginLogging;
  private mqtt: mqtt.MqttClient | null;
  private subscriptions: { [index: string]: (cbBuffer: Buffer) => void };
  private topicPrefix: string;

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

  // Connect to the MQTT broker.
  private configure(): void {

    // Try to connect to the MQTT broker and make sure we catch any URL errors.
    try {

      this.mqtt = mqtt.connect(this.brokerUrl, { reconnectPeriod: this.reconnectInterval * 1000, rejectUnauthorized: false});

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

  // Publish an MQTT event to a broker.
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

  // Subscribe to an MQTT topic.
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

  // Subscribe to a specific MQTT topic and publish a value on a get request.
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

  // Subscribe to a specific MQTT topic and set a value on a set request.
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

  // Unsubscribe to an MQTT topic.
  public unsubscribe(id: string, topic: string): void {

    const expandedTopic = this.expandTopic(id, topic);

    // No valid topic returned, we're done.
    if(!expandedTopic) {

      return;
    }

    delete this.subscriptions[expandedTopic];
  }

  // Expand a topic to a unique, fully formed one.
  private expandTopic(id: string, topic: string) : string | null {

    // No id, we're done.
    if(!id) {

      return null;
    }

    return this.topicPrefix + "/" + id + "/" + topic;
  }
}
