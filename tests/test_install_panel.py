"""T-36.2: panel installer files reference the right keys, paths and exclusions."""

import re
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"


def _reg_text() -> str:
    return (TOOLS / "install_panel.reg").read_text(encoding="utf-8")


def test_reg_sets_debug_mode_for_csxs_11_and_12() -> None:
    text = _reg_text()
    assert text.startswith("Windows Registry Editor Version 5.00")
    for version in ("11", "12"):
        pattern = (
            r"\[HKEY_CURRENT_USER\\Software\\Adobe\\CSXS\." + version + r"\]\s*\r?\n"
            r'"PlayerDebugMode"="1"'
        )
        assert re.search(pattern, text), version


def test_ps1_imports_reg_and_targets_cep_extensions() -> None:
    ps1 = (TOOLS / "install_panel.ps1").read_text(encoding="utf-8")
    assert "install_panel.reg" in ps1
    assert "reg import" in ps1
    assert "$env:APPDATA" in ps1
    assert r"Adobe\CEP\extensions\VerseSync" in ps1
    assert "'panel'" in ps1


def test_ps1_never_deploys_host_stub() -> None:
    ps1 = (TOOLS / "install_panel.ps1").read_text(encoding="utf-8")
    assert r"js\lib\host-stub.js" in ps1
    assert "excludedFiles -contains" in ps1


def test_ps1_is_idempotent_by_replacing_destination() -> None:
    ps1 = (TOOLS / "install_panel.ps1").read_text(encoding="utf-8")
    assert "Remove-Item -Recurse -Force $destination" in ps1
