# Installing VerseSync

VerseSync has two parts, and each installs with one command:

1. the **sidecar**, a local Python service that transcribes, detects references and fetches
   verse text (`install.py`);
2. the **panel**, the Premiere Pro extension (`tools/install_panel.ps1`).

Target: Windows, Adobe Premiere Pro 2026, unsigned debug-mode install. Everything below is run
from the root of a VerseSync checkout.

## Before you start

| Need | Why |
|---|---|
| Python 3.11, 3.12 or 3.13 (64-bit) | `install.py` picks the PyTorch wheel by Python version and exits with a message on any other version. |
| Git on `PATH` | The transcription engine is installed from a Git URL pinned in `pyproject.toml`. |
| An NVIDIA driver (optional) | With `nvidia-smi` on `PATH` the installer picks the CUDA 12.8 wheels; without it, the CPU wheel. |

The upstream transcription engine (Faster-Whisper-Transcriber) is installed from
`haythamnikolaidis/Faster-Whisper-Transcriber`, at the commit on its `main` branch that made the
repo pip-installable (it packages `core/` via a minimal `pyproject.toml`). `pyproject.toml` pins
it by commit (`54ede6af030f449f240a47f6328ef5b1b0680b6b`), so pip fetches exactly that commit.
You do not check the repository out yourself.

## 1. Install the sidecar

```
python install.py --venv "%APPDATA%\VerseSync\venv"
```

The installer:

1. detects the Python tag (`cp311`, `cp312` or `cp313`);
2. detects a GPU (`nvidia-smi` present and exiting cleanly), unless you force one;
3. creates the virtual environment;
4. upgrades `pip`, `setuptools` and `wheel` inside it;
5. installs the pinned PyTorch wheel (GPU: the `cu128` wheel plus the pinned `nvidia-cuda-*`,
   `nvidia-cublas` and `nvidia-cudnn` packages; CPU: the `cpu` wheel). Each wheel URL carries a
   `#sha256=` fragment that pip verifies;
6. installs `versesync[transcribe]` from the checkout.

Options:

| Option | Effect |
|---|---|
| `--dry-run` | Print every command, run nothing. |
| `--cpu` / `--gpu` | Force the CPU or CUDA wheel instead of detecting (mutually exclusive). |
| `--venv PATH` | Where to create the virtual environment. |

**Use `--venv "%APPDATA%\VerseSync\venv"`.** Without `--venv`, `install.py` uses
`%LOCALAPPDATA%\VerseSync\venv`, but the panel starts the sidecar from
`%APPDATA%\VerseSync\venv\Scripts\pythonw.exe` (or `%VERSESYNC_HOME%\venv\...` when
`VERSESYNC_HOME` is set), so a venv elsewhere is never found.

Run `python install.py --dry-run` first to see the exact commands. A failed command prints
`Install failed: ...` and exits 1; an unsupported Python exits 2.

You do not start the sidecar yourself. The panel launches it on demand and the sidecar stops
itself after `server.idle_exit_s` seconds without requests or jobs (see below). To run it by
hand: `python -m versesync.sidecar [--port N] [--config FILE]` from the venv.

## 2. Install the panel

```
powershell -ExecutionPolicy Bypass -File tools\install_panel.ps1
```

The script:

1. imports `tools\install_panel.reg`, which sets `PlayerDebugMode` to `1` under
   `HKEY_CURRENT_USER\Software\Adobe\CSXS.11` and `CSXS.12` (so Premiere loads an unsigned
   extension);
2. deletes and recreates `%APPDATA%\Adobe\CEP\extensions\VerseSync`;
3. copies `panel\` into it, leaving out `js\lib\host-stub.js` (the development host stub is
   never deployed).

It is safe to run again. Restart Premiere Pro afterwards, then open **Window > Extensions >
VerseSync**.

## Where things live

`%APPDATA%\VerseSync` is the app home. Set `VERSESYNC_HOME` to use another folder.

| Path (under the app home) | Holds |
|---|---|
| `config.yaml` | Your settings (optional, see below). |
| `venv\` | The sidecar's virtual environment, if you used the command above. |
| `sidecar.json` | The lock file: pid, loopback port and this launch's access token. |
| `logs\sidecar.log` | The log. 1 MiB per file, three rotated backups. |
| `cache\` | Cached transcripts. |
| `jobs\<id>\` | One folder per analysis, holding its result. |

## Configuration

The sidecar starts from built-in defaults, overlays `%APPDATA%\VerseSync\config.yaml`, then the
file given by `--config`. Nested tables merge, so you only write what you change. A config file
that is not a YAML mapping stops the sidecar with `cannot load config` and the log path.

```yaml
transcription:
  model: large-v3-turbo
  device: cpu
