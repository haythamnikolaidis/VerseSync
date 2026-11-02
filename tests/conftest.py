import shutil
import sys
from pathlib import Path

import pytest

from versesync.detect.canon import Canon, load_canon

TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))


@pytest.fixture(scope="session")
def canon() -> Canon:
    return load_canon()


# bible.provider defaults to api_bible, so every test home carries this config.yaml. It keeps
# the suite offline (the bundled KJV needs no key or network) and keeps default_translation
# on the one translation the local provider serves. Subprocesses launched by a test read it
# through VERSESYNC_HOME, the same way the CLI and sidecar read it in-process.
OFFLINE_CONFIG = "bible:\n  provider: local\n  default_translation: kjv\n"

API_KEY_ENV = "VERSESYNC_API_BIBLE_KEY"


@pytest.fixture(autouse=True)
def app_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point VERSESYNC_HOME at a per-test directory whose config.yaml keeps Bible text offline.

    Autouse, so a test that never asks for it still cannot read the developer's own config or
    reach the network. The API key is removed from the environment for the same reason: a key
    in the real environment must not change any result.
    """
    monkeypatch.delenv(API_KEY_ENV, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(OFFLINE_CONFIG, encoding="utf-8")
    monkeypatch.setenv("VERSESYNC_HOME", str(home))
    return home


@pytest.fixture
def bare_home(app_home: Path) -> Path:
    """The same per-test home with nothing in it, so load_config() returns the built-in defaults.

    For tests of the configuration itself and of the API.Bible default. The directory does not
    exist yet, as before app_home was given a config file.
    """
    shutil.rmtree(app_home)
    return app_home
