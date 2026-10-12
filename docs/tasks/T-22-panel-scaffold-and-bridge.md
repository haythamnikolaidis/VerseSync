# T-22 · Panel scaffold + bridge

| | |
|---|---|
| **Workstream** | F — Panel |
| **Wave** | 1 |
| **Estimate** | S |
| **Prereqs** | T-39, T-40 |
| **Unblocks** | T-26, T-27, T-28 — **the critical path starts here** |
| **Spec** | [03-architecture.md §5](../03-architecture.md) · [08-premiere-host-api.md §1](../08-premiere-host-api.md) |

## Goal

A CEP panel that loads in Premiere, and a promisified bridge that reaches the host. **It must
also load in a plain browser against the T-39 host stub** — that is what lets the rest of
stream F proceed without a Premiere workstation.

## Context you need

Stream F is the project's critical path ([13 §6](../13-technical-plan.md)). Getting this task
done fast, with the stub path working, is what protects the schedule.

VerseFlow's `js/bridge.js` already solves the hard parts. Port it; do not re-derive it.

## Steps

1. Folder layout per [03 §5](../03-architecture.md): `panel/CSXS/manifest.xml`, `panel/.debug`,
   `index.html`, `css/style.css`, `js/`, `jsx/`.
2. Vendor `CSInterface.js` from Adobe, as VerseFlow does.
3. Manifest with bundle id `com.versesync.panel` and a new debug port (not VerseFlow's, so both
   can be installed side by side).
4. Port VerseFlow's `bridge.js`, keeping **both** hard-won details:
   - the explicit **`loadJSX()`** call at init, which `$.evalFile()`s the host and bypasses
     Premiere's `ScriptPath` cache — that cache can otherwise serve a stale host script
   - the **`EvalScript error.` sentinel** handling, since `evalScript` reports failures via that
     string rather than an exception
5. Wrap every call as a promise resolving `{ok, data}` / `{ok, error}`, parsing the host's JSON
   string. **The bridge never throws** — the host cannot throw across the boundary, so the panel
   must not pretend it can.
6. Wire the T-39 stub: when `CSInterface` is absent (or `?stub=1`), route `VS.*` to the stub.
   **Never activate it inside Premiere.**

## Files

- `panel/CSXS/manifest.xml`, `panel/.debug`, `panel/index.html`, `panel/css/style.css`
- `panel/js/lib/CSInterface.js`, `panel/js/bridge.js`, `panel/js/main.js`

## Done when

- [ ] The panel loads in Premiere (Window ▸ Extensions ▸ VerseSync) and `VS.ping` returns.
- [ ] The panel loads in Chrome against the stub and `VS.ping` returns.
- [ ] `loadJSX()` is called at init and a stale-script scenario is handled.
- [ ] A host error surfaces as `{ok:false,error}`, never an exception.

## Traps

- Do not add a bundler or a framework. Premiere loads these files directly, and VerseFlow's
  vanilla approach is what keeps the two panels mutually readable.
- Panel JS must stay **ES5-compatible** — CEP's Chromium is old. ESLint enforces this (T-40).
- Use a different debug port from VerseFlow, or the two panels will fight.

## Status

- **Deferred — needs Premiere.** The panel loads in Premiere (Window ▸ Extensions ▸ VerseSync) and
  `VS.ping` returns. Steps: copy `panel/` to `%APPDATA%\Adobe\CEP\extensions\com.versesync.panel`
  with `PlayerDebugMode` enabled for CSXS 11, restart Premiere, open the panel. The panel shows
  "Host connected (host, v…)" once `jsx/VerseSync.jsx` exists (delivered by T-23; until then the
  status line reports the `$.evalFile` failure). Remote debugging is on port 7779.
- **Met** — The panel loads in Chrome against the stub and `VS.ping` returns. Headless Chromium
  opening `panel/index.html` shows "Host connected (stub, v1.0.0)"; all seven `VS.*` calls
  answer through `VSBridge`. Covered in code by `tests/bridge.test.js` (stub routing) and
  `tests/host-stub.test.js` (activation).
- **Met** — `loadJSX()` is called at init and a stale-script scenario is handled.
  `panel/js/bridge.js`, `panel/js/main.js`; `tests/bridge.test.js` ("stale script", "called
  once", "failing $.evalFile ... retried").
- **Met** — A host error surfaces as `{ok:false,error}`, never an exception.
  `tests/bridge.test.js` (host error, `EvalScript error.` sentinel, non-JSON, empty reply,
  unserialisable arguments).
