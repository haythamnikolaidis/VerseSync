# T-23 · Host: skeleton, sequence info, playhead, field discovery

| | |
|---|---|
| **Workstream** | G — Host (ExtendScript) |
| **Unblocks** | T-24, T-25 |
| **Spec** | [08-premiere-host-api.md §1–3, §5, §7, §9](../08-premiere-host-api.md) (as updated by T-47) |

## Goal

Port VerseFlow's host to `panel/jsx/VerseSync.jsx`, and implement `VS.ping`,
`VS.getSequenceInfo`, `VS.setPlayhead` and `VS.getMogrtFields`. Test them under Node against the
T-45 fake DOM.

## Context

The [08 §1] conventions aren't style preferences. Each one records a bug that has already been
paid for:

- one file, no `#include`;
- `var fn = function(){}`, never `function fn(){}`;
- ES3 and ASCII only, with the JSON polyfill at the top;
- never throw across the bridge;
- ticks are strings.

**Response shapes must equal the T-39 fixtures (`tests/fixtures/host/*.json`) exactly**, so that
swapping the stub for the real host changes nothing.

## Subtasks

### T-23.1 · `VerseSync.jsx` skeleton, ES3 lint, `ping`, `getSequenceInfo`, `setPlayhead`

**Executor** agent · **Size** S · **Prereqs** T-45.1, T-47 · **Status** done

- **Read:** [08 §1, §2, §3, §7, §9](../08-premiere-host-api.md) ·
  `reference/verseflow/jsx/VerseFlow.jsx` (the header comment, the JSON polyfill, and
  `getSequenceInfo`) · `tests/fixtures/host/sequence-2997.json`
- **Touches:** `panel/jsx/VerseSync.jsx` (new) · `eslint.config.js` (add a `panel/jsx/**/*.jsx`
  block with `ecmaVersion: 3`, `sourceType: 'script'`, and `func-style: ['error','expression']`)
  · `package.json` (extend the `lint` script to cover `panel/jsx`) · `tests/host/sequence.test.js`
  (new)
- **Steps:**
  1. Port the header and the polyfill. Add the `VS` namespace, a `_ok(data)` / `_err(msg)`
     JSON-string helper pair, and the outer try/catch wrapper pattern that every `VS.*` function
     uses. Add `VS.ping`, returning `hostApi: "1.1"`. Add the ESLint ES3 block, and an
     ASCII-only check in `load-jsx.js` (T-45.1 already throws on non-ASCII). Commit.
  2. Add `VS.getSequenceInfo`, including `sequenceId`, `timebase` (Premiere's own string,
     **never derived**), `zeroPointTicks` and `endTicks`. Add `VS.setPlayhead`, which goes
     through `activeSequence.setPlayerPosition`. With no sequence open, both return the §9
     message. Commit.
  3. Tests on the fake DOM. Each response equals its fixture once that fixture is loaded into
     the fake (`sequence-2997`, `sequence-23976`, `sequence-25`, `sequence-none`). Also:
     `setPlayhead` moves the fake's playhead, and the "no sequence" message is exact. Commit.
- **Verify:** `node --test tests/host/sequence.test.js && npm run lint`
- **Done when:**
  - [x] Responses are deep-equal to the T-39 fixtures.
  - [x] ES3 lint is enforced on `panel/jsx`.
  - [x] No function declarations, and no non-ASCII bytes.

### T-23.2 · `VS.getMogrtFields` (ported unchanged)

**Executor** agent · **Size** S · **Prereqs** T-23.1, T-45.2 · **Status** todo

- **Read:** [08 §5](../08-premiere-host-api.md) · `reference/verseflow/jsx/VerseFlow.jsx`
  (`getMogrtFields` and its helpers) · `tests/fixtures/host/mogrt-fields.json`
- **Touches:** `panel/jsx/VerseSync.jsx` · `tests/host/mogrt-fields.test.js` (new)
- **Steps:**
  1. Port `getMogrtFields` **without changing its logic**:
     - the three detection strategies (`propertyType === 6`, then `=== 5`, then a `getValue()`
       probe for `textEditValue`);
     - the handling of group nodes of types 10 and 4;
     - the scratch insert past the end, inside an undo group, then removal;
     - the open-sequence error message.

     The output shape matches `mogrt-fields.json`. Commit.
  2. Tests on the fake, using the registered `AV_Quote_04` template:
     - both `Text` fields come back with **different indices** and the labels
       `Title Main > Text` and `Description > Text`;
     - the scratch clip is removed and the undo groups balance;
     - no sequence gives the §9 field-discovery message;
     - a template with no text fields gives `fields: []`.

     Commit.
- **Verify:** `node --test tests/host/mogrt-fields.test.js`
- **Done when:**
  - [ ] The output equals `mogrt-fields.json` for the reference template.
  - [ ] The undo groups balance.

## Traps

- **`timebase` carries the load.** Return Premiere's integer string, and never compute it from
  `frameRate`.
- **Keep index-based field targeting.** Both fields are named `Text` (R-8).
- `zeroPointTicks` is for display only.
