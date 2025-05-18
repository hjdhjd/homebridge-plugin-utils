[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / service

# service

Homebridge service helper utilities.

## Accessory

### acquireService()

```ts
function acquireService(
   hap, 
   accessory, 
   serviceType, 
   name, 
   subtype?, 
onServiceCreate?): Nullable<Service>;
```

Utility method that either creates a new service on an accessory, if needed, or returns an existing one. It optionally executes a callback to initialize a new
instance of a service, if needed. Additionally, the various name characteristics of the service will be set to the specified name, optionally adding them as needed.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `hap` | `__module` | HAP instance associated with the Homebridge plugin. |
| `accessory` | `PlatformAccessory` | Homebridge accessory to check. |
| `serviceType` | `WithUUID`\<*typeof* `Service`\> | Service type that is being instantiated or retrieved. |
| `name` | `string` | Name to be displayed to the end user for this service. |
| `subtype?` | `string` | Service subtype, if needed. |
| `onServiceCreate?` | (`svc`) => `void` | Callback to be used when a new service is created. It is not called when an existing service is found. |

#### Returns

[`Nullable`](util.md#nullable)\<`Service`\>

Returns the created or retrieved service, `null` otherwise.

#### Remarks

`onServiceCreate` is called with the newly created service as an argument to allow the caller to optionally configure it.

***

### validService()

```ts
function validService(
   accessory, 
   serviceType, 
   validate, 
   subtype?): boolean;
```

Validate whether a service should exist, removing it if needed.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory` | Homebridge accessory to check. |
| `serviceType` | `WithUUID`\<*typeof* `Service`\> | Service type that is being instantiated or retrieved. |
| `validate` | (`hasService`) => `boolean` | Function to be used to test whether a service should exist or not. |
| `subtype?` | `string` | Service subtype, if needed. |

#### Returns

`boolean`

Returns `true` if the service is valid, will remove the service and return `false` otherwise.

#### Remarks

`validate` is called with an argument of `true` if the service currently exists on the accessory and `false` otherwise.
