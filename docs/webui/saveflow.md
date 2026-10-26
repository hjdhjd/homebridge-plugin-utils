[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / webui/saveflow

# webui/saveflow

The webUI's save flow: the one path from a press of a settings card's Save to the outcome the user is told, so the rules that make a Save trustworthy live in
one place rather than in a copy composed by hand at every card.

A card's Save checks what the user entered, writes it through the page's configuration commit, and reports what became of it. The flow holds every press to
the same rules: a press that arrives while a write is in flight starts nothing, a Save whose composer answers null - its change already in place, or refused
against the configuration as it stands - writes nothing of the composer's and is answered as such, and an outcome the user is owed lands on the card while
the card still shows that Save and on a toast otherwise. [createSaveFlow](#createsaveflow) builds one flow per card, and its `save` answers a tagged
[SaveFlowResult](#saveflowresult) the card switches on.

The flow owns no guard. A card has one way of beginning an action, which its other actions - a probe, a validation - use too, and a Save must retire them and
be retired by them. That holds only when the Save begins through the same starter, so the card injects its starter and the flow never mints a lifetime of its
own. What the flow does own is the one fact no single action can hold, whether a write is in flight, and a press that arrives during one is answered `busy`
rather than queued behind it or allowed to retire it: a write cannot be recalled once it has started, and a second write is the defect itself.

The module reaches for no document, holds no store and no plugin knowledge, and imports nothing at runtime: the commit, the starter, the toast, and the card's
Save control all arrive by injection, which is also what lets a consumer's suite drive the real flow with its own doubles. Policy stays with the card - what it
checks, what it writes, what a busy press looks like, and the copy and the after-work of a success. The Save control's disabled state during a write is the
flow's, so a Save that could not be honored is not pressable on any card.

A plugin's page loads the compiled copy the build dual-ships into `dist/ui/`, through the same import-map prefix as the package's other browser modules, and a
consumer's TypeScript imports the types, and in its Node suite the flow itself, from the package root. Its only import is the commit vocabulary's types, erased
at emit, so shipping it to the browser drags in nothing Node-only.

## WebUI Save Flow

### SaveAction

What a card's action starter answers for each action it begins. Of it the flow reads only `signal`, which aborts the moment the card retires the action, and
`presented()`, which says whether the card still shows what it showed when the action began. Whatever else the answer carries is the card's own, and the flow
hands the whole object back as the press's `action`, so a card reaches what it captured at the press - a takeover handle above all - on the result of that
same press rather than through state it keeps beside the flow.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="presented"></a> `presented` | `readonly` | () => `boolean` | Whether the card still shows what it showed when the action began, read at the moment it is called. |
| <a id="signal"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The action's lifetime on the card, aborted when the card retires the action. |

***

### SaveActionContext

What a check receives: the press's `action` exactly as the starter answered it, that action's `signal`, `presented()`, true while the signal is live and the
card's own `presented()` answers true, and `deliver`, the press's delivery decision.

Nothing a check runs may begin another action on the same card, a call to the card's own starter included: beginning one retires the press the check belongs
to, which then resolves `superseded` with nothing written.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-taction"></a> `TAction` *extends* [`SaveAction`](#saveaction) | [`SaveAction`](#saveaction) | What the card's starter answers, so a check reads the members the card put on its action typed as the card declared them. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="action"></a> `action` | `readonly` | `TAction` | The starter's answer for this press. |
| <a id="deliver"></a> `deliver` | `readonly` | [`SaveDelivery`](#savedelivery) | The press's delivery decision. |
| <a id="presented-1"></a> `presented` | `readonly` | () => `boolean` | Whether the press is still presented, read at the moment it is called. |
| <a id="signal-1"></a> `signal` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The press's signal, for every await the check bounds. |

***

### SaveFlow

One card's save flow, as [createSaveFlow](#createsaveflow) builds it.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-tplatform"></a> `TPlatform` *extends* `object` | `object` | The platform configuration object the card's commit hands every composer the flow runs. |
| <a id="type-parameter-taction-1"></a> `TAction` *extends* [`SaveAction`](#saveaction) | [`SaveAction`](#saveaction) | What the card's starter answers, which every check and every result carries. |

#### Methods

##### save()

```ts
save<TValue, TReason>(request): Promise<SaveFlowResult<TAction, TValue, TReason>>;
```

Run one press of the card's Save.

A press that arrives while a write is in flight answers `busy` before it begins anything, so it neither retires the write's action nor blanks what the card
is showing. Otherwise the press begins its action through the card's starter, synchronously within this call, and runs the check under the card's
newest-wins rule: a press the card retires while its check runs resolves `superseded`, and its delivery does nothing. No await separates the read of the
signal after the check from the write, so that read is the last point a retired press stops; past it, the write runs to its result and the result is owed.

The commit is called at most once per press, and the composer only inside it. The composer is where work that must immediately precede the write belongs:
it runs once, after the page's own pending edits are written, under the page's hold when the page took one, and directly before the write. A composer
answers null when its change is already in place, and also to refuse the change against the configuration as it stands, a duplicate of an entry another
call wrote ahead of it being the case that needs the composer's view. It refuses by that answer and never by a throw, because a composer that throws is a
bug in the card's own code and rejects the press. A card that prepares something there undoes it on every outcome that left the composer's change
unwritten - `failed`, `unchanged`, and a rejected press - and does not assume the composer ran, because `failed` can answer before it does. A card that
prepared something inside its check undoes it on `superseded` too, since the flow wrote nothing but cannot know what the check did.

A press rejects only for a bug in the caller's own code: a malformed call, a starter answer without its members, a check that throws or answers something
other than passed or declined while its press is current, a Save control whose `disabled` flag throws, and a commit that rejects, which the commit does only
for a composer that throws, a malformed call, or a page never shown, before any write starts. The in-flight flag is cleared on every path out of a write, so
a rejected press never leaves the card unable to save.

###### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-tvalue"></a> `TValue` | `unknown` | The value a passed check hands the composer, inferred from what the check answers. |
| <a id="type-parameter-treason"></a> `TReason` | `unknown` | The reason a declined check refused with, inferred from what the check answers. |

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`SaveRequest`](#saverequest)\<`TPlatform`, `TAction`, `TValue`, `TReason`\> | The press's check, composer, and rename, each described on [SaveRequest](#saverequest). |

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`SaveFlowResult`](#saveflowresult)\<`TAction`, `TValue`, `TReason`\>\>

What became of the press.

###### Example

```js
// One flow per card, built beside the card's guard. The card's starter blanks its verdict line, begins an action on the guard, and answers the action's
// signal, the presented() rule the card keeps, and the takeover the card is mounted in. The card's Save button is the control the flow disables during a write.
const flow = createSaveFlow({

  commit: (compose, options) => featureOptions.commitConfig(compose, options),
  control: card.saveButton,
  start: card.start,
  toast: homebridge.toast
});

const onSave = async () => {

  const result = await flow.save({

    check: async ({ signal }) => {

      try {

        const answer = await withDeadline({ promise: homebridge.request("/probe", card.values()), seconds: 10, signal });

        return answer.ok ? { kind: "passed", value: answer.controller } : { kind: "declined", reason: answer.message };
      } catch(error) {

        // A press retired meanwhile is answered superseded by the flow, whatever this check returns.
        return { kind: "declined", reason: errorMessage(error) };
      }
    },
    compose: (platform, controller) => platform.controllers.some((entry) => entry.address === controller.address) ? null :
      { controllers: [ ...platform.controllers, controller ] }
  });

  switch(result.kind) {

    case "busy":
    case "superseded": {

      return;
    }

    case "declined": {

      result.deliver({ channel: "error", paint: () => card.verdict(result.reason), text: result.reason });

      return;
    }

    case "unchanged": {

      const text = "A controller at this address is already saved.";

      result.deliver({ channel: "info", paint: () => card.verdict(text), text });

      return;
    }

    case "failed": {

      result.deliver({ channel: "error", paint: () => card.verdict(errorMessage(result.error)), text: errorMessage(result.error) });

      return;
    }

    case "committed": {

      homebridge.toast.success("The controller was saved.");
      result.action.takeover.release();

      return;
    }

    case "staged": {

      homebridge.toast.warning("The controller was written but not saved to disk. Save the plugin settings to keep it.");
      result.action.takeover.release();

      return;
    }
  }
};
```

###### Throws

`TypeError` when `check` or `compose` is not a function.

###### Throws

`TypeError` when the starter's answer has no `presented()` function or no `AbortSignal`.

###### Throws

`TypeError` when a current press's check answers something other than passed or declined.

***

### SaveFlowOptions

What [createSaveFlow](#createsaveflow) takes: the page's commit, the card's Save control, the card's starter, and the host's toast.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-tplatform-1"></a> `TPlatform` *extends* `object` | `object` | The platform configuration object the commit hands the composer, `object` unless the commit names the plugin's own configuration type. |
| <a id="type-parameter-taction-2"></a> `TAction` *extends* [`SaveAction`](#saveaction) | [`SaveAction`](#saveaction) | What the card's starter answers, [SaveAction](#saveaction) itself unless the card's action carries members of its own. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="commit"></a> `commit` | `readonly` | [`CommitConfig`](commit.md#commitconfig)\<`TPlatform`\> | The page's configuration commit, which a page passes as a function calling its feature-options instance's `commitConfig`. |
| <a id="control"></a> `control` | `readonly` | \| \{ `disabled`: `boolean`; \} \| `null` | The card's Save control, which the flow disables for the span of each write, or null for a card that has none. A button element serves, as does any object whose `disabled` flag is a boolean. |
| <a id="start"></a> `start` | `readonly` | () => `TAction` | The card's own way of beginning an action. It retires whatever action the card had in flight, exactly as the card's other actions do, and answers the new action's signal and `presented()`. A card whose guard is its only press state passes a closure over `guard.start()`; a card that also blanks its verdict line and captures what it is showing passes the function that does all of that, once it answers `presented` and `signal`. |
| <a id="toast"></a> `toast` | `readonly` | \{ `error`: (`message`) => `void`; `info`: (`message`) => `void`; `success`: (`message`) => `void`; `warning`: (`message`) => `void`; \} | The host's toast, which the flow calls only through a press's delivery decision. |
| `toast.error` | `readonly` | (`message`) => `void` | - |
| `toast.info` | `readonly` | (`message`) => `void` | - |
| `toast.success` | `readonly` | (`message`) => `void` | - |
| `toast.warning` | `readonly` | (`message`) => `void` | - |

***

### SaveRequest

What one press of the card's Save hands [SaveFlow.save](#save): the check, the composer, and the rename the write declares.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-tplatform-2"></a> `TPlatform` *extends* `object` | `object` | The platform configuration object the commit hands the composer. |
| <a id="type-parameter-taction-3"></a> `TAction` *extends* [`SaveAction`](#saveaction) | [`SaveAction`](#saveaction) | What the card's starter answers, which the check reads on its context. |
| <a id="type-parameter-tvalue-1"></a> `TValue` | `unknown` | The value a passed check hands the composer. |
| <a id="type-parameter-treason-1"></a> `TReason` | `unknown` | The reason a declined check refused with. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="check"></a> `check` | `readonly` | (`context`) => \| [`SaveCheckResult`](#savecheckresult)\<`TValue`, `TReason`\> \| [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`SaveCheckResult`](#savecheckresult)\<`TValue`, `TReason`\>\> | Checks what the user entered under the press's action and answers whether to write. It receives the press's context and may deliver through it. |
| <a id="compose"></a> `compose` | `readonly` | (`platform`, `value`) => `object` \| `null` | Composes the patch from the live platform entry and the checked value, answering null when the change is already in place or to refuse it against the configuration as it stands. |
| <a id="rename"></a> `rename?` | `readonly` | [`ControllerRename`](commit.md#controllerrename) | The controller rename the write declares, handed to the commit as given: the commit owns its shape and refuses a malformed one. |

***

### SaveCheckResult

```ts
type SaveCheckResult<TValue, TReason> = 
  | {
  kind: "passed";
  value: TValue;
}
  | {
  kind: "declined";
  reason: TReason;
};
```

What a check answers: `passed` with the value the write composes with, or `declined` with the reason it refused. Only a passed check writes. An answer that is
neither passed nor declined is a bug in the check, and it rejects the press while that press is current.

A check that delivers its own refusal answers `declined` with a reason the card does not deliver again, and a check that delivers nothing leaves the reason to
the card, which delivers it from the result. One refusal is delivered once.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-tvalue-2"></a> `TValue` | `unknown` | The value a passed check hands the composer, which the result carries. |
| <a id="type-parameter-treason-2"></a> `TReason` | `unknown` | The reason a declined check refused with, which the result carries. |

***

### SaveDelivery

```ts
type SaveDelivery = (delivery) => void;
```

The one delivery decision for an outcome the user is owed. It paints on the card while the press is presented. Otherwise it raises the named toast, because a
card that closed or moved on is still owed the outcome, and so is any press whose write started - with one exception: a press retired before its write owes the
user nothing, so for it the delivery does nothing at all.

It is for outcomes. A progress paint made during the check reads `presented()` instead and is dropped when that answers false, since progress on a card the
user cannot see is owed to nobody. An outcome always goes through here and never through a paint helper the action carries, because a helper that drops what
the card does not present would drop an outcome the user is owed along with it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `delivery` | \{ `channel`: `"error"` \| `"info"` \| `"success"` \| `"warning"`; `paint`: () => `void`; `text`: `string`; \} |
| `delivery.channel` | `"error"` \| `"info"` \| `"success"` \| `"warning"` |
| `delivery.paint` | () => `void` |
| `delivery.text` | `string` |

#### Returns

`void`

***

### SaveFlowResult

```ts
type SaveFlowResult<TAction, TValue, TReason> = 
  | {
  kind: "busy";
}
  | {
  kind: "superseded";
}
  | {
  action: TAction;
  deliver: SaveDelivery;
  presented: () => boolean;
} & (
  | {
  kind: "declined";
  reason: TReason;
}
  | {
  value: TValue;
} & CommitConfigResult);
```

What became of a press, tagged by `kind`:

  - `busy`: a write was already in flight, so the press started nothing and left the write's own presentation alone. What a refused press looks like is the
    card's to decide, and nothing is owed.
  - `superseded`: the press was retired before its write - by a later press, by another of the card's actions, or by whatever bounds the card's guard.
    Nothing was written, and nothing is owed, because the action that retired it owns the card.
  - `declined`: the check refused, carrying its `reason`, and nothing was written. A card whose check delivered nothing delivers the reason through `deliver`.
  - Every other kind is the page's commit result, passed through with its `error` where it has one and with the checked `value` added. A card delivers
    `failed` and `unchanged` through `deliver`, because the press reached its write and its outcome is owed. `unchanged` means the composer answered null,
    its change already in place or refused against the configuration as it stands, and the result does not say which: the card supplies the words, and a
    card whose composer answers null for more than one reason keeps the reason in a variable its composer sets. Success is left to the card, because its copy and its
    after-work are plugin policy, and a card that saves releases its own takeover.

Each member but `busy` and `superseded` carries the press's `action`, `deliver` and `presented`, so a card delivers and releases from the result alone.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-taction-4"></a> `TAction` *extends* [`SaveAction`](#saveaction) | [`SaveAction`](#saveaction) | What the card's starter answers, carried back as the press's `action`. |
| <a id="type-parameter-tvalue-3"></a> `TValue` | `unknown` | The value a passed check handed the composer. |
| <a id="type-parameter-treason-3"></a> `TReason` | `unknown` | The reason a declined check refused with. |

***

### createSaveFlow()

```ts
function createSaveFlow<TPlatform, TAction>(options): SaveFlow<TPlatform, TAction>;
```

Create the save flow for one settings card.

The flow's whole state across presses is whether a write is in flight, one boolean in this closure, so a flow belongs to the card it serves: each card runs
its own flow, and none refuses a press on account of another card's write. Everything else a press needs arrives by injection, which keeps the flow free of any page,
card, or host it would otherwise have to reach for.

Whatever bounds the starter's signal decides whether closing the card retires a Save before its write. A card whose guard takes the card's own lifetime as its
parent retires a pressed Save when it closes; a card that wants a close to leave a pressed Save running gives its guard no parent tied to the card, and
`presented()` then decides only where the outcome lands. A press that has reached its write is retired by nothing: the write runs to its result, and that
result is owed.

The card's Save control is not pressable for exactly the span in which a press could not be honored, which is the library's default for every card. The span
starts when the commit is called and ends when the commit settles, on every way out, a rejection included. The control is not disabled during the check,
because a newer press retires a check and the user must be able to make one. The busy answer is what guarantees a second write never starts, and the
disabled control is a courtesy on top of it, not the safety mechanism. The option is required and may be null, so a card with no Save control says so on
purpose rather than by leaving it out. The flow asks of the control only its `disabled` flag and restores the state it found, so a control the card had
disabled for its own reason stays disabled. The restore writes over whatever the card set on the control during the write, so a card that manages the
control itself sets it again when it handles the result. A control serves one flow, for that flow's life.

The flow puts no bound on a write, so the control stays disabled for as long as the write is outstanding, which is the truth of the card's state. The commit a
card injects settles only when the page's commit settles, with no deadline wrapped around it, because a deadline would clear the in-flight flag and
re-enable the control while the write still runs.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-tplatform-3"></a> `TPlatform` *extends* `object` | `object` | The platform configuration object the commit hands the composer, inferred from the commit, so a commit typed against a plugin's own configuration types every composer the flow runs. |
| <a id="type-parameter-taction-5"></a> `TAction` *extends* [`SaveAction`](#saveaction) | [`SaveAction`](#saveaction) | What the card's starter answers, inferred from the starter, so the check's context and the result's `action` carry the card's own members. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`SaveFlowOptions`](#saveflowoptions)\<`TPlatform`, `TAction`\> | The page's commit, the card's Save control, the card's starter, and the host's toast, each described on [SaveFlowOptions](#saveflowoptions). |

#### Returns

[`SaveFlow`](#saveflow)\<`TPlatform`, `TAction`\>

The card's flow: `save` runs one press.

#### Throws

`TypeError` when `control` is neither null nor an object whose `disabled` flag is a boolean, an omitted control included.
