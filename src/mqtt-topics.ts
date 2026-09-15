/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mqtt-topics.ts: The MQTT topic vocabulary the client, its shipped test double, and every consumer compose their topics through.
 */

/**
 * The MQTT topic vocabulary every other MQTT module and every consumer reads: the device-scoped composer both `unsubscribe` verbs spell the `(id, topic)` tuple
 * through, the get and set children the client subscribes on, and the catalog a plugin declares its whole topic surface in.
 *
 * A catalog is one declaration every reader shares: the plugin's publish and subscribe sites take their tails and their log labels from it, the documentation
 * renderer projects it into the plugin's MQTT document, and the builder validates it once when the declaring module is evaluated. Braces are reserved in every tail
 * for the catalog's placeholders, so a parameterized tail names what varies rather than enumerating it, and {@link resolveMqttTopic} is the one way a value reaches
 * one.
 *
 * The module imports nothing, and that is the design rather than an accident of its size. The shipped test double reaches it, and so does the documentation renderer
 * that must stay free of every `node:` builtin to remain isomorphic. A value edge to `./util.ts` would carry `node:timers/promises` in behind it through
 * `clock.ts`, so the vocabulary stands on its own and every module above it - the transport-bearing client, the transport-free double, the renderer - composes the
 * same topics from the same statements.
 *
 * @module
 */

/**
 * The suffix the client appends to a topic to name the child a get request arrives on. A `"true"` message there asks for a republish on the parent topic.
 *
 * The constant is what a reader taking a child apart again works from: {@link mqtt-client-double!TestMqttClient.invokeGet | TestMqttClient.invokeGet} strips exactly
 * this much off a recorded topic to recover the parent it republishes to. A reader composing a child rather than splitting one names it through
 * {@link mqttGetTopic}.
 *
 * @category Utilities
 */
export const MQTT_GET_SUFFIX = "/get";

/**
 * The suffix the client appends to a topic to name the child a set message arrives on. Each message that arrives there carries the value the setter is asked to
 * apply.
 *
 * @category Utilities
 */
export const MQTT_SET_SUFFIX = "/set";

/**
 * Name the get child of a topic tail: the tail with {@link MQTT_GET_SUFFIX} appended.
 *
 * This is the one home of the get join, for the reason {@link mqttTopic} is the one home of the identity join - a convention repeated at each site drifts one site at
 * a time, and a convention stated once cannot. The client's own {@link mqttClient!MqttClient.subscribeGet | MqttClient.subscribeGet}, the double's registrations, the
 * documentation renderer's subscribed rows, and a consumer releasing a child through `unsubscribe(id, mqttGetTopic(entry.topic))` all spell it here.
 *
 * The `topic` parameter is typed {@link ResolvedMqttTopic}, so handing this an unresolved template is a compile error wherever the topic's literal type survives. A
 * plain `string` passes through unchanged.
 *
 * @param topic - The topic tail whose get child is being named.
 *
 * @returns The child topic a get request arrives on.
 *
 * @category Utilities
 */
export function mqttGetTopic<const T extends string>(topic: ResolvedMqttTopic<T>): string {

  return topic + MQTT_GET_SUFFIX;
}

/**
 * Name the set child of a topic tail: the tail with {@link MQTT_SET_SUFFIX} appended.
 *
 * The get child's rationale, on the set side: {@link mqttClient!MqttClient.subscribeSet | MqttClient.subscribeSet}, the double's registrations, the renderer's
 * subscribed rows, and a consumer releasing a child through `unsubscribe(id, mqttSetTopic(entry.topic))` all reach the same statement.
 *
 * The `topic` parameter is typed {@link ResolvedMqttTopic}, so handing this an unresolved template is a compile error wherever the topic's literal type survives. A
 * plain `string` passes through unchanged.
 *
 * @param topic - The topic tail whose set child is being named.
 *
 * @returns The child topic a set message arrives on.
 *
 * @category Utilities
 */
