[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / testing/runtime-floor

# testing/runtime-floor

The shared machinery behind an engines-keyed conformance guard.

A package that works around a platform gap carries a debt: the workaround has to disappear when the gap closes, and nobody remembers to look. The guard suite is the
mechanism that remembers. It reads the package's own declared `engines.node` floor, decides from it whether the workaround is still owed, sweeps the shipped source to
confirm the workaround is actually applied everywhere it must be, and - the moment the floor reaches the release that closes the gap - fails with an enumerated
cleanup checklist instead of quietly continuing to pass.

Every plugin in the family runs that same suite against a different workaround, and what varies between them is narrower than it looks: which major closes the gap,
which files to skip, what the checklist says, and what each one's own detectors look for. What does not vary is everything below. The regime decision, the engines
read, the source walk, and the sunset canary are one implementation here rather than a fourth hand-rolled copy per repository.

What deliberately stays with the consumer is the policy: the patterns its sweep looks for, the predicates that decide whether a matching file is compliant, and the
artifact list its checklist enumerates. Those are the thing being guarded, not the guarding, and hoisting a domain's own detectors into domain-generic machinery
would couple every consumer to every other consumer's workaround.

One authoring rule binds this module and everything else under `src/testing/`: the directory is shipped source, so a consumer's own sweep walks it. Prose here must
therefore describe what a detector looks for without reproducing text a detector would match, or a shipped module trips the very guard it exists to serve.

## Testing

### RuntimeFloor

The regime an `engines.node` floor selects, and the major version it was read from.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="major"></a> `major` | `readonly` | `number` | The Node major version parsed out of the range. |
| <a id="regime"></a> `regime` | `readonly` | `"compat"` \| `"sunset"` | `"compat"` while the floor sits below the release that closes the gap, so the workaround is still owed. `"sunset"` at or above it, so the workaround must go. |

***

### RuntimeFloorPlanQuery

What [planRuntimeFloorCheck](#planruntimefloorcheck) needs: everything [parseRuntimeFloor](#parseruntimefloor) needs, plus the checklist to fail with when the sunset comes due.

#### Extends

- [`RuntimeFloorQuery`](#runtimefloorquery)

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="enginesnode"></a> `enginesNode` | `readonly` | `string` | The package's declared `engines.node` range, in any of the forms a package.json carries (`">=22.20"`, `"^24"`, `">=24.0.0"`). | [`RuntimeFloorQuery`](#runtimefloorquery).[`enginesNode`](#enginesnode-1) |
| <a id="sunsetmajor"></a> `sunsetMajor` | `readonly` | `number` | The Node major at or above which the workaround is redundant and the sunset is due. This is the consumer's own policy - each guard works around a different gap that closed in a different release - so it is a parameter rather than a constant here. | [`RuntimeFloorQuery`](#runtimefloorquery).[`sunsetMajor`](#sunsetmajor-1) |
| <a id="sunsetmessage"></a> `sunsetMessage` | `readonly` | `string` | The enumerated cleanup the sunset arm carries. Compose it from the artifact list with [composeSunsetCleanup](#composesunsetcleanup) when the checklist is list-shaped, so the message and the fragments a test looks for cannot drift apart; write it by hand when it is prose. | - |

***

### RuntimeFloorQuery

What [parseRuntimeFloor](#parseruntimefloor) needs: the declared range, and the major that closes the gap.

#### Extended by

- [`RuntimeFloorPlanQuery`](#runtimefloorplanquery)

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="enginesnode-1"></a> `enginesNode` | `readonly` | `string` | The package's declared `engines.node` range, in any of the forms a package.json carries (`">=22.20"`, `"^24"`, `">=24.0.0"`). |
| <a id="sunsetmajor-1"></a> `sunsetMajor` | `readonly` | `number` | The Node major at or above which the workaround is redundant and the sunset is due. This is the consumer's own policy - each guard works around a different gap that closed in a different release - so it is a parameter rather than a constant here. |

***

### SourceSweep

What [sweepSourceFiles](#sweepsourcefiles) walks.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="roots"></a> `roots` | `readonly` | readonly `URL`[] | The directories to walk, as URLs. Every real consumer derives its root from `import.meta.url`, so taking URLs lets the caller pass `new URL(".", import.meta.url)` directly and keeps the path conversion in one place instead of at each call site. |
| <a id="skipbasenames"></a> `skipBasenames?` | `readonly` | readonly `string`[] | File basenames to leave out of the walk beyond the never-shipped suffixes - a module the guard's own rule cannot sensibly be applied to. Defaults to none. |

***

### SunsetCleanupFrame

What [composeSunsetCleanup](#composesunsetcleanup) assembles a checklist from.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="artifacts"></a> `artifacts` | `readonly` | readonly `string`[] | Every artifact the sunset removes or restores, each naming a distinct path. Keeping them distinct is what lets a test assert the message enumerates all of them: a fragment contained inside another would be satisfied by a message that named only the longer one. |
| <a id="epilogue"></a> `epilogue?` | `readonly` | `string` | Text appended after the list - the trailing steps that are not deletions of a listed artifact, or simply the closing punctuation. Defaults to the empty string. |
| <a id="prologue"></a> `prologue` | `readonly` | `string` | Text placed before the list, ending at the point the list should begin. |
| <a id="separator"></a> `separator?` | `readonly` | `string` | What joins the artifacts. Defaults to `", "`; a checklist whose entries contain commas of their own wants `"; "`. |

***

### SweptFile

One shipped source file as the sweep read it: where it lives and what it says. Fields are `readonly` because a sweep result is a snapshot for predicates to read, and
nothing downstream has any business editing it.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="path"></a> `path` | `readonly` | `string` | The file's absolute filesystem path, suitable for a failure message and for an `endsWith` check against a known location. |
| <a id="text"></a> `text` | `readonly` | `string` | The file's full text, as UTF-8. |

***

### RuntimeFloorPlan

```ts
type RuntimeFloorPlan = 
  | {
  kind: "sunset";
  message: string;
}
  | {
  kind: "sweep";
};
```

What the guard does about the floor it just read: sweep the source, or fail with the cleanup checklist.

The two arms are one value rather than a regime beside an optional message, because a regime that is not the sunset arm has no message to carry and pairing them as
independent parameters would make that combination expressible. Here it is not: only the sunset arm has a `message` field at all.

***

### assertRuntimeFloorCompat()

```ts
function assertRuntimeFloorCompat(plan): void;
```

The canary. Fail the calling test with the enumerated checklist when the plan says the sunset has come due, and do nothing at all when it has not.

This consumes the plan as one value rather than taking a regime and a message side by side, so there is no way to ask it to fire without giving it something to say.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `plan` | [`RuntimeFloorPlan`](#runtimefloorplan) | The plan [planRuntimeFloorCheck](#planruntimefloorcheck) produced. |

#### Returns

`void`

#### Throws

`AssertionError` carrying the cleanup checklist when the plan is the sunset arm.

***

### composeSunsetCleanup()

```ts
function composeSunsetCleanup(frame): string;
```

Assemble a cleanup checklist from the artifact list it enumerates.

Composing the message from the same array a test asserts the fragments of is the point: the checklist and the fragments cannot drift apart, because there is only one
list. A guard whose checklist is prose rather than a list skips this and writes its message directly.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `frame` | [`SunsetCleanupFrame`](#sunsetcleanupframe) | See [SunsetCleanupFrame](#sunsetcleanupframe). |

#### Returns

`string`

The composed checklist.

***

### parseRuntimeFloor()

```ts
function parseRuntimeFloor(query): RuntimeFloor;
```

Read the Node major out of an `engines.node` range and decide which regime it selects.

The first run of digits is the major, which is the reading every range form a package.json carries agrees on (`">=22.20"`, `"^24"`, `">=24.0.0"`). A range with no
digits at all is a hard failure rather than a silent default, because a guard that quietly assumed a regime would be a guard that quietly stopped guarding.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `query` | [`RuntimeFloorQuery`](#runtimefloorquery) | See [RuntimeFloorQuery](#runtimefloorquery). |

#### Returns

[`RuntimeFloor`](#runtimefloor)

The parsed major and the regime it selects.

#### Throws

`Error` naming the offending value when no major version can be read from it.

***

### planRuntimeFloorCheck()

```ts
function planRuntimeFloorCheck(query): RuntimeFloorPlan;
```

Map an `engines.node` range to what the guard should do about it: fail with the cleanup checklist, or run the source sweep.

Both arms run on every suite that drives this synthetically as well as live - a guard feeds it a sunset-regime range and a compat-regime range alongside the real
package's own value - so the firing path is exercised rather than left as dead code a replica claims to cover.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `query` | [`RuntimeFloorPlanQuery`](#runtimefloorplanquery) | See [RuntimeFloorPlanQuery](#runtimefloorplanquery). |

#### Returns

[`RuntimeFloorPlan`](#runtimefloorplan)

The sunset arm carrying the checklist, or the sweep arm.

***

### readEnginesNode()

```ts
function readEnginesNode(packageRoot): Promise<string>;
```

Read a package's declared `engines.node`, given the package's root directory.

The root is a parameter and not derived from this module's own location, which is the whole reason this reader can be shared: a hoisted copy that pathed relative to
itself would read this library's package.json from inside every consumer that called it, and quietly guard the wrong floor.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `packageRoot` | `URL` | The consuming package's root directory, as a URL. A guard suite sitting in `src/` passes `new URL("../", import.meta.url)`. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`string`\>

The declared range.

#### Throws

`Error` when the package.json has no `engines.node` string.

***

### sweepSourceFiles()

```ts
function sweepSourceFiles(sweep): Promise<SweptFile[]>;
```

Walk the shipped source a guard inspects: every `.ts` file under the given roots, minus the suites, helpers, and fixtures that never ship, minus any basename the
caller asks to skip.

Reads run in parallel, since the walk is I/O against a few dozen small files and nothing downstream depends on the order they arrive in.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sweep` | [`SourceSweep`](#sourcesweep) | See [SourceSweep](#sourcesweep). |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`SweptFile`](#sweptfile)[]\>

One record per shipped file, each carrying its absolute path and full text.
