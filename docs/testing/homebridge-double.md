[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / testing/homebridge-double

# testing/homebridge-double

A Homebridge test double built on the real thing.

hap-nodejs builds services, characteristics and accessories with no storage, no bridge server, no mDNS and no referenced handle, and Homebridge's
`PlatformAccessory` is a thin wrapper over a HAP accessory, so a faithful double needs no hand-built model of HAP or Homebridge: [loadHomebridge](#loadhomebridge) hands a
suite the HAP namespace and the classes Homebridge itself runs, [TestHomebridgeApi](#testhomebridgeapi) stands in for the API Homebridge hands a plugin by running Homebridge's
own API and bridge service behind it, and [triggerGet](#triggerget) and [triggerSet](#triggerset) drive a characteristic the way a HomeKit controller's read and write requests
do. A refused request rejects with a [HomeKitRequestError](#homekitrequesterror) carrying HAP's status and whether a handler faulted, which [hapStatus](#hapstatus-1) reads, and
[hasGetHandler](#hasgethandler) and [hasSetHandler](#hassethandler) tell a suite whether those requests have plugin code to call. [watchServerWarnings](#watchserverwarnings) builds a suite's API
doubles and checks each after every test, once the test's own cleanups have run, through [assertNoServerWarnings](#assertnoserverwarnings), which fails a test that left untaken
a warning Homebridge logged on an API double, or a warning or an error HAP raised on an accessory the double made.

The loader resolves Homebridge from the caller's location and requires hap-nodejs from Homebridge's own entry point, because the copy a plugin's handlers meet at
runtime is the one Homebridge loads, and a plugin's tree can hold another. HAP recognizes a status error by `instanceof` against its own copy's class, so a
suite running on any other copy sees a handler's status turn into a generic communication failure. The same resolution reaches the classes: Homebridge's
`exports` field opens only its index, which exports `PlatformAccessory` and `Logger` as types alone and Homebridge's API class and bridge service not at all, so
the loader imports `dist/platformAccessory.js`, `dist/api.js`, `dist/bridgeService.js` and `dist/logger.js` by file URL from Homebridge's own directory, which
package exports do not govern. The accessory, API and bridge service modules import hap-nodejs themselves, and it resolves to the very module the loader
required, so the classes and the namespace a suite holds share one HAP. A Homebridge release that moves one of those files or renames its export stops the
loader with a sentence naming what it looked for, at load rather than at the first accessory.

This module reaches Homebridge and hap-nodejs only inside [loadHomebridge](#loadhomebridge), and only from the caller's tree: every other reference to them is a type,
so importing the testing entry point loads neither.

[TestHomebridgeApi](#testhomebridgeapi) answers the part of Homebridge's `API` a plugin's accessory code reaches, the HAP namespace, the `platformAccessory` class, the
accessory calls and the lifecycle events, and leaves out the rest, such as `registerPlatform`, `user` and `version`, so the compiler does not take it for an
`API`. Code that declares only the part of the API it reaches, as [AccessoryPersistence](../accessory-persistence.md#accessorypersistence) does, takes the
double directly. A suite hands it to code that takes the whole `API`, such as a platform's constructor, with a cast at the rig boundary, the one place the suite
decides what the code under test can reach:

```ts
import { loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";
import type { API } from "homebridge";
import { ExamplePlatform } from "../src/platform.ts";

const setup = watchServerWarnings(await loadHomebridge(import.meta.url));
const api = setup();
const platform = new ExamplePlatform(log, config, api as unknown as API);
```

Every accessory the API double makes records what HAP raises on it. Value changes are heard on each service's own `characteristic-change` event, which HAP
raises whether the accessory is bridged or not, rather than on the accessory, which HAP raises its change event on only while the accessory is bridged, and
which the bridge's removal strips of every listener. Characteristic warnings are heard on the accessory, where a listener also keeps HAP from printing them.
HAP's name check is the exception: it prints straight to the console from the accessory and service constructors, outside the warning channel, so no
listener captures it.

[assertNoServerWarnings](#assertnoserverwarnings) describes which warnings in that record fail the check after each test, and how a test takes the ones it expects.

## Testing

### HomebridgeServerWarning

The failure of one of [TestHomebridgeApi](#testhomebridgeapi)'s calls, or of its construction, during which Homebridge's server logged a warning or an error: an Error whose
message quotes those lines and which carries them.

Homebridge carries on past what it warns of, skipping a duplicate registration, orphaning an accessory it cannot restore or failing to save its cache, so a plugin
that triggers one of those runs on under Homebridge with only a line in the log to show for it. The double throws instead, once Homebridge has finished the call,
so a suite meets the warning where the call was made.

The throw takes nothing from the double's held set: each line stays held by the API whose call logged it until a test takes it through
[TestHomebridgeApi.takeServerWarnings](#takeserverwarnings), and [assertNoServerWarnings](#assertnoserverwarnings) fails a test that left one, a warning plugin code caught included.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new HomebridgeServerWarning(lines): HomebridgeServerWarning;
```

Create the failure of a call during which Homebridge logged the given lines.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `lines` | readonly [`HomebridgeServerLogLine`](#homebridgeserverlogline)[] | The warn and error lines Homebridge logged. |

###### Returns

[`HomebridgeServerWarning`](#homebridgeserverwarning)

###### Overrides

`Error.constructor`

#### Properties

| Property | Modifier | Type | Description | Overrides |
| ------ | ------ | ------ | ------ | ------ |
| <a id="lines"></a> `lines` | `public readonly` | readonly [`HomebridgeServerLogLine`](#homebridgeserverlogline)[] | The warn and error lines Homebridge logged during the call or any call nested inside it, in the order it logged them. | - |
| <a id="name"></a> `name` | `public readonly` | `"HomebridgeServerWarning"` | - | `Error.name` |

***

### HomeKitRequestError

The refusal a HomeKit controller's read or write request met, as [triggerGet](#triggerget) and [triggerSet](#triggerset) reject with it: an Error carrying the HAP status
HomeKit receives, with a sentence naming the request and the status.

HAP's request paths reject with the bare status number, their internal contract with HAP's accessory server. What a suite asserts is the status HomeKit sees,
which this error carries as `hapStatus`, the field HAP's own `HapStatusError` carries too and the one [hapStatus](#hapstatus-1) reads. A refusal HAP's request path
produced carries HAP's own rejection as its `cause`.

HAP answers a handler fault, a throw of an error it does not recognize or a value it cannot accept, with `HAPStatus.SERVICE_COMMUNICATION_FAILURE`, the status a
deliberate refusal at the default Not Responding status carries too, so the number alone cannot tell a faulted handler from one that refused on purpose.
`handlerFault` tells them apart, and [hapStatus](#hapstatus-1) fails on a refusal that carries it.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new HomeKitRequestError(
   request, 
   status, 
   options?
): HomeKitRequestError;
```

Create the refusal of a read or a write request.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | `"read"` \| `"write"` | The request HomeKit made, a read or a write. |
| `status` | `HAPStatus` | The HAP status the request was refused with. |
| `options?` | `ErrorOptions` & \{ `handlerFault?`: `boolean`; \} | The standard error options, whose `cause` carries the rejection HAP's request path produced, and `handlerFault`, true when HAP reported a handler fault behind the refusal. It defaults to false, a deliberate refusal. |

###### Returns

[`HomeKitRequestError`](#homekitrequesterror)

###### Overrides

`Error.constructor`

#### Properties

| Property | Modifier | Type | Description | Overrides |
| ------ | ------ | ------ | ------ | ------ |
| <a id="handlerfault"></a> `handlerFault` | `public readonly` | `boolean` | True when the refusal carries `HAPStatus.SERVICE_COMMUNICATION_FAILURE` and HAP raised a characteristic warning during the request, which is how HAP reports a handler fault: an `"error-message"` warning for a throw of an error it does not recognize, and a `"warn-message"` one for a value it cannot accept. A deliberate refusal raises none of its own and reads false. The reading has these edges: - The trigger hears every warning on the characteristic while the request runs, so overlapping triggers on one characteristic, or a refusal at that status after HAP warned about something the handler did (an `updateValue` HAP clamps), read as a fault. - A read with no get handler whose stored value HAP cannot accept reads as a fault with no handler involved. - HAP warns, before the handler runs, of a legacy listener it ignores beside a handler of the same kind, a plugin defect, so a refusal beside one reads true at that status only. - A legacy listener calling back with an `Error` is the legacy API's way to report a failure, so it reaches HomeKit at that status, unless its message is a HAP status number, with only a debug line from HAP, and reads as deliberate. | - |
| <a id="hapstatus"></a> `hapStatus` | `public readonly` | `HAPStatus` | The HAP status HomeKit receives for the refused request. | - |
| <a id="name-1"></a> `name` | `public readonly` | `"HomeKitRequestError"` | - | `Error.name` |

***

### TestHomebridgeApi

A Homebridge API double over the runtime [loadHomebridge](#loadhomebridge) resolved, running Homebridge's own API and bridge service behind the API Homebridge hands a
plugin.

`hap` is the runtime's HAP namespace, and `platformAccessory` a subclass of Homebridge's own `PlatformAccessory` whose instances are
[TestPlatformAccessory](#testplatformaccessory) accessories, each listed in `accessories` as it is made. Each API double builds a `HomebridgeAPI` and a `BridgeService` of its own
from the runtime, composed rather than extended, because Homebridge's API carries a `user` whose storage path is the machine's real Homebridge folder. The
accessory calls go through that API, which checks and stamps what it is handed with Homebridge's own refusals and sentences, to that service, which caches,
saves, skips a duplicate with a warning, bridges, unregisters and restores as Homebridge's server does, and each call Homebridge accepted is recorded in `calls`.
Around Homebridge's own code the double adds what a suite needs:

  - The service keeps its accessory cache in a temporary folder of its own, made under the system temp folder and removed when the process exits. A process a
    signal kills, as a runner's timeout or a Ctrl-C kills one, runs no exit listener and leaves its folders there.
  - The service starts with its cache marked loaded, the state Homebridge's startup load of an empty cache leaves, so it saves its cache on every registration,
    update and unregister, as Homebridge's server does.
  - Homebridge's plugin manager is a stand-in that answers every plugin identifier with a plugin answering that identifier and, for a platform name, the platform
    a restore named for it or a platform whose `configureAccessory` does nothing.
  - Nothing publishes on the network: the service's publish listener is removed, so a publish passes the API's checks and stamp, is recorded and goes no further,
    and the external port service the service holds has no `requestPort`, so a publish that reached it would fail rather than take a port.
  - Homebridge's internal logger writes nothing to the console. Each line it logs during one of the double's calls, or during the double's construction, is
    recorded in `serverLog`, and a line it logs outside every call is dropped.

The double is strict. When the outermost of its calls ends as Homebridge ends it, and Homebridge logged a warning or an error during that call or any call nested
inside it, the call throws a [HomebridgeServerWarning](#homebridgeserverwarning) quoting those lines, after Homebridge has finished and after the call is recorded, and so does the
construction. A call made inside another, such as a registration from inside the `configureAccessory` a restore calls, records its lines and returns, so
Homebridge's restore loop runs on as it does under Homebridge, and the outermost call throws them. The throw reaches the code that made the call: a suite's own
call, a suite's `emit` of a lifecycle event whose listener made the call before returning, or plugin code that catches it. A call Homebridge refuses outright,
for an accessory that is not a `PlatformAccessory` or by HAP's refusal at the bridge, throws that refusal unchanged and is not recorded, and a line Homebridge
logged before the refusal stays in `serverLog`.

The double also holds every warn and error line Homebridge logged on it until a test takes it, so a warning plugin code caught still fails the test that drew
it. [TestHomebridgeApi.takeServerWarnings](#takeserverwarnings) takes the lines, and [assertNoServerWarnings](#assertnoserverwarnings) fails the test when any is left, called by
[watchServerWarnings](#watchserverwarnings) for every API double a suite builds through it after each test, once the test's own cleanups have run. The strict throw takes
nothing, because the double cannot tell a suite's `assert.throws` from a plugin's `catch`, so a test that expects Homebridge to warn takes the lines it expects.
The same check reads the warnings every accessory made through `platformAccessory` records, and [assertNoServerWarnings](#assertnoserverwarnings) describes which of them fail it
and how a test takes the ones it expects.

The calls accept any `PlatformAccessory`, as Homebridge's do, but only an accessory made through `platformAccessory` records its changes and warnings, so one
built from Homebridge's class directly records nothing.

An accessory stays off the bridge until it is registered or restored, as under Homebridge, and
[AccessoryPersistence](../accessory-persistence.md#accessorypersistence) saves and unregisters only accessories the bridge holds, so a suite registers or restores
an accessory before it expects the helper to save it. The helper gathers its saves into a window, so a suite counting the `update` entries in `calls` first steps
its `TestClock` by [ACCESSORY\_SAVE\_WINDOW\_MS](../accessory-persistence.md#accessory_save_window_ms) or calls the helper's `flush()`.

The class is an `EventEmitter`, as Homebridge's API is, so a plugin subscribes to `didFinishLaunching` and `shutdown` on it and a suite emits them. A suite
injects a failure into an accessory call with `t.mock.method` on the instance.

#### Example

```ts
import { loadHomebridge, triggerSet, watchServerWarnings } from "homebridge-plugin-utils/testing";

// The builder makes each API double and checks it after every test, so a warning plugin code caught fails the test that drew it.
const setup = watchServerWarnings(await loadHomebridge(import.meta.url));
const api = setup();
const accessory = new api.platformAccessory("Porch Light", api.hap.uuid.generate("porch-light"));
const on = accessory.addService(api.hap.Service.Lightbulb, "Porch Light").getCharacteristic(api.hap.Characteristic.On);

api.registerPlatformAccessories("homebridge-example", "Example", [accessory]);

await triggerSet(on, true);

// One entry, the write HomeKit asked for, whether or not the accessory is bridged.
accessory.changesTo(api.hap.Characteristic.On);
```

#### Extends

- `EventEmitter`

#### Implements

- `Pick`\<`API`, 
  \| `"hap"`
  \| `"platformAccessory"`
  \| `"publishExternalAccessories"`
  \| `"registerPlatformAccessories"`
  \| `"unregisterPlatformAccessories"`
  \| `"updatePlatformAccessories"`\>

#### Constructors

##### Constructor

```ts
new TestHomebridgeApi(runtime): TestHomebridgeApi;
```

Create an API double over a runtime [loadHomebridge](#loadhomebridge) resolved.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `runtime` | [`HomebridgeRuntime`](#homebridgeruntime) | The HAP namespace and the classes the double runs on. |

###### Returns

[`TestHomebridgeApi`](#testhomebridgeapi)

###### Overrides

`EventEmitter.constructor`

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="accessories"></a> `accessories` | `public readonly` | [`TestPlatformAccessory`](#testplatformaccessory)\<`UnknownContext`\>[] | `[]` | Every accessory made through [TestHomebridgeApi.platformAccessory](#platformaccessory), in the order it was made. |
| <a id="calls"></a> `calls` | `public readonly` | [`TestHomebridgeApiCall`](#testhomebridgeapicall)[] | `[]` | Every accessory call a plugin made on this API and Homebridge accepted, in arrival order, each tagged by `kind`. A call is recorded once Homebridge has handled it and before a warning Homebridge logged during it throws, so a call Homebridge refuses outright, for an accessory that is not a `PlatformAccessory` or by HAP's refusal at the bridge, throws that refusal and records nothing. A restore is Homebridge's act rather than the plugin's, so it records nothing. |
| <a id="hap"></a> `hap` | `public readonly` | `__module` | `undefined` | The runtime's HAP namespace, the one a plugin reaches as `api.hap`. |
| <a id="platformaccessory"></a> `platformAccessory` | `public readonly` | [`TestPlatformAccessoryConstructor`](#testplatformaccessoryconstructor) | `undefined` | Homebridge's `PlatformAccessory`, extended so that each accessory it makes records its changes and warnings and joins [TestHomebridgeApi.accessories](#accessories). It is generic over the context as Homebridge's own class is, so `new api.platformAccessory<Context>(...)` types the accessory's context. |

#### Accessors

##### serverLog

###### Get Signature

```ts
get serverLog(): readonly HomebridgeServerLogLine[];
```

Every line Homebridge's server logged during this API's calls and its construction, in the order it logged them, each with Homebridge's level and its message
as Homebridge would print it, without its timestamp or colors. A line lands in the log of the API whose call logged it, so a call nested inside one of this
API's calls on another API double leaves its lines in that API's log. A debug line is kept only while Homebridge's debug is on, as Homebridge prints one only
then, and a line Homebridge logs outside every call of the double is dropped.

A characteristic warning an accessory raises during a call reaches this log through the printer Homebridge attaches to each accessory it registers or restores,
which logs a `"warn-message"` warning at info, an `"error-message"` warning at error, and a `"debug-message"` warning and a warning's stack at debug, so of
those only an `"error-message"` warning throws. The printer logs a slow read or write at info and a timeout at error as well, but HAP reports each from a timer
while a controller's request is out, and reports a warning an async handler raises once the handler's promise settles, so none of those lands inside a call.
A warning raised outside every call, such as one a trigger draws, is dropped here and still recorded in the accessory's `warnings`.

An `"error-message"` warning raised inside a call on an accessory Homebridge registered or restored is therefore held twice, as this log's line and in the
accessory's `warnings`, and a test that expects it takes the line and the warning. [assertNoServerWarnings](#assertnoserverwarnings) describes which warnings fail the check
after each test, and how a test takes the ones it expects.

The log is read-only to a suite, because [TestHomebridgeApi.takeServerWarnings](#takeserverwarnings) holds its warnings by their place in it, and a log a suite shortened
would leave the warnings Homebridge logged after it unheld.

###### Returns

readonly [`HomebridgeServerLogLine`](#homebridgeserverlogline)[]

#### Methods

##### publishExternalAccessories()

```ts
publishExternalAccessories(pluginIdentifier, accessories): void;
```

Publish accessories outside the bridge through Homebridge's API, which checks each accessory and stamps it with the plugin identifier, logging at info when the
identifier is not a qualified plugin name, and the call is recorded. The service's publish listener is removed, so nothing is bridged, cached or advertised.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `pluginIdentifier` | `string` | The plugin's identifier. |
| `accessories` | `PlatformAccessory`\<`UnknownContext`\>[] | The accessories to publish. |

###### Returns

`void`

###### Implementation of

`Pick.publishExternalAccessories`

##### registerPlatformAccessories()

```ts
registerPlatformAccessories(
   pluginIdentifier, 
   platformName, 
   accessories
): void;
```

Register accessories through Homebridge's API and bridge service: the API checks each accessory and stamps it with the plugin identifier and platform name,
and the service skips, with a warning, each accessory whose UUID it already caches or bridges, caches and bridges the rest, and saves its cache.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `pluginIdentifier` | `string` | The plugin's identifier. |
| `platformName` | `string` | The platform the accessories belong to. |
| `accessories` | `PlatformAccessory`\<`UnknownContext`\>[] | The accessories to register. |

###### Returns

`void`

###### Implementation of

`Pick.registerPlatformAccessories`

##### restorePlatformAccessories()

```ts
restorePlatformAccessories(options): void;
```

Restore cached accessories, as Homebridge's server does at startup, through Homebridge's own restore loop. Each accessory of the batch is stamped with the plugin
identifier and platform name, as the cache Homebridge loads holds it, the platform becomes the active platform of the platform name, and the service's cache
holds the batch alone while the loop runs. For each accessory of the batch the cache still holds when its turn comes, by identity, Homebridge writes its
FirmwareRevision placeholder of `"0"` through `setCharacteristic`, hands the accessory to the platform's `configureAccessory`, and bridges it once that call
returns, so an accessory an earlier `configureAccessory` unregistered, or swapped for a new instance of its UUID through an update, is skipped. An accessory
HAP refuses to bridge has been configured already, and Homebridge warns, orphans it out of the cache and restores the rest, so the restore throws that warning
once the loop ends. However the loop ends, the accessories the cache held before the restore, less the batch, then return to the cache ahead of what the loop
left there.

A call made from inside `configureAccessory` acts on a cache holding the batch alone, as Homebridge's own cache holds its restored accessories and nothing a
plugin registered since: a registration of a UUID an accessory of the batch carries is skipped as a duplicate, an unregister leaves an accessory outside the
batch cached, an update leaves an accessory outside the batch that shares a UUID with one it is handed cached beside it, and a save writes the batch alone.

The platform sees the placeholder, which a revision it writes replaces, on an accessory not yet on the bridge, and HAP raises a change for the placeholder's
write, so `changes` records it. Homebridge restores accessories without the plugin asking, so no call is recorded.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`TestHomebridgeRestoreOptions`](#testhomebridgerestoreoptions) | The accessories, the platform that configures them, and the plugin identifier and platform name. See [TestHomebridgeRestoreOptions](#testhomebridgerestoreoptions). |

###### Returns

`void`

##### takeServerWarnings()

```ts
takeServerWarnings(): readonly HomebridgeServerLogLine[];
```

Take the warnings this API holds: the warn and error lines of [TestHomebridgeApi.serverLog](#serverlog) logged since the last take, in the order Homebridge logged
them.

The held set is no list of its own. It is the part of `serverLog` past a cursor, which each take moves to the log's end, so a second take answers only what
Homebridge logged since the first, and `serverLog` itself keeps every line. A line a call nested on another API double logged is held by that API, whose log
holds it. A strict throw takes nothing: a [HomebridgeServerWarning](#homebridgeserverwarning) reaches whatever code made the call, and the double cannot tell a suite's
`assert.throws` from a plugin's `catch`, so a test that expects Homebridge to warn takes the lines itself, and [assertNoServerWarnings](#assertnoserverwarnings) fails a test
that left any.

###### Returns

readonly [`HomebridgeServerLogLine`](#homebridgeserverlogline)[]

The warn and error lines logged since the last take, none of which a later take answers again.

##### unregisterPlatformAccessories()

```ts
unregisterPlatformAccessories(
   pluginIdentifier, 
   platformName, 
   accessories
): void;
```

Unregister accessories through Homebridge's API and bridge service: the API checks each accessory, and the service removes each from its cache by identity
and from the bridge, and saves its cache. HAP refuses to remove an accessory the bridge does not hold, and that refusal reaches the caller, as it does from
Homebridge, with the cache already updated and no call recorded. The bridge's removal strips the accessory of every listener, as it does under Homebridge,
and the double hears the accessory's warnings again afterward.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `pluginIdentifier` | `string` | The plugin's identifier. |
| `platformName` | `string` | The platform the accessories belong to. |
| `accessories` | `PlatformAccessory`\<`UnknownContext`\>[] | The accessories to unregister. |

###### Returns

`void`

###### Implementation of

`Pick.unregisterPlatformAccessories`

##### updatePlatformAccessories()

```ts
updatePlatformAccessories(accessories): void;
```

Save accessories through Homebridge's API and bridge service: the service puts the accessories it is handed in place of every cached accessory sharing a UUID
with one of them, caches the rest, registered or not, and saves its cache, and the call is recorded.

Homebridge's save writes an accessory only once a registration or a restore has stamped it with its plugin and platform, and it writes the whole cache, so an
update of an accessory never registered or restored leaves one in the cache that no save can write, as it does under Homebridge: that update, and every call
that saves while that accessory stays cached, logs Homebridge's error and throws.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessories` | `PlatformAccessory`\<`UnknownContext`\>[] | The accessories to save. |

###### Returns

`void`

###### Implementation of

`Pick.updatePlatformAccessories`

***

### HomebridgeBridgeService

The part of Homebridge's bridge service that [TestHomebridgeApi](#testhomebridgeapi) reaches on the `BridgeService` it builds: the accessory cache, the mark its save checks,
and its restore loop. Homebridge's declaration keeps the cache and the mark private, so no compile-time check reaches them, and the double's own suite is what
fails when a release renames one of them.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="cachedaccessoriesfileloaded"></a> `cachedAccessoriesFileLoaded` | `boolean` | Whether the service has tried to load its accessory cache from disk, which its save checks before it writes, so a cache never loaded is never overwritten. |
| <a id="cachedplatformaccessories"></a> `cachedPlatformAccessories` | `PlatformAccessory`\<`UnknownContext`\>[] | The accessory cache: what a registration skips as a duplicate, what a save writes, and what the restore loop restores. |

#### Methods

##### restoreCachedPlatformAccessories()

```ts
restoreCachedPlatformAccessories(): void;
```

Restore every accessory the cache holds, as Homebridge's server does at startup.

###### Returns

`void`

***

### HomebridgeLoggerClass

The part of Homebridge's `Logger` class that [TestHomebridgeApi](#testhomebridgeapi) reaches: the internal logger Homebridge's API and bridge service log through, and whether
Homebridge prints debug lines, which `Logger.setDebugEnabled` turns on. Homebridge's declaration keeps the debug flag private, so no compile-time check reaches it.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="debugenabled"></a> `debugEnabled` | `readonly` | `boolean` | Whether Homebridge prints its debug lines. |
| <a id="internal"></a> `internal` | `readonly` | `Logger` | Homebridge's internal logger, one for each Homebridge copy. |

***

### HomebridgePluginManager

The part of Homebridge's plugin manager a bridge service reaches, which [TestHomebridgeApi](#testhomebridgeapi) hands its bridge service a stand-in for: the plugin an
accessory is stamped with, answering its identifier, which Homebridge's characteristic warning printer names, and the active platform of a name, which
Homebridge's restore loop hands each accessory to.

#### Methods

##### getPlugin()

```ts
getPlugin(pluginIdentifier): {
  getActiveDynamicPlatform(platformName): Pick<DynamicPlatformPlugin, "configureAccessory">;
  getPluginIdentifier(): string;
};
```

Answer the plugin of an identifier.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `pluginIdentifier` | `string` | The identifier an accessory is stamped with. |

###### Returns

```ts
{
  getActiveDynamicPlatform(platformName): Pick<DynamicPlatformPlugin, "configureAccessory">;
  getPluginIdentifier(): string;
}
```

The plugin, answering its identifier and the active platform of a platform name.

| Name | Type |
| ------ | ------ |
| `getActiveDynamicPlatform()` | (`platformName`) => `Pick`\<`DynamicPlatformPlugin`, `"configureAccessory"`\> |
| `getPluginIdentifier()` | () => `string` |

***

### HomebridgeRuntime

What [loadHomebridge](#loadhomebridge) resolves from a caller's tree: the HAP namespace and the classes Homebridge itself loads there.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="bridgeservice"></a> `BridgeService` | `readonly` | [`HomebridgeBridgeServiceClass`](#homebridgebridgeserviceclass) | Homebridge's own `BridgeService` class, loaded from Homebridge's directory: the server half that caches, saves, bridges and restores a plugin's accessories, which [TestHomebridgeApi](#testhomebridgeapi) builds one of for each API double. |
| <a id="hap-1"></a> `hap` | `readonly` | `__module` | The hap-nodejs namespace Homebridge loads, the same one a plugin reaches as `api.hap`. |
| <a id="homebridgeapi"></a> `HomebridgeAPI` | `readonly` | [`HomebridgeApiClass`](#homebridgeapiclass) | Homebridge's own `HomebridgeAPI` class, loaded from Homebridge's directory: the API Homebridge hands a plugin, whose accessory calls check and stamp what they are handed before its bridge service handles them. |
| <a id="logger"></a> `Logger` | `readonly` | [`HomebridgeLoggerClass`](#homebridgeloggerclass) | Homebridge's own `Logger` class, loaded from Homebridge's directory, whose internal logger Homebridge's API and bridge service log through. |
| <a id="platformaccessory-1"></a> `PlatformAccessory` | `readonly` | *typeof* `PlatformAccessory` | Homebridge's own `PlatformAccessory` class, loaded from Homebridge's directory, whose accessories wrap accessories of [HomebridgeRuntime.hap](#hap-1). |

***

### HomebridgeServerApi

The part of Homebridge's API that [TestHomebridgeApi](#testhomebridgeapi) reaches on the `HomebridgeAPI` it builds: the accessory calls a plugin makes, each checking and
stamping what it is handed before Homebridge's bridge service handles it, and the removal of an event's listeners. Homebridge's index exports no type for the
class, so this lists only what the double touches.

#### Extends

- `Pick`\<`API`, 
  \| `"publishExternalAccessories"`
  \| `"registerPlatformAccessories"`
  \| `"unregisterPlatformAccessories"`
  \| `"updatePlatformAccessories"`\>

#### Methods

##### removeAllListeners()

```ts
removeAllListeners(event): this;
```

Remove every listener of an event, as Node's `EventEmitter` does, which takes the bridge service's publish listener off.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `event` | `string` | The event whose listeners to remove. |

###### Returns

`this`

The API.

***

### HomebridgeServerLogLine

One line of [TestHomebridgeApi.serverLog](#serverlog): a line Homebridge's server logged, with Homebridge's level and its message as Homebridge would print it, without
its timestamp or colors.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="level"></a> `level` | `readonly` | `"debug"` \| `"error"` \| `"warn"` \| `"info"` \| `"success"` | The level Homebridge logged the line at. |
| <a id="message"></a> `message` | `readonly` | `string` | The line as Homebridge formats it, its parameters substituted and its escape codes stripped. |

***

### TestHomebridgeRestoreOptions

What [TestHomebridgeApi.restorePlatformAccessories](#restoreplatformaccessories) restores: the cached accessories, the platform Homebridge hands each one to, and the plugin identifier
and platform name it stamps on them.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="accessories-1"></a> `accessories` | `readonly` | readonly `PlatformAccessory`\<`UnknownContext`\>[] | The cached accessories to restore, in the order Homebridge restores them. |
| <a id="platform"></a> `platform` | `readonly` | `Pick`\<`DynamicPlatformPlugin`, `"configureAccessory"`\> | The platform whose `configureAccessory` sees each accessory after Homebridge's FirmwareRevision placeholder and before the bridge: the plugin's own platform, or a stand-in when the suite has none. Homebridge finds it as the active platform of the platform name, and does from then on. |
| <a id="platformname"></a> `platformName` | `readonly` | `string` | The platform the accessories belong to. |
| <a id="pluginidentifier"></a> `pluginIdentifier` | `readonly` | `string` | The plugin's identifier. |

***

### TestPlatformAccessory

An accessory made through [TestHomebridgeApi.platformAccessory](#platformaccessory): Homebridge's own `PlatformAccessory`, carrying a record of every value change and
characteristic warning HAP raises on it.

`changes` gains one entry for every change event HAP raises on a service of the accessory, from the moment the service joins it, whether the accessory is
bridged, unregistered or neither. Each entry is HAP's own change with the service it was raised on: the characteristic, the value before and after, HAP's reason
(`"update"`, `"write"`, `"read"` or `"event"`) and the originator, which is the trigger's connection stand-in for a change [triggerGet](#triggerget) or
[triggerSet](#triggerset) raised. HAP raises a change for a write of an unchanged value too, so an unchanged write is recorded, and a read is recorded only when it
changed the value. What HAP writes while it builds the accessory precedes the record, so a new accessory's `changes` starts empty. What a service is given
before it joins precedes the record too, so the name [acquireService](../service.md#acquireservice) writes on a service it creates, before adding it, is not
recorded.

`warnings` gains one entry for every characteristic warning the accessory raises, stored as it read when it was raised, its originator chain copied, so a
bridge that rewrites the chain afterward changes nothing recorded. Capturing a warning keeps HAP from printing it, so a suite's console stays quiet.
[assertNoServerWarnings](#assertnoserverwarnings) describes which recorded warnings fail the check after each test, and how a test takes the ones it expects.

#### Extends

- `PlatformAccessory`\<`T`\>

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-t"></a> `T` *extends* `UnknownContext` | `UnknownContext` | The accessory's context type, as Homebridge's own class declares it. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="changes"></a> `changes` | `readonly` | readonly `AccessoryCharacteristicChange`[] | Every value change HAP raised on the accessory's services, in the order HAP raised them. |
| <a id="warnings"></a> `warnings` | `readonly` | readonly `CharacteristicWarning`[] | Every characteristic warning the accessory raised since the last take or clear, in the order it raised them. A suite filters them by kind through [CharacteristicWarningType](../homebridge-enums.md#characteristicwarningtype). [assertNoServerWarnings](#assertnoserverwarnings) reads this record after each test, and describes which warnings in it fail the check and how a test takes the ones it expects. |

#### Methods

##### changesOn()

```ts
changesOn(service, ...characteristics): AccessoryCharacteristicChange[];
```

The recorded changes HAP raised on one service, in the order HAP raised them, limited to the given characteristics, matched by the characteristic class's `UUID`,
when any are named.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `service` | `Service` | The service whose changes to select, matched by identity. |
| ...`characteristics` | `WithUUID`\<new () => `Characteristic`\>[] | The characteristic classes to select among the service's changes, such as `hap.Characteristic.On`. Naming none selects every change the service raised. |

###### Returns

`AccessoryCharacteristicChange`[]

The matching entries of [TestPlatformAccessory.changes](#changes).

##### changesTo()

```ts
changesTo(...characteristics): AccessoryCharacteristicChange[];
```

The recorded changes to any of the given characteristics, matched by the characteristic class's `UUID`, in the order HAP raised them.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| ...`characteristics` | `WithUUID`\<new () => `Characteristic`\>[] | The characteristic classes to select, such as `hap.Characteristic.On`. |

###### Returns

`AccessoryCharacteristicChange`[]

The matching entries of [TestPlatformAccessory.changes](#changes).

##### clearObservations()

```ts
clearObservations(): void;
```

Empty [TestPlatformAccessory.changes](#changes) and [TestPlatformAccessory.warnings](#warnings), so a suite reads only what follows. The accessory keeps recording.

###### Returns

`void`

##### takeWarnings()

```ts
takeWarnings(): readonly CharacteristicWarning[];
```

Take the warnings the accessory recorded since the last take or clear, emptying [TestPlatformAccessory.warnings](#warnings), so a later take answers only what the
accessory raises after this one. A test that expects HAP to warn takes the warnings it expects here, because [assertNoServerWarnings](#assertnoserverwarnings) takes whatever
the record still holds after the test and fails the test on a warning of a failing kind. The accessory keeps recording.

###### Returns

readonly `CharacteristicWarning`[]

Every warning recorded since the last take or clear, in the order the accessory raised them, none of which a later take answers again.

***

### HomebridgeApiClass

```ts
type HomebridgeApiClass = new () => HomebridgeServerApi;
```

Homebridge's `HomebridgeAPI` class as [HomebridgeRuntime](#homebridgeruntime) carries it: a constructor taking nothing, whose instance a bridge service is built over.

#### Returns

[`HomebridgeServerApi`](#homebridgeserverapi)

***

### HomebridgeBridgeServiceClass

```ts
type HomebridgeBridgeServiceClass = new (api, pluginManager, externalPortService, bridgeOptions, bridgeConfig) => HomebridgeBridgeService;
```

Homebridge's `BridgeService` class as [HomebridgeRuntime](#homebridgeruntime) carries it: a constructor taking the API whose accessory calls the service handles, the plugin
manager it asks for each accessory's plugin, the external port service it asks for a published accessory's port, Homebridge's options with the folder the
service keeps its accessory cache in and the names of the items it writes there, and the configuration of the bridge it builds.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `api` | [`HomebridgeServerApi`](#homebridgeserverapi) |
| `pluginManager` | [`HomebridgePluginManager`](#homebridgepluginmanager) |
| `externalPortService` | `object` |
| `bridgeOptions` | `HomebridgeOptions` & \{ `cachedAccessoriesDir`: `string`; `cachedAccessoriesItemName`: `string`; `externalAccessoriesItemName`: `string`; \} |
| `bridgeConfig` | `BridgeConfiguration` |

#### Returns

[`HomebridgeBridgeService`](#homebridgebridgeservice)

***

### TestHomebridgeApiCall

```ts
type TestHomebridgeApiCall = 
  | {
  accessories: readonly PlatformAccessory[];
  kind: "publish";
  pluginIdentifier: PluginIdentifier;
}
  | {
  accessories: readonly PlatformAccessory[];
  kind: "register" | "unregister";
  platformName: PlatformName;
  pluginIdentifier: PluginIdentifier;
}
  | {
  accessories: readonly PlatformAccessory[];
  kind: "update";
};
```

One entry of [TestHomebridgeApi.calls](#calls): an accessory call a plugin made and Homebridge accepted, tagged by `kind`, carrying a copy of the accessories it
was handed and, where Homebridge's own signature takes them, the plugin identifier and the platform name.

***

### TestPlatformAccessoryConstructor

```ts
type TestPlatformAccessoryConstructor = (new <T>(displayName, uuid, category?) => TestPlatformAccessory<T>) & typeof PlatformAccessory;
```

The class [TestHomebridgeApi.platformAccessory](#platformaccessory) holds: Homebridge's `PlatformAccessory` constructor, generic over the context as Homebridge's own is, whose
instances are [TestPlatformAccessory](#testplatformaccessory) accessories.

***

### assertNoServerWarnings()

```ts
function assertNoServerWarnings(api): void;
```

Fail a test that left untaken a warning Homebridge logged on an API double, or a warning or an error HAP raised on an accessory the double made: take the
lines the API holds through [TestHomebridgeApi.takeServerWarnings](#takeserverwarnings) and the warnings each accessory in [TestHomebridgeApi.accessories](#accessories) recorded
through its [TestPlatformAccessory.takeWarnings](#takewarnings), and when a line was held or a taken warning is of a failing kind, throw an `AssertionError` quoting
each such line and warning.

A suite reaches it through [watchServerWarnings](#watchserverwarnings), which calls it for every API double the suite built through its builder after each test, once that
test's own cleanups have run, so a warning plugin code caught, which the strict throw cannot report, fails the test that drew it. It takes the lines and the
warnings before it fails, so one leak fails one test rather than every test after it, and a line a double logs, or a warning an accessory raises, once its
test has ended, from a timer, fails the next test's check.

An accessory's record holds every warning it raised, registered or not and inside one of the double's calls or outside every call, while the server log holds
a warning only as the line Homebridge's printer logs for an accessory it registered or restored, during a call. The failing kinds are `"warn-message"`,
`"error-message"`, `"timeout-read"` and `"timeout-write"`, which report a defect in the plugin, such as a value HAP refused or corrected, a handler that threw
or a handler that never answered. A slow read or write and a `"debug-message"` warning are taken and pass, because Homebridge treats them as advice: it prints
a slow request at info, and not at all for an accessory published outside the bridge, and a debug message only while its debug is on.

A test that expects a warning takes it, a line through [TestHomebridgeApi.takeServerWarnings](#takeserverwarnings) and a characteristic warning through the accessory's
[TestPlatformAccessory.takeWarnings](#takewarnings). Homebridge's printer logs an `"error-message"` warning at error, so one raised inside a call on an accessory
Homebridge registered or restored is held twice, as the API's line and in the accessory's record, and a test that expects it takes the line and the warning.
An accessory made outside [TestHomebridgeApi.platformAccessory](#platformaccessory), from Homebridge's class directly, has no record, so the check cannot see its warnings
beyond the error lines Homebridge's printer logs for it during a call.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `api` | [`TestHomebridgeApi`](#testhomebridgeapi) | The API double whose held lines, and whose accessories' recorded warnings, to take. |

#### Returns

`void`

#### Throws

`AssertionError` quoting each warn and error line the API held and each warning of a failing kind its accessories recorded.

#### Example

```ts
import { loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";

// Every API double the file builds through setup is handed to assertNoServerWarnings after each test, once that test's own cleanups have run.
const setup = watchServerWarnings(await loadHomebridge(import.meta.url));
```

***

### hapStatus()

```ts
function hapStatus(status): (rejection) => boolean;
```

Build a validation function for `assert.rejects` or `assert.throws` that asserts the rejection is an Error carrying the given HAP status as its `hapStatus`, and
returns true. It reads the [HomeKitRequestError](#homekitrequesterror) that [triggerGet](#triggerget) and [triggerSet](#triggerset) reject with and the `HapStatusError` a wrapped handler
called directly throws alike, because each carries the status in that field.

A refusal marked a [handler fault](#handlerfault) fails before its status is compared, because a faulted handler reaches HomeKit with
the same status a deliberate Not Responding refusal carries, and passing it would let a fault stand in for the refusal a suite asserts.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `status` | `HAPStatus` | The status the rejection must carry. |

#### Returns

A validation function that asserts the rejection is a deliberate refusal carrying `status` and returns true.

(`rejection`) => `boolean`

#### Example

```ts
await assert.rejects(triggerGet(characteristic), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
```

***

### hasGetHandler()

```ts
function hasGetHandler(characteristic): boolean;
```

Answer whether HAP's read path has plugin code to call on a characteristic: an `onGet` handler, or, without one, a legacy `get` listener, which HAP's read path
falls back to.

HAP keeps the `onGet` handler in its `getHandler` field, which its declaration marks private, so one kit function reads the field rather than each suite reaching
into HAP itself, and a HAP release that renames it fails HBPU's own suite rather than a sibling's silently. A read HAP refuses before it reaches plugin code, of
a characteristic without the paired-read permission, is [triggerGet](#triggerget)'s to report.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `characteristic` | `Characteristic` | The characteristic to inspect. |

#### Returns

`boolean`

True when the characteristic carries an `onGet` handler or a legacy `get` listener.

***

### hasSetHandler()

```ts
function hasSetHandler(characteristic): boolean;
```

Answer whether HAP's write path has plugin code to call on a characteristic: an `onSet` handler, or, without one, a legacy `set` listener, which HAP's write path
falls back to.

HAP keeps the `onSet` handler in its `setHandler` field, which its declaration marks private, so one kit function reads the field rather than each suite reaching
into HAP itself, and a HAP release that renames it fails HBPU's own suite rather than a sibling's silently. A write refused before it reaches plugin code, of a
characteristic without the paired-write permission or of an invalid value, is [triggerSet](#triggerset)'s to report.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `characteristic` | `Characteristic` | The characteristic to inspect. |

#### Returns

`boolean`

True when the characteristic carries an `onSet` handler or a legacy `set` listener.

***

### loadHomebridge()

```ts
function loadHomebridge(from): Promise<HomebridgeRuntime>;
```

Resolve Homebridge from a caller's tree and load the hap-nodejs copy and the classes Homebridge itself runs there: `PlatformAccessory`, `HomebridgeAPI`,
`BridgeService` and `Logger`.

Homebridge is resolved from `from` the way a `require` there would resolve it, hap-nodejs is required from Homebridge's resolved entry point, and each class is
imported by file URL from the module in the same directory that defines it, `PlatformAccessory` first. A step that fails rejects with an Error naming what it
looked for and where, the original failure as its `cause`, and so does a module that loads without its class among its exports.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `from` | `string` \| `URL` | Where to resolve Homebridge from: the calling module's `import.meta.url`, or any file URL or absolute file path inside the tree the suite runs in. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`HomebridgeRuntime`](#homebridgeruntime)\>

The HAP namespace and the classes Homebridge loads from that tree.

#### Example

```ts
import { loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";

// Every API double the file builds over the runtime through setup is checked after each test, once that test's own cleanups have run.
const runtime = await loadHomebridge(import.meta.url);
const setup = watchServerWarnings(runtime);
const api = setup();
```

***

### triggerGet()

```ts
function triggerGet(characteristic): Promise<Nullable<CharacteristicValue>>;
```

Read a characteristic the way a HomeKit controller's read request does, through HAP's own read path: HAP refuses a characteristic without the paired-read
permission, runs the get handler, and maps a handler's failure to a status: a non-HAP error, or a value HAP cannot accept, becomes
`HAPStatus.SERVICE_COMMUNICATION_FAILURE` with a warning, which marks the refusal a [handler fault](#handlerfault). A characteristic
without a handler answers its stored value, or the status a stored error left, and a stored value HAP cannot accept is refused the same way, a handler fault
with no handler involved.

The read goes straight to the characteristic, so it leaves out the refusal HAP's accessory read path makes for the controller before the characteristic sees
the read: an admin-only read from a controller without admin rights, refused with `HAPStatus.INSUFFICIENT_PRIVILEGES`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `characteristic` | `Characteristic` | The characteristic to read. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Nullable`\<`CharacteristicValue`\>\>

The value HAP answers. A refusal rejects with a [HomeKitRequestError](#homekitrequesterror) carrying HAP's status, which [hapStatus](#hapstatus-1) matches.

***

### triggerSet()

```ts
function triggerSet(characteristic, value): Promise<void | CharacteristicValue>;
```

Write a characteristic the way a HomeKit controller's write request does: a characteristic without the paired-write permission is refused with
`HAPStatus.READ_ONLY_CHARACTERISTIC`, as HAP's accessory write path refuses it, and any other write goes through HAP's own write path, which validates the value
as it validates a controller's, refusing an invalid one with `HAPStatus.INVALID_VALUE_IN_REQUEST`, and runs the set handler. A set handler's non-HAP error
becomes `HAPStatus.SERVICE_COMMUNICATION_FAILURE` with a warning, which marks the refusal a [handler fault](#handlerfault).

Of the refusals HAP's accessory write path makes for the controller before the characteristic sees the write, the trigger mirrors the paired-write check alone,
and leaves out the rest: an admin-only write from a controller without admin rights (`HAPStatus.INSUFFICIENT_PRIVILEGES`), a refusal from the
characteristic's own additional-authorization handler (`HAPStatus.INSUFFICIENT_AUTHORIZATION`), and a timed write that was never prepared or whose preparation
expired (`HAPStatus.INVALID_VALUE_IN_REQUEST`).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `characteristic` | `Characteristic` | The characteristic to write. |
| `value` | `CharacteristicValue` | The value HomeKit writes. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void` \| `CharacteristicValue`\>

The write response HAP answers, if any. A refusal rejects with a [HomeKitRequestError](#homekitrequesterror) carrying HAP's status, which [hapStatus](#hapstatus-1) matches.

***

### watchServerWarnings()

```ts
function watchServerWarnings(runtime): () => TestHomebridgeApi;
```

Build a `node:test` file's API doubles over a runtime, and after each test check every one of them for a warning Homebridge logged on it, or a warning or an
error HAP raised on an accessory it made, that the test left untaken. Called once at the file's top level, it registers one after-each hook and answers the
builder the file makes its API doubles through, each over `runtime`.

The hook adds the check to the finished test's own cleanups rather than running it itself, because `node:test` runs a file's after-each hooks before a test's
own `t.after` cleanups: a check made in the hook would read each double before the test's teardown ran, and a warning plugin code caught during that teardown,
such as in a shutdown the teardown emits, would go unchecked. A cleanup added from the hook runs after every cleanup the test registered, its body's late ones
included, and fails that test.

The check hands every double the builder has made to [assertNoServerWarnings](#assertnoserverwarnings), which takes each one's lines and its accessories' warnings, and only then
fails: a lone failure is thrown as it is, and several as one `AggregateError` holding each, so a second leaking double never leaves its lines or warnings for
the next test. The aggregate's own message quotes each failure's message, because a reporter that prints only a failure's message, as the TAP reporter does,
would otherwise show none of the lines and warnings the aggregate holds. One builder serves a double a test builds for itself and one the file builds once and
shares alike, because it holds every double it made until the file ends and checks each after every test, and each double's held set and each accessory's
record answer only what was logged or raised since the last check. Holding every double is what makes a late line's report deterministic, where a weakly held
one would be reported or not depending on when the garbage collector ran.

[assertNoServerWarnings](#assertnoserverwarnings) describes what fails the check, and how a test takes the lines and warnings it expects.

A file calls it once, at its top level: called inside a `describe`, the hook covers that describe's tests alone, and in a file that calls it twice, the second
builder's check, a cleanup of its own, does not run in a test whose first check failed, leaving that builder's lines and warnings to the next test. The check's
reach has these edges:

  - A line any double the builder made logs, or a warning one of its accessories raises, after its test has ended, from a timer, fails the next test's check,
    and one logged or raised after the file's last test goes unchecked.
  - `node:test` runs no cleanup after one that throws, so a cleanup that throws leaves its test's lines and warnings to the next test, and so does a cleanup
    registered from inside another, which runs after the check.
  - The hook runs after a subtest too, so the check runs over the parent test's doubles while the parent is still running, and a line or a warning the parent
    has not yet taken fails the subtest.
  - A test that leaks and then skips itself or marks itself todo at runtime has its lines and warnings taken and no failure counted, because `node:test`
    counts no failure in a skipped or todo test, the check's included.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `runtime` | [`HomebridgeRuntime`](#homebridgeruntime) | The runtime [loadHomebridge](#loadhomebridge) resolved, which every API double the builder makes runs on. |

#### Returns

A builder that makes an API double over `runtime` and holds it for the check after each test.

() => [`TestHomebridgeApi`](#testhomebridgeapi)

#### Example

```ts
import { loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";
import { test } from "node:test";

// Every API double the file builds through setup is checked after each test, once that test's own cleanups have run.
const setup = watchServerWarnings(await loadHomebridge(import.meta.url));

test("registers the porch light", () => {

  const api = setup();

  api.registerPlatformAccessories("homebridge-example", "Example", [new api.platformAccessory("Porch Light", api.hap.uuid.generate("porch-light"))]);
});
```