export function mqttSetTopic<const T extends string>(topic: ResolvedMqttTopic<T>): string {

  return topic + MQTT_SET_SUFFIX;
}

// The placeholder grammar a template is written in and every reader below matches against: an opening brace, one or more characters that are not braces, and a
// closing brace. A brace anywhere else - an empty pair, an unclosed opener - is malformed, and the builder and the shared refusal reject it rather than letting it
// reach the wire.
//
// The constant is read only through `matchAll` and `replace`, both of which start from the beginning of their subject. `exec` and `test` carry a global expression's
// `lastIndex` from one call to the next, and one constant answering every caller in the process cannot afford that.
const PLACEHOLDER = /\{([^{}]+)\}/g;

// The fields an entry may declare, read once per entry when the catalog is built. The runtime is the guard for a stray field because TypeScript's excess-property
// check does not reach an entry literal handed to a generic builder unless the stray name is a near miss of a real one.
const ENTRY_FIELDS = new Set([ "devices", "get", "getDevices", "group", "label", "publish", "publishDevices", "set", "setDevices", "topic" ]);

/**
 * The parameter names a topic template carries, as a union of string literals, and `never` for a plain tail.
 *
 * The derivation is what makes {@link resolveMqttTopic}'s parameter record exact: the template's own text names the keys that record must carry, so a misspelled or
 * missing name is a compile error at the call site rather than an `undefined` segment on the wire. It holds only while the topic's literal type survives, which is
 * the authoring rule {@link mqttTopicCatalog} states, and it is why every reader below refuses a stray brace at runtime as well.
 *
 * @typeParam T - The topic template whose parameter names are being read.
 *
 * @category Utilities
 */
export type MqttTopicParameters<T extends string> = T extends `${string}{${infer Name}}${infer Rest}` ? Name | MqttTopicParameters<Rest> : never;

/**
 * A topic carrying no unresolved placeholder: the topic itself when it is plain, and a sentence saying what to do about it when it is not.
 *
 * This is the parameter type {@link mqttTopic}, {@link mqttGetTopic}, and {@link mqttSetTopic} take, so handing a composer a template reads as a type error naming
 * the remedy rather than as a topic no broker ever matches. A plain `string` resolves to itself, so every caller composing a tail it computed at runtime is
 * unaffected.
 *
 * @typeParam T - The topic being composed.
 *
 * @category Utilities
 */
export type ResolvedMqttTopic<T extends string> = [MqttTopicParameters<T>] extends [never] ? T :
  "This topic carries a placeholder; resolve it through resolveMqttTopic before composing it.";

/**
 * A topic whose every placeholder names a parameter: the topic itself, and a sentence when one of them is the empty pair.
 *
 * {@link resolveMqttTopic} takes its topic through this type because an empty placeholder names no parameter, so no record could resolve it. A compile error says
 * that at the call site where the literal survives, and the resolver's residual check says it everywhere else.
 *
 * @typeParam T - The topic being resolved.
 *
 * @category Utilities
 */
export type WellFormedMqttTopic<T extends string> = "" extends MqttTopicParameters<T> ?
  "This topic carries an empty placeholder; a placeholder names its parameter." : T;

/**
 * The key a catalog's device column is attached under. A symbol, so no entry key can collide with it and no iteration over the entries - `Object.entries`,
 * `Object.keys`, `for...in` - ever lists it.
 *
 * @category Utilities
 */
export const MQTT_DEVICE_COLUMN: unique symbol = Symbol("MqttTopicDeviceColumn");

/**
 * The device-type column a plugin's MQTT document carries, declared once beside the entries.
 *
 * Documentation only: nothing at runtime reads it, so it is data the renderer projects rather than a hook anything calls. Entries name device kinds by key into
 * `vocabulary`, and the renderer joins an entry's labels in the order the vocabulary declares them, so one declaration fixes both the spelling of every label and
 * the order every cell reads in.
 *
 * @property heading    - The column's header text, as the document prints it.
 * @property vocabulary - The device kinds, from the key an entry names to the label a cell shows.
 *
 * @typeParam V - The vocabulary's own shape, inferred from the declaration so an entry naming an undeclared kind is a compile error.
 *
 * @category Utilities
 */
