# T-49 · Panel smoke harness (headless Chromium)

**Executor** agent · **Size** S · **Prereqs** T-22.2, T-26.1 · **Status** in-progress

| | |
|---|---|
| **Workstream** | F — Panel (agent enablement) |
| **Unblocks** | visual and console verification for T-27 through T-30 |
| **Spec** | [09-ui-spec.md §1](../09-ui-spec.md) |

## Goal

Give the agent eyes. One command loads the real `panel/index.html` in headless Chromium, in stub
mode, and fails on any console error. It also saves a screenshot the agent can look at.

## Context

Unit tests under jsdom prove logic, but they don't prove that the page renders. The container
has Chromium pre-installed (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). Without Node, a browser
page can't use the D21 Node transport, so in a plain browser `sidecar.js` uses a **stub
transport**. That transport answers from the T-37 golden fixtures, which a small static server
serves over HTTP from the repo root, so it's same-origin with no CORS involved.

## Read

[09 §1](../09-ui-spec.md) · the `VSSidecarClient` transport interface in
[T-26](T-26-panel-sidecar-client.md)

## Touches

`package.json` (add `playwright-core` to devDependencies, and a `smoke` script) ·
`tools/panel_smoke.js` (new) · `panel/js/lib/sidecar-stub.js` (new) · `.gitignore` (add
`artifacts/`)

## Steps

1. Write `panel/js/lib/sidecar-stub.js`. It's a transport with the same interface as T-26.1's
   Node transport.
   - `?scenario=happy|flagged|alternatives|empty` picks which fixture to serve, fetched from
     `/tests/fixtures/cue-documents/<name>-*.json`.
   - Jobs finish after a simulated 2 s of progress events.
   - `main.js` uses it only when `typeof require === 'undefined'`.

   Commit: `T-49 [1/2] sidecar stub transport`.
2. Write `tools/panel_smoke.js`:
   - start an `http` static server on the repo root;
   - launch Chromium with `playwright-core`, trying `chromium.launch()` first and falling back
     to the first `/opt/pw-browsers/chromium-*/chrome-linux/chrome`;
   - open `/panel/index.html?stub=1&scenario=<s>` for each scenario;
   - wait for `#status`;
   - collect console errors and page errors;
   - save `artifacts/smoke-<scenario>.png`;
   - exit non-zero on any error.

   Optional assertions can be passed per run, for example
   `--expect '#review .row' --count 18`.

   Add `"smoke": "node tools/panel_smoke.js"`. It is **not** part of `npm test` or CI.
   Commit: `T-49 [2/2] smoke harness`.

## Verify

`npm run smoke` (exits 0 and writes 4 screenshots)

## Done when

- [ ] `npm run smoke` runs headless in the container, writes the screenshots, and fails on an
      injected `console.error`.
- [ ] Later panel tasks can add selector or count expectations without editing the harness.
