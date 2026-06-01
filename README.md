# claude-pgas-plugin

Claude Code plugin for scaffolding **pgas** consumers and programs.

The plugin codifies the lessons from two recent pgas governance threads
([pgas#253](https://github.com/simodelne/pgas/issues/253),
[pgas#254](https://github.com/simodelne/pgas/issues/254)) into:

- Slash commands for scaffolding new pgas consumers (Mode A) and new
  programs inside an existing consumer (Mode B).
- Skills for auditing a consumer against the 5 failure modes from
  pgas#253, for generating the per-version architecture doc per
  pgas#254, for validating `spec.yml`, and for linting `system_mode_entry`
  breadth.
- Hooks that block staging an invalid `spec.yml` and nudge for the
  architecture doc on `.0` publishes.
- Templates that close each FM **by construction** — a freshly-scaffolded
  consumer ships with the FM-closing patterns already in place.

## Status

`v0.1.0` — foundation. Auth + frontend templates land in v0.2 + v0.3.

## Install (once published)

Add the marketplace to Claude Code and install the plugin via the
in-app plugin manager. Local-dev install:

```bash
git clone git@github.com:simodelne/claude-pgas-plugin.git ~/claude-pgas-plugin
ln -s ~/claude-pgas-plugin ~/.claude/plugins/cache/local/claude-pgas-plugin/0.1.0
# (then point your local marketplace at it)
```

See `docs/PLUGIN-DEVELOPMENT.md` for the in-development workflow.

## Usage

```
/pgas-new-consumer        # scaffold a fresh pgas consumer repo (Mode A)
/pgas-new-program         # scaffold a program inside the current consumer (Mode B)
```

Plus the four bundled skills, auto-discovered by Claude Code:

- `pgas:5-fm-audit` — audit a consumer against pgas#253 FM1-FM5
- `pgas:architecture-doc` — generate/update `audit/ARCHITECTURE-*.md`
- `pgas:spec-validate` — `loadSpec()` a consumer's spec.yml
- `pgas:mode-entry-lint` — flag the FM3 `system_mode_entry` breadth foot-gun

## License

MIT — see `LICENSE`.