export interface MqttTopicDeviceColumn<V extends Readonly<Record<string, string>> = Readonly<Record<string, string>>> {

  readonly heading: string;
  readonly vocabulary: V;
}

/**
 * One topic a plugin declares: its tail, the name its verbs log under, the document's message texts, and the device kinds it belongs to.
 *
 * The presence of `publish`, `get`, and `set` is the declaration that the plugin performs that verb. A consumer publishes an entry only when it declares `publish`,
 * and the renderer emits exactly the rows the entry declares, so one declaration answers both what the code does and what the document says. Author-owned markdown
 * in the three message texts reaches the document verbatim, except the column separator, which the renderer escapes. A verb's narrowing - `getDevices`,
 * `publishDevices`, `setDevices` - names the listed kinds that perform that verb when fewer than all of them do; a verb without one is performed by every listed
 * kind. Like `devices`, a narrowing is documentation the renderer projects and the runtime never reads.
 *
 * @property devices        - Optional. The device kinds the topic belongs to, named by key into the catalog's column vocabulary, as a non-empty tuple. Present only when
 *                            the catalog declares a column, which the builder's two overloads make a compile-time pair wherever the entries' literal type survives.
 * @property get            - Optional. The message text the document prints for the topic's get child. Its presence declares that the plugin subscribes to that child.
 * @property getDevices     - Optional. The listed kinds that answer the get child, when fewer than all of them do: a non-empty tuple drawn from `devices`, named by the
 *                            same keys. Documentation only.
 * @property group          - Optional. The heading the entry's rows render under. A catalog groups all of its entries or none of them.
 * @property label          - The name the get and set verbs log under, handed to `subscribeGet` and `subscribeSet` as their `type` argument.
 * @property publish        - Optional. The message text the document prints for the published topic. Its presence declares that the plugin publishes it.
 * @property publishDevices - Optional. The listed kinds that publish the topic, when fewer than all of them do: a non-empty tuple drawn from `devices`, named by the same
 *                            keys. Documentation only.
 * @property set            - Optional. The message text the document prints for the topic's set child. Its presence declares that the plugin subscribes to that child.
 * @property setDevices     - Optional. The listed kinds that answer the set child, when fewer than all of them do: a non-empty tuple drawn from `devices`, named by the
 *                            same keys. Documentation only.
 * @property topic          - The tail relative to the identity the caller composes with, or the whole topic after the prefix for a plugin that composes no identity. A
 *                            template when it carries placeholders.
 *
 * @typeParam TDevice - The device-kind keys this entry may name, fixed by the catalog's column vocabulary.
 *
 * @category Utilities
 */
export interface MqttTopicEntry<TDevice extends string = string> {

  readonly devices?: readonly [TDevice, ...TDevice[]];
  readonly get?: string;
  readonly getDevices?: readonly [TDevice, ...TDevice[]];
  readonly group?: string;
  readonly label: string;
  readonly publish?: string;
  readonly publishDevices?: readonly [TDevice, ...TDevice[]];
  readonly set?: string;
  readonly setDevices?: readonly [TDevice, ...TDevice[]];
  readonly topic: string;
}

/**
 * The keyed record a plugin hands {@link mqttTopicCatalog}. The keys are the names its call sites read entries by.
 *
 * @typeParam TDevice - The device-kind keys the entries may name.
 *
 * @category Utilities
 */
export type MqttTopicEntries<TDevice extends string = string> = Readonly<Record<string, MqttTopicEntry<TDevice>>>;

