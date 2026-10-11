# Contributing

Conventions (branching, contract-change protocol, code style) live in
[`docs/13-technical-plan.md` §8](docs/13-technical-plan.md). Read it before opening a PR.

## Running the checks locally

Python (`sidecar/`):

```
python -m venv .venv && .venv/Scripts/activate   # or .venv/bin/activate on macOS/Linux
pip install -e ".[dev]"
ruff check sidecar
mypy
pytest
```

JavaScript (`panel/js/`):

```
npm install
npm run lint
npm test
```

No bundler, no transpiler — the panel is loaded by Premiere as plain ES5-compatible files.
