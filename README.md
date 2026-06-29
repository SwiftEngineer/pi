# SwiftEngineer Pi Harness

This repository contains the `@swiftengineer/pi-harness` Pi extension package. It registers additional Pi tools, TUI components, prompt/policy behavior, patch scripts, and a titanium theme.

## Documentation

Current-state repository documentation lives in `docs/`:

- [Architecture](docs/architecture.md)
- [Tools and commands](docs/tools.md)
- [TUI and sub-agents](docs/ui-and-subagents.md)
- [Installation, update, and patching](docs/install-update.md)
- [Verification and developer workflow](docs/verification.md)

Review suggestions from the delegated codebase exploration are tracked separately in [REVIEW_SUGGESTIONS.md](REVIEW_SUGGESTIONS.md).

## Common commands

```sh
npm run check
npm run smoke
```

Installation and update entry points are `install.sh` and `update.sh`.
