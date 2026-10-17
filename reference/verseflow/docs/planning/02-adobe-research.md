# 02 — Adobe Research: Constraints & API Facts

**Read this before writing any host (`.jsx`) code.** These are the load-bearing facts the
architecture depends on, each with a source. Where the API behaves in a surprising way, it
is called out explicitly.

---

## 1. Platform: why CEP + ExtendScript (decision D1)

Adobe has two extensibility platforms:

- **CEP** — HTML/CSS/JS panel + an **ExtendScript** backend. Mature, fully documented,
  and — critically — **able to read and write MOGRT text parameters today**.
- **UXP** — Adobe's newer, go-forward platform (standard in Premiere 2026).

**The deciding fact:** As of mid-2026, multiple developers report that **UXP can locate a
MOGRT's text parameter but cannot reliably read or write its value** — the single capability
this whole plugin is built on. There is also **no `evalScript` bridge from UXP to
ExtendScript** (Adobe removed it for security), so you cannot build a UXP UI that delegates
MOGRT edits to ExtendScript.

Therefore v1 targets **CEP + ExtendScript**, which does the job reliably.

> ⚠️ **Risk R1 (see [09-decisions-and-risks.md](09-decisions-and-risks.md)):** Adobe has
> stated ExtendScript integrations are supported only **through ~September 2026**. This
> plugin will need a UXP re-platform once UXP's MOGRT parameter API works. Keep host logic
> isolated (see architecture) so the future port is contained.

Sources:
- Hyper Brew, "UXP Plugins in Premiere 2026: The CEP Migration Clock Is Ticking" — https://hyperbrew.co/blog/uxp-plugins-in-premiere-2026/
- Adobe CC Developer Forums, "Setting MOGRT text parameters in Premiere UXP?" — https://forums.creativeclouddeveloper.com/t/setting-mogrt-text-parameters-in-premiere-uxp/11969
- Adobe Community, "Why doesn't UXP expose a direct evalScript-like API…" — https://community.adobe.com/questions-712/why-doesn-t-uxp-expose-a-direct-evalscript-like-api-to-run-existing-extendscript-jsx-files-1183642

---

## 2. Inserting a MOGRT onto the timeline

The Sequence object exposes:

```
sequence.importMGT(path, timeInTicks, videoTrackOffset, audioTrackOffset)
```

- Returns a **TrackItem** (the inserted clip) on success.
- `path` — absolute path to the `.mogrt` file.
- `timeInTicks` — insertion point as a **string of ticks** (Premiere time is in ticks).
- `videoTrackOffset` / `audioTrackOffset` — **0-based track offsets** from the bottom track.
- There is also `importMGTFromLibrary(name, time, vOffset, aOffset)` for MOGRTs in the
  user's Creative Cloud Libraries — **not used**; we import from a file path.

**Time is in ticks:** `254016000000` ticks = 1 second. To convert seconds → ticks:
`Math.round(seconds * 254016000000).toString()`. Get a sequence's current playhead via
`sequence.getPlayerPosition()` which returns a **Time** object whose `.ticks` is a string.

Sources:
- Premiere Pro Scripting Guide — Sequence object — https://ppro-scripting.docsforadobe.dev/sequence/sequence/
- Adobe-CEP PProPanel sample (`Premiere.jsx`) — https://github.com/Adobe-CEP/Samples/blob/master/PProPanel/jsx/PPRO/Premiere.jsx

---

## 3. Reading & writing MOGRT parameters (the core trick)

After `importMGT` returns a `TrackItem`, get its Motion Graphics component:

```javascript
var clip = sequence.importMGT(path, ticks, 0, 0);   // TrackItem
var mgt  = clip.getMGTComponent();                  // the MOGRT's component
var props = mgt.properties;                          // collection of ComponentParam
```

**Enumerating fields (for the dropdowns):** iterate the properties collection to list the
editable parameter **display names**. In practice:

```javascript
var names = [];
for (var i = 0; i < props.numItems; i++) {
    names.push(props[i].displayName);   // e.g. "Source Text", "Reference"
}
```

(Exact iteration surface — `numItems` + index access vs. a `getItemAt(i)` accessor — must
be confirmed on the target Premiere version; see task T-05. Both patterns appear in the
wild.)

**Writing a text field** — text params are **JSON-encoded**. You must parse, set the text,
**and set `fontTextRunLength`**, then stringify back:

```javascript
var param = mgt.properties.getParamForDisplayName("Source Text");
var data  = JSON.parse(param.getValue());
data.textEditValue    = "John 10:10 (NKJV) ...";
data.fontTextRunLength = [data.textEditValue.length];  // REQUIRED, else text is truncated/ignored
param.setValue(JSON.stringify(data), true);            // 2nd arg = update UI
```

> ⚠️ **Gotcha:** Forgetting `fontTextRunLength` is the #1 reason MOGRT text updates silently
> fail. It must match the new string length.

> ⚠️ **Gotcha:** This JSON shape only applies to **AE-authored** text parameters. Premiere
> "Type tool" graphics saved as MOGRTs behave differently and are **not supported** in v1.

Sources:
- Adobe Community, "Premiere Pro ExtendScript changing the text of a MOGRT" — https://community.adobe.com/t5/premiere-pro-discussions/premiere-pro-extendscript-changing-the-text-of-a-mogrt/td-p/14786120
- Adobe Community, "Extendscript: Modifying MOGRT Text Using CEP Panel" — https://community.adobe.com/t5/premiere-pro/extendscript-modifying-mogrt-text-using-cep-panel/m-p/11186245

