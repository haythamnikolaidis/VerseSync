# Host verification (T-22.H)

Verified by hand on 2026-10-20: Windows 11, unsigned debug-mode install via
`tools/install_panel.ps1` (`PlayerDebugMode=1`, DevTools on port 7781).

| Check | Result |
|---|---|
| Panel opens from Window > Extensions > VerseSync and is interactive | Pass |
| `VS.ping` on startup logs `hostApi "1.1"` (DevTools console) | Pass |
| `typeof require('http').request` in the panel context | `"function"` (D21 holds) |
| `panel/index.html?stub=1` opened from the file system: stub ping works | Pass |

## Findings

- **`VS` is not a panel global in Premiere.** It lives in ExtendScript; the panel reaches it
  through `evalScript`. The check is the `[VerseSync] VS.ping ...` line that `app.start()` logs.
- **The stub needs `?stub=1`.** `index.html` loads `CSInterface.js`, so a plain file open
  looks like CEP and leaves the stub off. Open `panel/index.html?stub=1` in Chrome.
- **Relative `require` breaks in CEP.** Under Premiere's Node, `require('./x.js')` from a
  `<script>` resolves against `index.html`, not `js/`. `setup.js` and `insert.js` required
  `./state.js` first and threw, which stopped `main.js` before the ping. They now prefer the
  `<script>`-loaded global (`root.VSState`) and fall back to `require`.
- **Expected console noise:** `host-stub.js` reports `ERR_FILE_NOT_FOUND` in Premiere because
  the installer deliberately excludes it while `index.html` still references it.

This closes the Wave 0 sub-clause in [13 §5](../13-technical-plan.md).
