# T-22 · Panel scaffold + bridge

| | |
|---|---|
| **Workstream** | F — Panel |
| **Unblocks** | T-26, T-27, T-28, T-49 |
| **Spec** | [03-architecture.md §5](../03-architecture.md) · [08-premiere-host-api.md §1](../08-premiere-host-api.md) |

## Goal

A CEP panel that loads in Premiere, and a promise-based bridge that reaches the host. **It also
loads in a plain browser against the T-39 host stub**, so the rest of stream F can go ahead
without Premiere.

## Context

VerseFlow's `bridge.js` already solves the hard parts. Port it rather than re-deriving it.
There are two details to keep: the explicit `loadJSX()` at init, which gets around Premiere's
`ScriptPath` cache, and handling of the `EvalScript error.` sentinel.

**D21 (from this rework):** the panel talks to the sidecar through **Node's `http` module**, not
XHR or EventSource. Reasons:

- a `file://` CEP page sending an `Authorization` header would trigger a CORS preflight, and
  neither sidecar answers `OPTIONS`;
- launching the sidecar needs `child_process` anyway;
- the same transport runs unchanged in Node tests.

So the manifest **must** enable Node: `--enable-nodejs` and `--mixed-context` under
`<CEFCommandLine>`.

## Subtasks

### T-22.1 · Panel skeleton: manifest, debug file, `index.html`, CSS, `main.js`, jsdom

**Executor** agent · **Size** S · **Prereqs** T-43 · **Status** in-progress

- **Read:** [03 §5](../03-architecture.md) (the `panel/` part) · [09 §1, §8](../09-ui-spec.md) ·
  `reference/verseflow/CSXS/manifest.xml` · `reference/verseflow/index.html` (its structure only)
- **Touches:** `panel/CSXS/manifest.xml` · `panel/.debug` · `panel/index.html` ·
  `panel/css/style.css` · `panel/js/lib/CSInterface.js` (copied from `reference/verseflow/`) ·
  `panel/js/main.js` · `package.json` (add `jsdom` to devDependencies) ·
  `tests/panel/index-html.test.js` (new)
- **Steps:**
  1. Write the manifest, based on VerseFlow's:
     - bundle id `com.versesync.panel`, host `PPRO`, the same CSXS versions VerseFlow uses;
     - geometry 340–600 px wide;
     - `--enable-nodejs` and `--mixed-context`.

     Write `.debug` with port **7781**, which is different from VerseFlow's 7778. Copy
     `CSInterface.js`. Commit.
  2. Write `index.html`. It has empty containers for the status strip, setup, progress, review
     and insert sections, each with a stable `id` from [09 §1] (`#status`, `#setup`,
     `#progress`, `#review`, `#insert`). It loads the scripts in this order: `CSInterface.js`,
     `host-stub.js`, `bridge.js`, then the modules, then `main.js`.
     - Port `style.css` from VerseFlow's variables and controls, and add the [09 §8] flag
       colours as CSS variables.
     - `main.js` is a bootstrap stub that calls `VSBridge.init()` and logs `VS.ping`.
     - Add `jsdom`.

     Write a test that loads `index.html` in jsdom with scripts disabled and asserts that every
     container exists and the script order is right. Commit.
- **Verify:** `npm test && npm run lint`
- **Done when:**
  - [ ] The manifest is valid XML, with Node enabled and debug port 7781.
  - [ ] The jsdom test passes.

### T-22.2 · `bridge.js` port

**Executor** agent · **Size** S · **Prereqs** T-22.1 · **Status** todo

- **Read:** [08 §1](../08-premiere-host-api.md) · `reference/verseflow/js/bridge.js`
- **Touches:** `panel/js/bridge.js` (new) · `tests/panel/bridge.test.js` (new)
- **Interface:**
  ```javascript
  VSBridge.create({ csInterface, hostStub, jsxPath }) -> bridge
  bridge.init() -> Promise<{ok, data|error}>        // loadJSX(): $.evalFile(jsxPath), then VS.ping
  bridge.call(fnName, argsObject) -> Promise<{ok, data} | {ok:false, error}>   // NEVER rejects
  bridge.mode  // 'premiere' | 'stub'
  bridge.onEvent(type, handler)                     // CSXS events, e.g. 'com.versesync.progress'
  ```
- **Steps:**
  1. Port `bridge.js` as a UMD module.
     - It's in stub mode when `csInterface` is absent, or when the page URL has `?stub=1`.
     - In stub mode, `call` invokes `hostStub[fn](JSON.stringify(args))` synchronously and
       wraps the result in a resolved promise.
     - In Premiere mode, it calls `evalScript('VS.' + fn + '(' + JSON.stringify(JSON.stringify(args)) + ')')`.
     - An `EvalScript error.` result, an empty string, or JSON that won't parse becomes
       `{ok:false, error:'…'}`. Nothing ever throws or rejects.

     Commit.
  2. Tests, with a fake `csInterface` that records `evalScript` calls:
     - `init()` calls `$.evalFile` with the jsx path **before** the ping;
     - the sentinel becomes `{ok:false}`;
     - bad JSON becomes `{ok:false}`;
     - stub mode routes to `host-stub.js` (require it) and `ping` returns `hostApi '1.1'`;
     - events are delivered through `addEventListener`.

     Commit.
- **Verify:** `node --test tests/panel/bridge.test.js`
- **Done when:**
  - [ ] The bridge never throws or rejects, in any test.
  - [ ] `loadJSX` happens at init.

### T-22.H · Panel loads in Premiere

**Executor** human · **Size** — · **Prereqs** T-22.2, T-23.1 · **Status** todo

- Install the panel in debug mode, then open Window ▸ Extensions ▸ VerseSync. `VS.ping` returns
  `hostApi 1.1` (check in DevTools on port 7781).
- Confirm `require('http')` works in the panel context. D21 depends on it.
- Open `panel/index.html` in Chrome and confirm the stub ping works. This closes the Wave 0
  sub-clause in [13 §5](../13-technical-plan.md).
- Record the results in `docs/qa/host-verification.md`.

## Traps

- No bundler and no framework. Premiere loads these files directly.
- The stub must never switch on inside Premiere unless the page has `?stub=1`.
