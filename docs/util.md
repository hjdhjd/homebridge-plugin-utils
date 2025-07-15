[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / util

# util

TypeScript Utilities.

## Utilities

### HomebridgePluginLogging

Logging interface for Homebridge plugins.

This interface defines the standard logging methods (`debug`, `info`, `warn`, `error`) that plugins should use to output log messages at different severity levels. It
is intended to be compatible with Homebridge's builtin logger and can be implemented by any custom logger used within Homebridge plugins.

#### Example

```ts
function example(log: HomebridgePluginLogging) {

  log.debug("Debug message: %s", "details");
  log.info("Informational message.");
  log.warn("Warning message!");
  log.error("Error message: %s", "problem");
}
```

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="debug"></a> `debug` | (`message`, ...`parameters`) => `void` | Logs a debug-level message. |
| <a id="error"></a> `error` | (`message`, ...`parameters`) => `void` | Logs an error-level message. |
| <a id="info"></a> `info` | (`message`, ...`parameters`) => `void` | Logs an info-level message. |
| <a id="warn"></a> `warn` | (`message`, ...`parameters`) => `void` | Logs a warning-level message. |

***

### DeepPartial\<T\>

```ts
type DeepPartial<T> = { [P in keyof T]?: T[P] extends (infer I)[] ? DeepPartial<I>[] : DeepPartial<T[P]> };
```

A utility type that recursively makes all properties of an object, including nested objects, optional.

This should only be used on JSON objects. If used on classes, class methods will also be marked as optional.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type to make recursively partial. |

#### Remarks

Credit for this type goes to: https://github.com/joonhocho/tsdef.

#### Example

```ts
type Original = {

  id: string;
  nested: { value: number };
};

// All properties, including nested ones, are optional.
type PartialObj = DeepPartial<Original>;

const obj: PartialObj = { nested: {} };
```

***

### DeepReadonly\<T\>

```ts
type DeepReadonly<T> = { readonly [P in keyof T]: T[P] extends (infer I)[] ? DeepReadonly<I>[] : DeepReadonly<T[P]> };
```

A utility type that recursively makes all properties of an object, including nested objects, readonly.

This should only be used on JSON objects. If used on classes, class methods will also be marked as readonly.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type to make recursively readonly. |

#### Remarks

Credit for this type goes to: https://github.com/joonhocho/tsdef.

#### Example

```ts
type Original = {
  id: string;
  nested: { value: number };
};

// All properties, including nested ones, are readonly.
type ReadonlyObj = DeepReadonly<Original>;

const obj: ReadonlyObj = { id: "a", nested: { value: 1 } };
// obj.id = "b"; // Error: cannot assign to readonly property.
```

***

### Nullable\<T\>

```ts
type Nullable<T> = T | null;
```

Utility type that allows a value to be either the given type or `null`.

This type is used to explicitly indicate that a variable, property, or return value may be either a specific type or `null`.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type to make nullable. |

#### Example

```ts
let id: Nullable<string> = null;

// Later...
id = "device-001";
```

***

### PartialWithId\<T, K\>

```ts
type PartialWithId<T, K> = Partial<T> & Pick<T, K>;
```

Makes all properties in `T` optional except for `id`, which remains required.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The base interface or type. |
| `K` *extends* keyof `T` | - |

#### Example

```ts
interface Device {

  id: string;
  name: string;
  mac: string;
}

type UserUpdate = PartialWithId<User>;

// Valid: Only 'id' is required, others are optional.
const update: DeviceUpdate = { id: "123" };

// Valid: Extra properties can be provided.
const another: DeviceUpdate = { id: "456", name: "SomeDevice" };

// Error: 'id' is missing.
const error: DeviceUpdate = { name: "SomeOtherDevice" }; // TypeScript error
```

***

### retry()

```ts
function retry(
   operation, 
   retryInterval, 
totalRetries?): Promise<boolean>;
```

A utility method that retries an operation at a specific interval for up to an absolute total number of retries.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `operation` | () => `Promise`\<`boolean`\> | The operation callback to try until successful. |
| `retryInterval` | `number` | Interval to retry, in milliseconds. |
| `totalRetries?` | `number` | Optionally, specify the total number of retries. |

#### Returns

`Promise`\<`boolean`\>

Returns `true` when the operation is successful, `false` otherwise or if the total number of retries has been exceeded.

#### Remarks

`operation` must be an asynchronous function that returns `true` when successful, and `false` otherwise.

#### Example

```ts
// Example: Retry an async operation up to 5 times, waiting 1 second between each try.
let attempt = 0;
const result = await retry(async () => {

  attempt++;

  // Simulate a 50% chance of success
  return Math.random() > 0.5 || attempt === 5;
}, 1000, 5);

console.log(result); // true if operation succeeded within 5 tries, otherwise false.
```

***

### runWithTimeout()

```ts
function runWithTimeout<T>(promise, timeout): Promise<Nullable<T>>;
```

Run a promise with a guaranteed timeout to complete.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type of value the promise resolves with. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `promise` | `Promise`\<`T`\> | The promise you want to run. |
| `timeout` | `number` | The amount of time, in milliseconds, to wait for the promise to resolve. |

#### Returns

`Promise`\<[`Nullable`](#nullable)\<`T`\>\>

Returns the result of resolving the promise it's been passed if it completes before timeout, or null if the timeout expires.

#### Example

```ts
// Resolves in 100ms, timeout is 500ms, so it resolves to 42.
const result = await runWithTimeout(Promise.resolve(42), 500);
console.log(result); // 42

// Resolves in 1000ms, timeout is 500ms, so it resolves to null.
const slowPromise = new Promise<number>(resolve => setTimeout(() => resolve(42), 1000));
const result2 = await runWithTimeout(slowPromise, 500);
console.log(result2); // null
```

***

### sanitizeName()

```ts
function sanitizeName(name): string;
```

Sanitize an accessory name according to HomeKit naming conventions.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | `string` | The name to validate. |

#### Returns

`string`

Returns the HomeKit-sanitized version of the name, replacing invalid characters with a space and squashing multiple spaces.

#### Remarks

This sanitizes names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
and HAP specification documentation:

- Starts and ends with a letter or number. Exception: may end with a period.
- May have the following special characters: -"',.#&.
- Must not include emojis.

#### Example

```ts
sanitizeName("Test|Switch")
```ts

Returns: `Test Switch`, replacing the pipe (an invalid character in HomeKit's naming ruleset) with a space.

***

### sleep()

```ts
function sleep(sleepTimer): Promise<Timeout>;
```

Emulate a sleep function.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sleepTimer` | `number` | The amount of time to sleep, in milliseconds. |

#### Returns

`Promise`\<`Timeout`\>

Returns a promise that resolves after the specified time elapses.

#### Example

To sleep for 3 seconds before continuing execute:

```ts
await sleep(3000)
```

***

### toCamelCase()

```ts
function toCamelCase(input): string;
```

Camel case a string.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `input` | `string` | The string to camel case. |

#### Returns

`string`

Returns the camel cased string.

#### Example

```ts
toCamelCase(This is a test)
```

Returns: `This Is A Test`, capitalizing the first letter of each word.

***

### validateName()

```ts
function validateName(name): boolean;
```

Validate an accessory name according to HomeKit naming conventions.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | `string` | The name to validate. |

#### Returns

`boolean`

Returns `true` if the name passes HomeKit's naming rules, `false` otherwise.

#### Remarks

This validates names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
and HAP specification documentation:

- Starts and ends with a letter or number. Exception: may end with a period.
- May not have multiple spaces adjacent to each other, nor begin nor end with a space.
- May have the following special characters: -"',.#&.
- Must not include emojis.

#### Example

```ts
validateName("Test|Switch")
```ts

Returns: `false`.

## Other

### formatBps()

```ts
function formatBps(value): string;
```

A utility method that formats a bitrate value into a human-readable form as kbps or Mbps.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `number` | The bitrate value to convert. |

#### Returns

`string`

Returns the value as a human-readable string.

#### Example

```ts
formatBps(500);        // "500 bps".
formatBps(2000);       // "2.0 kbps".
formatBps(15000);      // "15.0 kbps".
formatBps(1000000);    // "1.0 Mbps".
formatBps(2560000);    // "2.6 Mbps".
```