/**
 * The entries a catalog declaring a device column hands {@link mqttTopicCatalog}: every one of them carrying a non-empty `devices` list.
 *
 * The column and the lists are one decision, so the builder's column-bearing overload constrains its entries through this type and an entry that forgot its list
 * fails to compile rather than reaching the renderer as a documentation defect.
 *
 * @typeParam TDevice - The device-kind keys the entries may name, taken from the column's vocabulary.
 *
 * @category Utilities
 */
export type MqttTopicEntriesWithDevices<TDevice extends string> =
  Readonly<Record<string, MqttTopicEntry<TDevice> & { readonly devices: readonly [TDevice, ...TDevice[]] }>>;

/**
 * What the column-bearing form of {@link mqttTopicCatalog} returns: the entries exactly as the plugin declared them, with the device column attached under
 * {@link MQTT_DEVICE_COLUMN}.
 *
 * The shape is a named export so that a consumer can spell it. A plugin that exports its own catalog and emits declarations has to write this return type into
 * its declaration file, and a type keyed by a unique symbol can be written there only through an alias the library exports: the emitter names the alias from a
 * module that imports the builder alone, where it has no way to reference the key as a value.
 *
 * @typeParam T - The entries as declared, whose literal type carries through so per-key access and the placeholder guard read the same as at the call site.
 * @typeParam V - The column vocabulary's own shape.
 *
 * @category Utilities
 */
export type MqttTopicCatalogWithColumn<T, V extends Readonly<Record<string, string>>> = T & { readonly [MQTT_DEVICE_COLUMN]: MqttTopicDeviceColumn<V> };

/**
 * What {@link mqttTopicCatalog} returns and the renderer reads: the entries, with the device column attached under {@link MQTT_DEVICE_COLUMN} when one was
 * declared. The symbol key is invisible to every iteration over the entries, so a plugin's call sites and the renderer both walk the entries alone.
 *
 * @typeParam TDevice - The device-kind keys the entries name.
 * @typeParam V       - The column vocabulary's own shape.
 *
 * @category Utilities
 */
export type MqttTopicCatalog<TDevice extends string = string, V extends Readonly<Record<string, string>> = Readonly<Record<string, string>>> =
  MqttTopicEntries<TDevice> & { readonly [MQTT_DEVICE_COLUMN]?: MqttTopicDeviceColumn<V> };

/**
 * The placeholder names a topic carries, in order of appearance, and an empty list for a plain tail. A name repeated in the topic is listed once per appearance.
 *
 * The renderer reads this to build the markup a parameterized topic cell shows; a consumer rarely needs it, since the parameter record's own keys are what a call
 * site works from.
 *
 * @param topic - The topic to read the placeholder names out of.
 *
 * @returns The names, in the order the topic spells them.
 *
 * @category Utilities
 */
export function mqttTopicPlaceholders(topic: string): readonly string[] {

  // Each match carries exactly the one capture group the grammar declares, so taking every group off every match is the list of names in order.
  return [...topic.matchAll(PLACEHOLDER)].flatMap((match) => match.slice(1));
}

/**
 * Refuse a topic that still carries a brace, naming the caller that meant to use it.
 *
 * The one refusal the resolver, the client's three wire verbs, and the shipped double all reach, shared the way the guarded-publish router is shared: the predicate
 * and the sentence are stated once, so a topic that would have gone to the broker with an unresolved placeholder in it is refused identically wherever it was
 * headed. The compile-time guard covers the call sites where a topic's literal type survives; this covers every other one, which is what makes the contract
 * unconditional rather than conditional on how a plugin declared its catalog.
 *
 * @param caller - The symbol whose name opens the message, so the refusal reads as the verb that met it.
 * @param topic  - The topic to check.
 *
 * @throws `Error` naming the caller and the topic when the topic carries either brace.
 *
 * @category Utilities
 */
export function assertResolvedMqttTopic(caller: string, topic: string): void {

  if(topic.includes("{") || topic.includes("}")) {

    throw new Error(caller + ": the topic \"" + topic + "\" carries a brace; a placeholder must be resolved through resolveMqttTopic before the topic is used.");
  }
}

