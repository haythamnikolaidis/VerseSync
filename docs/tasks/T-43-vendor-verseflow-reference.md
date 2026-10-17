# T-43 · Vendor VerseFlow reference sources

**Executor** agent · **Size** XS · **Prereqs** — · **Status** done

| | |
|---|---|
| **Workstream** | 0 — Agent enablement |
| **Unblocks** | T-14.2, T-18, T-22, T-23, T-25, T-27, T-29.2, T-45 |
| **Spec** | [02-source-project-audit.md Part 1](../02-source-project-audit.md) |

## Goal

Make the VerseFlow code that VerseSync says to "port verbatim" readable inside this repository.
Without it, every port task would need cross-repo access, and an agent would be guessing.

## Context

About a dozen tasks say things like *"port VerseFlow's `bridge.js`"* or *"`_setTextField`
unchanged"* or *"VerseFlow's `duration.js` constants"*. VerseFlow lives in
`haythamnikolaidis/VerseFlow`, which is private. The audit pinned it at commit `aa7b915`
([02](../02-source-project-audit.md) line 9).

## Steps

1. Attach the repo with the `add_repo` tool (owner `haythamnikolaidis`, repo `VerseFlow`,
   read access). Clone it into the scratchpad and check out `aa7b915`. If `aa7b915` doesn't
   exist, use the current `main` and record its SHA instead. **If the repo is unreachable, mark
   the task blocked.** Don't reconstruct the files from memory.
2. Copy these files, unmodified, into `reference/verseflow/`, keeping their relative paths:
   `jsx/VerseFlow.jsx`, `js/bridge.js`, `js/duration.js`, `js/state.js`,
   `js/scripture-parser.js`, `js/lib/CSInterface.js`, `css/style.css`, `CSXS/manifest.xml`,
   `index.html`, `docs/planning/02-adobe-research.md`, and `README.md`. If the layout differs,
   find each file by name and record the real path.
3. Write `reference/README.md`. It records the source repo, the SHA, and the date. It says these
   files are read-only copies that are never deployed, linted or imported, and that ports copy
   code out of them. It also lists every file with a one-line description. Commit:
   `T-43 [1/2] vendor VerseFlow sources`.
4. Exclude `reference/` from lint, by adding it to the ignores in `eslint.config.js` and to
   `extend-exclude` under `[tool.ruff]`. Confirm `npm run lint` and `ruff check sidecar tools
   tests` still pass. Commit: `T-43 [2/2] exclude reference/ from lint`.

## Verify

`ls reference/verseflow/js reference/verseflow/jsx && npm run lint`

## Done when

- [ ] Every file in step 2 is present and byte-identical to the source commit.
- [ ] `reference/README.md` records the repo, the SHA and the file list.
- [ ] Neither linter looks at `reference/`.
