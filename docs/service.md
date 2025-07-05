[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / service

# service

Homebridge service helper utilities.

## Accessory

### acquireService()

```ts
function acquireService(
   accessory, 
   serviceType, 
   name, 
   subtype?, 
onServiceCreate?): Nullable<Service>;
```

Utility method that either creates a new service on an accessory if needed, or returns an existing one. Optionally, it executes a callback to initialize a new
service instance. Additionally, the various name characteristics of the service are set to the specified name, and optionally added if necessary.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory` | The Homebridge accessory to check or modify. |
| `serviceType` | `WithUUID`\<*typeof* `Service`\> | The type of service to instantiate or retrieve. |
| `name` | `string` | Name to be displayed to the end user for this service. |
| `subtype?` | `string` | Optional service subtype to uniquely identify the service. |
| `onServiceCreate?` | (`svc`) => `void` | Optional callback invoked only when a new service is created, receiving the new service as its argument. |

#### Returns

[`Nullable`](util.md#nullable)\<`Service`\>

Returns the created or retrieved service, or `null` if service creation failed.

#### Remarks

This method ensures that the service's display name and available name characteristics are updated to the specified name. If `onServiceCreate` is provided,
it will only be called for newly created services, not for existing ones.

The `ConfiguredName` and `Name` characteristics are conditionally added or updated based on the type of service, in accordance with HomeKit requirements.

#### Example

```typescript
// Example: Ensure a Lightbulb service exists with a user-friendly name, and initialize it if newly created.
const lightbulbService = acquireService(accessory, hap.Service.Lightbulb, "Living Room Lamp", undefined, (svc: Service): void => {

  // Called only if the service is newly created.
  svc.setCharacteristic(hap.Characteristic.On, false);
});

if(lightbulbService) {

  // Service is now available, with display name set and optional characteristics managed.
  lightbulbService.updateCharacteristic(hap.Characteristic.Brightness, 75);
}
```

#### See

 - setServiceName — updates the newly created (or existing) service’s name-related characteristics.
 - validService — validate or prune services after acquisition.

***

### getServiceName()

```ts
function getServiceName(service?): undefined | string;
```

Retrieves the primary name of a service, preferring the ConfiguredName characteristic over the Name characteristic.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `service?` | `Service` | The service from which to retrieve the name. |

#### Returns

`undefined` \| `string`

The configured or display name of the service, or `undefined` if neither is set.

#### See

setServiceName — to update the current name n a service.

***

### setServiceName()

```ts
function setServiceName(service, name): void;
```

Updates the displayName and applicable name characteristics of a service to the specified value.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `service` | `Service` | The service to update. |
| `name` | `string` | The new name to apply to the service. |

#### Returns

`void`

#### Remarks

This function ensures the name is validated, updates the service's `displayName`, and sets the `ConfiguredName` and `Name`
characteristics when supported by the service type.

#### See

 - acquireService — to add or retrieve services.
 - getServiceName — to retrieve the current name set on a service.

***

### validService()

```ts
function validService(
   accessory, 
   serviceType, 
   validate, 
   subtype?): boolean;
```

Validates whether a specific service should exist on the given accessory, removing the service if it fails validation.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory` | The Homebridge accessory to inspect and potentially modify. |
| `serviceType` | `WithUUID`\<*typeof* `Service`\> | The type of Homebridge service being checked or instantiated. |
| `validate` | `boolean` \| (`hasService`) => `boolean` | A boolean or a function that determines if the service should exist. If a function is provided, it receives a boolean indicating whether the service currently exists, and should return `true` to keep the service, or `false` to remove it. |
| `subtype?` | `string` | Optional service subtype to uniquely identify the service. |

#### Returns

`boolean`

`true` if the service is valid (and kept), or `false` if it was removed.

#### Remarks

The `validate` parameter can be either:
  - a boolean (where `true` means keep the service, `false` means remove it).
  - a function (which is called with `hasService: boolean` and returns whether to keep the service).

If the service should not exist according to `validate`, and it is currently present, this function will remove it from the accessory.

#### Example

```typescript
// Remove a service if it exists
validService(accessory, Service.Switch, false);

// Only keep a service if a configuration flag is true
validService(accessory, Service.Switch, config.enableSwitch);

// Keep a service if it currently exists, or add it if a certain condition is met
validService(accessory, Service.Switch, (hasService) => hasService || config.enableSwitch);
```

#### See

acquireService — to add or retrieve services.