/**
 * Resolve a topic template against a record of parameter values: each placeholder is replaced by the parameter of that name, and a plain tail passes through
 * unchanged.
 *
 * The record's keys are derived from the template's own literal type, so a misspelled or missing name is a compile error at every call site where that literal
 * survives. Where it does not, the two throws below are what stand in its place: a placeholder naming a parameter the record does not carry, and a brace left in
 * the result that the grammar never admitted. A parameter's VALUE goes in verbatim - a value carrying a slash extends the topic's hierarchy, which is the caller's
 * to prevent, since the value is the caller's own wire data.
 *
 * @param topic      - The topic template to resolve.
 * @param parameters - The value for each placeholder the template names.
 *
 * @returns The resolved topic.
 *
 * @throws `Error` naming the placeholder when the record does not carry it, and naming the topic when the result still carries a brace.
 *
 * @example
 *
 * ```ts
 * await mqtt.publish(mqttTopic(device.mac, resolveMqttTopic(mqttTopics.smartMotion.topic, { object: event.type })), "true");
 * ```
 *
 * @category Utilities
 */
export function resolveMqttTopic<const T extends string>(topic: WellFormedMqttTopic<T>, parameters: Readonly<Record<MqttTopicParameters<T>, string>>): string {

  // The parameter types are the compile-time half of the guard and carry no runtime shape, so the body reads the template as the string it is and the record as the
  // name-to-value map it is.
  const template = topic as string;
  const values = parameters as Readonly<Record<string, string>>;

  const resolved = template.replace(PLACEHOLDER, (_match: string, name: string): string => {

    const value = values[name];

    // Never splice the word "undefined" into a topic. A missing parameter is a programming error, and a topic that quietly names it would reach the broker looking
    // deliberate.
    if(value === undefined) {

      throw new Error("resolveMqttTopic: the topic \"" + template + "\" names a parameter \"" + name + "\" the record does not carry.");
    }

    return value;
  });

  // A brace surviving the replacement is a brace the grammar never admitted - an empty pair, or an opener with no close. The type refuses the empty pair where the
  // literal survives; this refuses every shape of it everywhere.
  assertResolvedMqttTopic("resolveMqttTopic", resolved);

  return resolved;
}

