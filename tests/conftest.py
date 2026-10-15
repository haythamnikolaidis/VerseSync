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