---

## 4. Discovering MOGRT fields **without** polluting the timeline

The dropdowns (FR-3) need the field list **before** the user inserts anything. Two viable
approaches — this is an internal design choice, recommendation given:

- **A (recommended): Insert-to-scratch-and-enumerate.** On MOGRT selection, insert one
  instance far past the end of the active sequence (or into a throwaway temp sequence),
  read `mgt.properties` display names, then delete that instance. Robust because it uses
  the same API path as the real insert. Downside: momentary timeline write (mitigated by
  doing it inside an undo group that is immediately undone, or in a temp sequence).
- **B: Parse the `.mogrt` as a ZIP.** A `.mogrt` is a ZIP archive containing a JSON
  definition of its controls. Reading it gives field names with **no** timeline write.
  Downside: the internal format is undocumented and can vary by After Effects version —
  fragile. Consider only as an optimization later.

**Decision:** Build **A**. Note the field list can be **cached per MOGRT path** so it is
discovered once per session.

> ⚠️ **Duplicate display names (confirmed in the client's template).** `AV_Quote_04.mogrt`
> exposes **two editable text fields both named "Text"** (see
> [10-template-reference.md](10-template-reference.md)). Enumerate and target fields by their
> **index** in the properties collection, and present group-qualified labels
> ("Title Main ▸ Text") in the UI. Do **not** rely on `getParamForDisplayName` for names that
> may repeat.

---

## 5. Setting the clip's length on the timeline

`importMGT` places the clip at its template's native duration. To honor FR-4 durations,
after insert adjust the track item's out-point / end so its duration matches the target.
Two mechanisms exist; confirm which is available and reliable on target version (task T-08):

- Set `trackItem.end` to `start + targetTicks` (Time objects), and/or
- Adjust via `trackItem.outPoint`.

MOGRTs are graphics, not trailed media, so trimming/extending duration is generally safe.
**Validate on a real template** that extending beyond native length holds the last frame
(expected behavior for MOGRTs) rather than showing black.

Source: Premiere Pro Scripting Guide — TrackItem — https://ppro-scripting.docsforadobe.dev/

---

## 6. Reading the scripture `.txt` from the panel

CEP panels can read local files two ways:
- **`window.cep.fs`** — CEP's built-in synchronous file API (`readFile`), always available.
- **Node.js `fs`** — available if the manifest enables Node (`--enable-nodejs` /
  `CEFCommandLine`). Handy but not required for a single small read.

**Decision:** Use `window.cep.fs.readFile(path)` for the scripture file — no Node dependency,
simplest. File **paths** come from a native picker (ExtendScript `File.openDialog()` or the
CEP file-open API).

Source: Adobe CEP cookbook / `CSInterface.js` — https://github.com/Adobe-CEP/CEP-Resources

---

## 7. Preview: why HTML/CSS mock (decision D2)

**There is no Adobe API that renders a MOGRT to an image outside the timeline.** A truly
accurate preview would require inserting the MOGRT and exporting a frame via the encoder
(slow, complex). Per decision D2, v1 renders an **HTML/CSS approximation** in the panel —
same text content and a lower-third-like layout, not pixel-accurate. This is honest to the
user (label it "Approximate preview") and instant. Spec in [05-ui-spec.md](05-ui-spec.md).

---

## 8. Undo grouping

Wrap the whole batch insert so a single undo reverts everything:

```javascript
app.beginUndoGroup ? app.beginUndoGroup("VerseFlow: Insert scriptures") : null;
// ... all imports/edits ...
app.endUndoGroup ? app.endUndoGroup() : null;
```

Confirm these exist on the target Premiere (task T-08); if not, document that undo is
per-clip. (Premiere's ExtendScript undo-group support is less complete than After Effects';
verify empirically.)

---

## 9. Debugging CEP (how the dev will actually work)

- Enable "unsigned/debug" extensions via the CSXS `PlayerDebugMode` registry key (Win) /
  plist (mac). See task T-01.
- Add a `.debug` file to the extension to open a remote-debug port; inspect the panel with
  Chrome at `localhost:<port>`.
- ExtendScript can be debugged with the ExtendScript Debugger VS Code extension, or with
  `$.writeln` / alert-style logging to a log file.

Source: Adobe-CEP resources & getting-started — https://github.com/Adobe-CEP/Getting-Started-guides

---

## Fact sheet (quick reference)

| Thing | Value / Call |
|-------|--------------|
| Ticks per second | `254016000000` |
| Insert a MOGRT | `sequence.importMGT(path, ticks, vOffset, aOffset)` → TrackItem |
| Playhead time | `sequence.getPlayerPosition()` → Time (`.ticks`) |
| Get MOGRT component | `trackItem.getMGTComponent()` |
| Field list | iterate `mgt.properties` → `.displayName` |
| Get a field | `mgt.properties.getParamForDisplayName(name)` |
| Read/write text | JSON: set `textEditValue` + `fontTextRunLength`, then `setValue(json, true)` |
| Active sequence | `app.project.activeSequence` |
| Read scripture file | `window.cep.fs.readFile(path)` |
| Run JSX from panel | `csInterface.evalScript("fnName(args)", callback)` |