/**
 * Declare a plugin's MQTT topic surface: validate the entries once, attach the device column when one is given, and return the catalog its call sites and its
 * document both read.
 *
 * The catalog is the single source of truth for a plugin's topics. Its publish and subscribe sites take their tails and their log labels from it, the documentation
 * renderer projects it into the plugin's MQTT document, and this builder checks what the runtime reads the moment the declaring module is evaluated - which for the
 * documented form, `export const mqttTopics = mqttTopicCatalog(...)` at module scope, is the plugin's own import. A malformed catalog is a programming error, so it
 * is named where it can be seen rather than carried forward.
 *
 * Two overloads, because the column and the entries' device lists are one decision. Without a column, an entry declaring `devices` fails to compile. With one, the
 * vocabulary's keys are inferred from the declaration, so an entry missing its list, an empty list, and a list naming an undeclared kind each fail to compile. The
 * runtime reads nothing from the column beyond attaching it: the document's own checks - a missing or stray list, an unknown key, mixed groups, a narrowing that
 * names an unlisted kind or a verb the entry does not declare - belong to the renderer, because the compiled JavaScript the CLI loads carries no types and a
 * documentation mistake should fail the docs build rather than a plugin's startup.
 *
 * The authoring rule the compile-time half depends on: TypeScript keeps a topic's literal type while the entries literal reaches this builder inline, or through
 * group constants declared `as const` and spread into the call. An intermediate constant without `as const`, a spread of plain constants, or an explicit type
 * annotation on the exported catalog widens every topic to `string` and silences the guard. Declare the catalog inline or from `as const` groups, and never
 * annotate the export - the builder types it. Because that half is conditional on how the catalog is written, {@link assertResolvedMqttTopic} at the client's three
 * wire verbs is what makes the contract unconditional.
 *
 * @param entries - The topics, keyed by the names the plugin's call sites read them by.
 *
 * @returns A fresh catalog carrying every entry. The caller's own literal is never mutated.
 *
 * @throws `Error` naming the offending key when the catalog declares no entries, when an entry declares a field the entry type does not admit, an empty topic,
 *         none of `publish`, `get`, or `set`, or a brace outside a well-formed placeholder, and naming both keys when two entries produce the same wire topic.
 *
 * @example
 *
 * ```ts
 * import { mqttGetTopic, mqttTopic, mqttTopicCatalog, resolveMqttTopic } from "homebridge-plugin-utils";
 *
 * export const mqttTopics = mqttTopicCatalog({
 *
 *   lock: { devices: ["camera"], get: "`true` requests a publish of the current lock state.", group: "Door", label: "lock",
 *     publish: "`true` when locked, `false` when unlocked.", set: "`true` to lock, `false` to unlock.", topic: "lock" },
 *   smartMotion: { devices: [ "camera", "sensor" ], group: "Motion", label: "smart motion",
 *     publish: "The smart detection event for the named object class.", topic: "motion/smart/{object}" }
 * }, { heading: "Protect Device Type", vocabulary: { camera: "Camera", sensor: "Sensor" } });
 * ```
 *
 * A catalog assembled from groups keeps the guard as long as each group is declared `as const`:
 *
 * ```ts
 * const door = { lock: { label: "lock", publish: "`true` when locked.", topic: "lock" } } as const;
 * const motion = { smartMotion: { label: "smart motion", publish: "The smart detection event.", topic: "motion/smart/{object}" } } as const;
 *
 * export const mqttTopics = mqttTopicCatalog({ ...door, ...motion });
 * ```
 *
 * The call sites then read every tail and every label from that one declaration:
 *
 * ```ts
 * await mqtt.publish(mqttTopic(device.mac, mqttTopics.lock.topic), "true");
 * mqtt.subscribeGet(mqttTopics.lock.topic, mqttTopics.lock.label, () => this.lockState);
 * mqtt.unsubscribe(device.mac, mqttGetTopic(mqttTopics.lock.topic));
 * await mqtt.publish(mqttTopic(device.mac, resolveMqttTopic(mqttTopics.smartMotion.topic, { object: event.type })), "true");
 * ```
 *
 * @category Utilities
 */
export function mqttTopicCatalog<const T extends MqttTopicEntries<never>>(entries: T): T;

/**
 * Declare a topic surface that a device-type column accompanies. The validation, the authoring rule, and the examples are the ones above; what this form adds is the
 * column, inferred from its own declaration so an entry missing its device list, carrying an empty one, or naming a kind the vocabulary does not declare each fail to
 * compile wherever the entries' literal type survives.
 *
 * @param entries - The topics, keyed by the names the plugin's call sites read them by, each carrying a non-empty `devices` list.
 * @param column  - The device-type column the document prints, whose vocabulary fixes the kinds an entry may name.
 *
 * @returns A fresh {@link MqttTopicCatalogWithColumn} carrying every entry with the column attached under {@link MQTT_DEVICE_COLUMN}. The caller's own literal is
 *          never mutated.
 *
 * @category Utilities
 */
export function mqttTopicCatalog<const V extends Readonly<Record<string, string>>, const T extends MqttTopicEntriesWithDevices<keyof V & string>>(
  entries: T, column: MqttTopicDeviceColumn<V>): MqttTopicCatalogWithColumn<T, V>;