server:
  allowed_media_roots:
    - D:\Sermons
```

### `transcription`

| Option | Default | Meaning |
|---|---|---|
| `backend` | `faster_whisper` | Transcription backend. |
| `model` | `distil-large-v3` | Whisper model name. |
| `device` | `cuda` | `cuda` or `cpu`. |
| `quantization` | `float16` | Compute type. |
| `batch_size` | `8` | Batch size for batched inference. |
| `language` | `en` | Spoken language. |
| `vad_filter` | `true` | Skip silence with voice-activity detection. |
| `vad_parameters` | none | Extra VAD settings (a mapping). |
| `condition_on_previous_text` | `true` | Feed earlier text to the decoder. |
| `temperature` | `0.0` | Decoding temperature. |

`initial_prompt` is also accepted; its default is the scripture-names prompt built into the
sidecar. Any other key in this section that is not a transcription option is ignored.

### `detection`

Empty by default. It accepts `max_range` (default `30`, the longest verse range a reference may
cover) and `duplicate_cooldown_s` (default `60`, also settable under `timing`).

### `timing`

| Option | Default | Meaning |
|---|---|---|
| `lead_in_s` | `0.5` | Seconds a cue starts before the speaker. |
| `tail_pad_s` | `1.0` | Seconds a cue stays after the speaker stops. |
| `duration_mode` | `auto` | How cue length is chosen. |
| `fixed_duration_s` | `8.0` | Length when the mode is fixed. |
| `min_duration_s` | `3.0` | Shortest cue. |
| `max_duration_s` | `20.0` | Longest cue. |
| `max_read_duration_s` | `45.0` | Longest cue for a passage the speaker reads aloud. |
| `min_visible_s` | `2.0` | Shortest time a cue stays on screen. |
| `overlap_gap_s` | `0.25` | Gap kept between consecutive cues. |
| `read_coverage_threshold` | `0.55` | Share of a passage that must be heard before it counts as read. |
| `duplicate_cooldown_s` | `60` | Seconds before the same reference may be placed again. |

### `bible`

| Option | Default | Meaning |
|---|---|---|
| `default_translation` | `kjv` | Translation preselected for an analysis. |
| `max_verses_per_passage` | `6` | Longest passage placed as one cue. |
| `provider` | `api_bible` | See the note below. |
| `api_bible.api_key_env` | `VERSESYNC_API_BIBLE_KEY` | Name of the environment variable that holds the API.Bible key. |
| `api_bible.base_url` | `https://api.scripture.api.bible/v1` | API.Bible endpoint. |
| `api_bible.timeout_s` | `10` | Request timeout. |
| `api_bible.max_retries` | `2` | Retries per request. |
| `local.store_path` | `%APPDATA%/VerseSync/bibles` | Folder for imported Bible stores. |
| `cache_enabled` | `true` | Verse cache switch. |

**What the sidecar uses today.** The sidecar in this repository starts with the local provider
only, which serves the bundled King James Version and makes no network requests.
`default_translation` and `max_verses_per_passage` are read; `provider`, `api_bible.*`,
`local.store_path` and `cache_enabled` are accepted and kept in the configuration but nothing
at start-up reads them yet. The API.Bible provider class exists in
`sidecar/versesync/bible/api_bible.py` but is not selected by the launcher.

### `server`

| Option | Default | Meaning |
|---|---|---|
| `idle_exit_s` | `1800` | Seconds with no requests and no running jobs before the sidecar exits. `0` disables it. |
| `allowed_origins` | `["cep://com.versesync.panel"]` | Origins the sidecar accepts. |
| `allowed_media_roots` | `[]` | Folders media may be read from. A media file outside them is refused. |
| `estimate_factor` | `cuda: 0.05, cpu: 0.5, default: 0.5` | Seconds of processing per second of media, per device, used only for the time estimate shown when an analysis starts. |

## Where the credentials go

Credentials never go in `config.yaml`, the Cue Document or the log. The configuration holds the
**name** of an environment variable (`bible.api_bible.api_key_env`), and the key is read from
that variable when needed. To use the default name, set it for your Windows user:

```
setx VERSESYNC_API_BIBLE_KEY "your-key"
```

then restart Premiere Pro so the sidecar it launches inherits the variable. The bundled KJV
needs no key. The sidecar also holds no login of its own: each launch generates a random
access token that is written only to `sidecar.json`, which the panel reads.

## Check the install

```
%APPDATA%\VerseSync\venv\Scripts\python.exe -m versesync.sidecar
```

prints `VERSESYNC_READY port=<n>` when the service is up (stop it with Ctrl+C). If it does not,
read `%APPDATA%\VerseSync\logs\sidecar.log`.
