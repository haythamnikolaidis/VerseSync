# T-36 · Install and documentation

| | |
|---|---|
| **Workstream** | H — Quality |
| **Unblocks** | release |
| **Spec** | [06 §5](../06-bible-text-service.md) · [02 §2.1](../02-source-project-audit.md) · `reference/verseflow/README.md` · `reference/fwt/install.py` |

## Goal

A clean Windows workstation goes from nothing to a completed Journey A using **only the README**.

## Context

Risk R-9 is that the two-process design strands a non-technical user. The install has to be one
command for each part. The agent writes the installers and the documentation, and tests them
with **dry-run and fake-filesystem modes**. Proving it on a clean machine is T-36.H.

## Subtasks

### T-36.1 · Sidecar installer

**Executor** agent · **Size** S · **Prereqs** T-07.2, T-44 · **Status** done

- **Read:** `reference/fwt/install.py` (the pinned-wheel pattern) · [02 §2.1](../02-source-project-audit.md)
- **Touches:** `install.py` (new) · `tests/test_install.py` (new)
- **Steps:**
  1. Port the **pinned-wheel pattern**. It detects the Python version (cp311, cp312 or cp313)
     and a GPU (`nvidia-smi` present), picks GPU or CPU torch and the CUDA runtime pins, creates
     `%LOCALAPPDATA%\VerseSync\venv`, and installs `versesync[transcribe]`. Every subprocess
     call goes through one `run(cmd)` function, and `--dry-run` prints the commands instead of
     running them. Commit.
  2. Tests use `--dry-run`, with the GPU check mocked: the GPU and CPU command lists differ as
     expected, and an unsupported Python exits with a clear message. Commit.
- **Verify:** `pytest tests/test_install.py -q`
- **Done when:**
  - [x] GPU and CPU-only paths are both covered by dry-run tests.

### T-36.2 · Panel installer

**Executor** agent · **Size** XS · **Prereqs** T-22.1 · **Status** done

- **Read:** `reference/verseflow/README.md` (the debug-mode install section)
- **Touches:** `tools/install_panel.ps1` (new) · `tools/install_panel.reg` (new) ·
  `tests/test_install_panel.py` (new)
- **Steps:**
  1. Write `install_panel.reg`, which sets `PlayerDebugMode` for CSXS.11 and CSXS.12. Write
     `install_panel.ps1`, which imports the `.reg` file and copies `panel/` to
     `%APPDATA%\Adobe\CEP\extensions\VerseSync`, excluding `js/lib/host-stub.js`. It is
     idempotent.

     Write a test that parses the `.reg` file for both keys, and checks that the `.ps1` script
     references the right paths and excludes the stub. Commit.
- **Verify:** `pytest tests/test_install_panel.py -q`
- **Done when:**
  - [x] Both CSXS versions are covered.
  - [x] The stub is never deployed.

### T-36.3 · README and INSTALL

**Executor** agent · **Size** S · **Prereqs** T-36.1, T-36.2, T-35.1, T-32.1 · **Status** in-progress

- **Read:** [06 §5](../06-bible-text-service.md) · `docs/qa/error-reproduction.md` ·
  `docs/qa/performance-results.md`
- **Touches:** `README.md` · `docs/INSTALL.md` (new)
- **Steps:**
  1. Write `docs/INSTALL.md`. It covers both installs from start to finish, the config file and
     **every** option (generated from `config.py`'s defaults, with a small script or by hand),
     and **where the credentials go**. Commit.
  2. Add these sections to `README.md`:
     - **licensing obligations**, with the attribution for each translation;
     - the **privacy statement**: transcription is entirely local, and the only outbound
       traffic is verse *references*;
     - measured performance, with the machine spec next to it, or a "pending T-35.H" note;
     - **troubleshooting** for each row of `error-reproduction.md`, with the log path.

     Commit.
- **Verify:** `grep -c "Troubleshooting\|Privacy\|Licensing" README.md`
- **Done when:**
  - [ ] Every config option and every failure state is documented.
  - [ ] The documentation describes what the code actually does.

### T-36.H · Clean-machine install

**Executor** human · **Size** — · **Prereqs** T-36.3, T-35.H · **Status** todo

On a **genuinely clean** Windows machine (no Python, no CUDA, no Adobe extensions), follow only
the README through a full Journey A. Fix the documentation wherever it's wrong.

## Traps

- "Clean machine" means clean. The CUDA path is exactly where installs break.
- Attribution is a **licensing obligation**, not polish.