export function mqttTopicCatalog(entries: MqttTopicEntries, column?: MqttTopicDeviceColumn): MqttTopicCatalog {

  const declared = Object.entries(entries);

  if(declared.length === 0) {

    throw new Error("mqttTopicCatalog: the catalog declares no entries.");
  }

  // One map from wire tail to the key that produced it, filled in the same pass that validates each entry. A tail is one topic on the broker whatever heading it
  // renders under, so two entries reaching the same tail - directly, or one entry's tail equalling another's composed child - is a collision either way.
  const wireTails = new Map<string, string>();

  for(const [ key, entry ] of declared) {

    for(const field of Object.keys(entry)) {

      if(!ENTRY_FIELDS.has(field)) {

        throw new Error("mqttTopicCatalog: the entry " + key + " declares an unknown field \"" + field + "\".");
      }
    }

    if(!entry.topic) {

      throw new Error("mqttTopicCatalog: the entry " + key + " declares an empty topic.");
    }

    if(!entry.publish && !entry.get && !entry.set) {

      throw new Error("mqttTopicCatalog: the entry " + key + " declares none of publish, get, or set, so no verb reads it and no row documents it.");
    }

    // Every well-formed placeholder comes out; anything brace-shaped left behind is a malformed template the grammar never admitted.
    const outsidePlaceholders = entry.topic.replace(PLACEHOLDER, "");

    if(outsidePlaceholders.includes("{") || outsidePlaceholders.includes("}")) {

      throw new Error("mqttTopicCatalog: the entry " + key + " declares the topic \"" + entry.topic + "\", which carries a brace outside a placeholder.");
    }

    // The tails this entry puts on the broker: the topic itself, plus the child of each verb it declares.
    const tails = [entry.topic];

    if(entry.get) {

      tails.push(mqttGetTopic(entry.topic));
    }

    if(entry.set) {

      tails.push(mqttSetTopic(entry.topic));
    }

    for(const tail of tails) {

      const owner = wireTails.get(tail);

      if(owner !== undefined) {

        throw new Error("mqttTopicCatalog: the entries " + owner + " and " + key + " both produce the wire topic \"" + tail + "\".");
      }

      wireTails.set(tail, key);
    }
  }

  // A fresh object, so the caller's literal is never mutated and the column has exactly one home. Everything below is allocated on this call and nothing above it is
  // touched.
  return (column === undefined) ? { ...entries } : { ...entries, [MQTT_DEVICE_COLUMN]: column };
}

/**
 * Compose the topic tail for one owner's MQTT topic: the owner's identity as the leading segment, joined to the topic tail by a single slash. The client prepends the
 * topic prefix its configuration carries and nothing else, so the topic the broker sees is `prefix/id/topic`.
 *
 * Every publisher and subscriber in a plugin spells a device-scoped topic through this function rather than repeating the concatenation at each site, and the two
 * verbs that receive the tuple already split - {@link mqttClient!MqttClient.unsubscribe | MqttClient.unsubscribe} and
 * {@link mqtt-client-double!TestMqttClient.unsubscribe | TestMqttClient.unsubscribe} - rebuild the tail through it as well, so the convention has exactly one home.
 *
 * The identity is scope-agnostic: a device identity and a controller identity are both just the leading segment, so one composer serves a per-device topic and a
 * controller's own telemetry topic alike. The parameters are positional rather than named because the two strings arrive in wire order, and that order is the whole
 * of what the function states.
 *
 * The `topic` parameter is typed {@link ResolvedMqttTopic}, which is what makes handing a composer an unresolved template a compile error wherever the topic's
 * literal type survives; a plain `string` passes through unchanged, so every caller composing a tail it computed at runtime is unaffected.
 *
 * @param id    - The identity the topic addresses, spelled as the device or controller is addressed everywhere else.
 * @param topic - The topic tail relative to that identity, carried through verbatim however many segments it holds.
 *
 * @returns The composed topic tail.
 *
 * @example
 *
 * ```ts
 * import { mqttTopic } from "homebridge-plugin-utils";
 *
 * // The broker sees the client's configured topic prefix followed by this tail.
 * await mqtt.publish(mqttTopic(device.mac, "motion"), "true");
 * ```
 *
 * @category Utilities
 */
export function mqttTopic<const T extends string>(id: string, topic: ResolvedMqttTopic<T>): string {

  return id + "/" + topic;
}
