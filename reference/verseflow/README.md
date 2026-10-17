# VerseFlow

A powerful Adobe Premiere Pro plugin that automates the insertion of scripture graphics into video timelines.

## What It Does

VerseFlow is a CEP panel extension for **Adobe Premiere Pro 2026** that:
- Reads scripture data from a plain-text `.txt` file
- Maps each scripture to a Motion Graphics Template (`.mogrt`)
- Automatically inserts one graphic instance per scripture onto your timeline
- Computes clip durations based on reading speed or lets you set a fixed duration
- Displays a live preview of how your scriptures will look

**Perfect for:** Creating scripture-based video content with consistent, professional motion graphics.

**Target:** Premiere Pro 2026 · Windows only · Internal distribution (unsigned, debug-mode install)

---

## Quick Start

### 1. Enable Debug Mode (Windows)
Run the following in an elevated Command Prompt:
```
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

### 2. Copy the Extension
Copy the `VerseFlow` folder to:
```
%APPDATA%\Adobe\CEP\extensions\VerseFlow
```

### 3. Launch Premiere and Open the Panel
1. Open Adobe Premiere Pro 2026
2. Go to **Window ▸ Extensions ▸ VerseFlow**
3. Start using the panel!

---

## Full Installation (Windows, debug-mode)

### Step 1 — Enable unsigned extensions

Open **Registry Editor** (`regedit.exe`) and set:

```
HKEY_CURRENT_USER\Software\Adobe\CSXS.11
  PlayerDebugMode = 1   (REG_SZ)
```

If `CSXS.11` doesn't exist, create it. If Premiere 2026 uses CSXS 12, repeat for `CSXS.12`.

> **Tip:** Run the one-liner from an elevated cmd prompt:
> ```
> reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
> reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
> ```

### Step 2 — Copy the extension folder

Copy this entire `VerseFlow` folder to the CEP extensions directory:

```
%APPDATA%\Adobe\CEP\extensions\VerseFlow
```

So the final path should be:
```
%APPDATA%\Adobe\CEP\extensions\VerseFlow\CSXS\manifest.xml
%APPDATA%\Adobe\CEP\extensions\VerseFlow\index.html
... etc
```

### Step 3 — Add the MOGRT template

Place your `AV_Quote_04.mogrt` (or any AE-authored MOGRT) somewhere accessible on disk. You'll select it from within the panel.

For development/testing, you may also place it at `assets/test/AV_Quote_04.mogrt`.

### Step 4 — Launch Premiere and open the panel

1. Launch Premiere Pro 2026.
2. Go to **Window ▸ Extensions ▸ VerseFlow**.
3. The VerseFlow panel should appear.

---

## Developer setup (remote debug)

The `.debug` file exposes port **7778**. With the panel open in Premiere, navigate to:

```
chrome://inspect  (in Chrome)
```

Or open Chrome and go to `http://localhost:7778` to see the CEP DevTools target.

For ExtendScript debugging, use the **ExtendScript Debugger** VS Code extension and attach to Premiere Pro.

---

## Usage

1. **Select MOGRT** — pick your `.mogrt` template. VerseFlow reads its editable text fields automatically. Requires an open sequence.
2. **Select scripture file** — pick a `.txt` file in the [expected format](#scripture-file-format). The number of scriptures found is shown.
3. **Field mapping** — assign which template field gets the scripture reference line and which gets the scripture body text. Smart defaults are applied based on group names.
4. **Duration** — choose Auto (computed from reading speed) or Fixed (enter seconds).
5. **Target track** — choose which video track to insert onto. Click **Refresh** if you just opened a sequence.
6. **Preview** — the panel shows an approximate lower-third preview of the first scripture.
7. **Insert** — click **Insert N scriptures**. All scriptures are placed back-to-back from the playhead. A single Ctrl+Z removes the whole batch.

---

## Scripture file format

Plain UTF-8 `.txt` file. Each scripture entry is:

```
<Reference line>
<verse body lines>
<blank line>
```

**Example:**

```
1 Corinthians 6:19-20 (NKJV)
19 Or do you not know that your body is the temple of the Holy Spirit who is in you, whom you have from God, and you are not your own?
20 For you were bought at a price; therefore glorify God in your body and in your spirit, which are God's.

Job 33:4 (NKJV)
4 The Spirit of God has made me, and the breath of the Almighty gives me life.
```

Rules:
- Reference line must end with a translation in parentheses, e.g. `(NKJV)`.
- Book names starting with a digit are supported: `1 Corinthians`, `1 Kings`.
- Verse ranges are supported: `1 Corinthians 6:19-20`.
- The same reference with different translations counts as two separate entries.
- Blank/whitespace-only lines act as separators.

See `assets/sample-scriptures.txt` for a 10-scripture example file.

---

## Duration model

When **Auto** is selected, each clip's duration is computed as:

```
readingSeconds = (wordCount / 160) × 60
raw            = readingSeconds + 1.5   (animation padding)
duration       = clamp(round(raw, 0.1), 3s, 20s)
```

Constants can be tuned in `js/duration.js`.

---

## Project structure

```
VerseFlow/
├── CSXS/manifest.xml       CEP manifest
├── .debug                  Remote-debug port config
├── index.html              Panel markup
├── css/style.css           Panel + preview styles
├── js/
│   ├── lib/CSInterface.js  Adobe bridge library (vendored)
│   ├── bridge.js           Promisified evalScript wrapper
│   ├── scripture-parser.js .txt → Scripture[] parser
│   ├── duration.js         Duration model and ticks helpers
│   ├── state.js            In-memory state + localStorage persistence
│   └── main.js             UI wiring and insert orchestration
├── jsx/
│   ├── VerseFlow.jsx       ExtendScript entry; defines VF namespace
│   └── modules/
│       ├── util.jsx        Ticks helpers, JSON response wrappers
│       └── mogrt.jsx       MOGRT field discovery, insert, set text/duration
├── assets/
│   └── sample-scriptures.txt  10-scripture sample for testing
└── docs/planning/          Technical planning package
```

---

## Technical notes

- **CEP + ExtendScript** — the only stack that can reliably read/write AE-authored MOGRT text parameters as of mid-2026. Adobe's UXP platform does not yet support MOGRT text writes.
- **Field discovery** — VerseFlow inserts a scratch MOGRT clip, reads its properties, then removes the clip (wrapped in an undo group). Requires an open sequence.
- **Duplicate field names** — the reference template `AV_Quote_04.mogrt` has two fields both named "Text". VerseFlow targets fields by their stable index, never by name, to handle this correctly.
- **Undo** — the entire batch is wrapped in a single undo group; one Ctrl+Z removes all inserted clips.
- **Ticks** — Premiere's internal time unit. 254,016,000,000 ticks = 1 second.

---

## Planned limitations (v1)

- Windows + Premiere Pro 2026 only.
- AE-authored MOGRTs only (Premiere "Type tool" MOGRTs are not supported).
- Field discovery requires an open sequence.
- Preview is an HTML/CSS approximation, not a pixel-accurate render.
- One `.mogrt` template per run.
- No editing or removing already-inserted graphics.
