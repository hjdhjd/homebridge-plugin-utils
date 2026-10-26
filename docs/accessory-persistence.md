[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / accessory-persistence

# accessory-persistence

Batched saves of a plugin's changed accessories to the Homebridge accessory cache.

Homebridge restores a platform's accessories from its accessory cache at every start, so the cache decides what a plugin begins with: the services each accessory
carries and the settings its context records. Homebridge writes the cache when a plugin registers, updates, or unregisters accessories, and once more as it shuts
down cleanly. It never writes it because a service was added or removed or a context field changed, so until something writes the cache, a change lives only in
memory...a process that ends without a clean shutdown loses it, and at the next start a service an option removed comes back and a setting the user toggled
reverts. Each write has a cost of its own: it serializes every accessory the bridge caches and writes the whole file synchronously, however few accessories the
call names.

[AccessoryPersistence](#accessorypersistence) is where a plugin reports those changes. The plugin marks an accessory at the point it changes it, and every accessory marked within a
short window is saved in one update, so a change reaches disk within a second, and a startup pass that configures every device, or a burst of toggles, costs one
cache write rather than one per change.

## Accessory

### AccessoryPersistence

Batched saves of a plugin's changed accessories to the Homebridge accessory cache. A platform creates one, and reports through it every change to what the cache
holds.

The surface is minimal on purpose:

  - `persist(accessory, changes?)` marks an accessory changed and opens the save window if none is open. Every accessory marked before the window closes is saved with
    it, once however often it was marked, and the window stays where the first mark opened it, so a steady stream of marks cannot hold a save off. `changes` are
    merged into the accessory's context first. The call itself is the report of a change, so every call marks, and the helper never second-guesses it by comparing
    values: an object the plugin edited in place and handed back holds the same reference it always did, yet its contents still need saving.
  - `unregister(accessories)` drops any pending save for the accessories and then unregisters them from Homebridge. Homebridge puts every accessory an update names
    back into its cache, registered or not, so a save that reached it after the removal would bring the accessory back at the next start.
  - `flush()` saves whatever is waiting immediately and closes the window. With nothing waiting on the bridge, it makes no call.

Homebridge is handed only accessories its bridge holds, so a plugin marks and removes every accessory it owns without asking where each one lives. An accessory the
plugin published outside the bridge has no entry in the cache: Homebridge adds anything an update names to its cache, and an external accessory there cannot be
serialized, which fails every later cache write for the rest of the run, the one at shutdown included. Homebridge also refuses to unregister one, throwing for an
accessory its bridge never held. The other accessories off the bridge are kept out for their own reasons: a new accessory is written by its registration, and a
removed one must stay out of the cache, so a mark that arrives after its removal is left out of the save as well.

The helper listens only for Homebridge's shutdown, which saves whatever is waiting. A mark that arrives after shutdown is saved at once rather than opening a window,
because Homebridge keeps accepting saves while its plugins wind down but a process on its way out gives a timer no time to come due. The helper's place among the
plugin's own shutdown listeners therefore never matters: a change made before the shutdown save goes out with it, and one made after is saved on its own.

Nothing else tells the helper a change happened, by design. The plugin marks wherever it changes what the cache holds: where a service gate,
[acquireService](service.md#acquireservice) or [validService](service.md#validservice), or a characteristic gate,
[validCharacteristic](service.md#validcharacteristic) or [updatePresenceCharacteristic](service.md#updatepresencecharacteristic), answers a transition
[presenceChanged](service.md#presencechanged) reads as a change, where a name helper, [setAccessoryName](service.md#setaccessoryname) or
[setServiceName](service.md#setservicename), answers true, and where it writes a setting into an accessory's context. Live device state, a motion or
contact reading, belongs on characteristics, which the device reports again after a restart, so it never passes through here.

#### Example

```ts
// Once, in the platform's constructor.
this.persistence = new AccessoryPersistence({ api, platformName: PLATFORM_NAME, pluginIdentifier: PLUGIN_NAME });

// A service wrapper saw a service attached or removed.
const { transition } = validService({ accessory, name, serviceType, validate });

if(presenceChanged(transition)) {

  this.platform.persistence.persist(accessory);
}

// A user's setting is written into the context and saved in one call.
this.platform.persistence.persist(accessory, { doorbellMuted: true });

// A removal drops any pending save before Homebridge lets the accessory go.
this.platform.persistence.unregister([accessory]);
```

#### Constructors

##### Constructor

```ts
new AccessoryPersistence(options): AccessoryPersistence;
```

Create the helper and subscribe it to Homebridge's shutdown, which saves whatever is still waiting. Construction arms no timer; the first mark opens the first
window.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`AccessoryPersistenceOptions`](#accessorypersistenceoptions) | The Homebridge API, the plugin's identifier and platform name, and an optional clock. See [AccessoryPersistenceOptions](#accessorypersistenceoptions). |

###### Returns

[`AccessoryPersistence`](#accessorypersistence)

#### Methods

##### flush()

```ts
flush(): void;
```

Save every accessory waiting for the window immediately, in one update, and close the window. With nothing waiting on the bridge, this makes no call.

###### Returns

`void`

##### persist()

```ts
persist<C>(accessory, changes?): void;
```

Mark an accessory changed so the save window carries it, first merging `changes` into its context when given. Call it wherever the plugin changes what the cache
holds for the accessory, at each place the [AccessoryPersistence](#accessorypersistence) class documentation names.

###### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| <a id="type-parameter-c"></a> `C` *extends* `UnknownContext` | The accessory's context type, inferred from `accessory` alone, so `changes` is checked against the fields the plugin declares for it. |

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory`\<`C`\> | The accessory whose cached state changed. |
| `changes?` | `NoInfer`\<`Partial`\<`C`\>\> | Context fields to set before the accessory is marked. |

###### Returns

`void`

##### unregister()

```ts
unregister(accessories): void;
```

Unregister accessories from Homebridge, dropping any pending save for them first, so no save can return them to the cache. A plugin removes accessories through
this rather than through the API directly. Only the accessories the bridge holds are handed to Homebridge, and with none there is no call; removing an accessory
published outside the bridge from HomeKit is the user's act in the Home app.

Remove accessories once Homebridge has finished launching, never from inside `configureAccessory`: Homebridge places a restored accessory on its bridge only after
that call returns, so a removal there is ignored, and the accessory stays cached and joins the bridge as usual.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessories` | `PlatformAccessory`\<`UnknownContext`\>[] | The accessories to unregister. |

###### Returns

`void`

***

### AccessoryPersistenceApi

The part of Homebridge's `API` that [AccessoryPersistence](#accessorypersistence) reaches: the accessory cache's update and unregister calls, and the shutdown event. The `API`
Homebridge hands a plugin satisfies it, and so does the testing entry's `TestHomebridgeApi`, so a suite hands the helper its API double with no cast.

#### Extends

- `Pick`\<`API`, `"unregisterPlatformAccessories"` \| `"updatePlatformAccessories"`\>

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="on"></a> `on` | `readonly` | (`event`, `listener`) => `unknown` | Listen for Homebridge's shutdown, at which the helper saves whatever is still waiting. A property rather than a method, so the compiler compares the listener's parameters strictly: an `API` whose `on` does not accept this event fails to satisfy the interface. |

***

### AccessoryPersistenceOptions

Construction options for [AccessoryPersistence](#accessorypersistence).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="api"></a> `api` | [`AccessoryPersistenceApi`](#accessorypersistenceapi) | The Homebridge API the plugin was handed, typed as the part of it the helper reaches, [AccessoryPersistenceApi](#accessorypersistenceapi). Saves go through its `updatePlatformAccessories`, removals through its `unregisterPlatformAccessories`, and its shutdown event saves whatever is still waiting. |
| <a id="clock"></a> `clock?` | [`Clock`](clock.md#clock) | The time source the save window is armed on. Defaults to [systemClock](clock.md#systemclock); a test injects a `TestClock` so the window comes due on its virtual timeline. |
| <a id="platformname"></a> `platformName` | `string` | The platform name the plugin registers its accessories under, which Homebridge's unregister call takes beside the accessories. |
| <a id="pluginidentifier"></a> `pluginIdentifier` | `string` | The plugin's identifier, its package name, which Homebridge's unregister call takes beside the accessories. |

***

### ACCESSORY\_SAVE\_WINDOW\_MS

```ts
const ACCESSORY_SAVE_WINDOW_MS: 1000 = 1000;
```

How long the save window stays open, in milliseconds: it opens at the first mark after a save and carries every accessory marked before it closes. A second gathers
a startup pass or a burst of toggles into one cache write while keeping short the stretch in which a crash could lose a change, and a clean shutdown saves whatever
is waiting regardless.

A consumer's test reads it to advance its clock by one window rather than restating the number, so the test keeps measuring the window the helper arms.
