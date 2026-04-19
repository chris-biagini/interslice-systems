# Interslice Common

Shared Claude Code methodology for this developer's projects. These
files are imported into `~/CLAUDE.md` via the `@` path-import syntax,
so every project on the machine inherits the same baseline.

## Modules

| File | Contents |
|------|----------|
| `claude-md-layout.md` | Layer map for CLAUDE.md files (user-level, shared, project). |
| `git-workflow.md` | Trunk-based development, branching, squash-merge, no worktrees. |
| `pr-workflow.md` | Standing permission to open PRs, standard PR body template. |
| `project-tracking.md` | GitHub Issues as source of truth, milestones as launch gates. |
| `superpowers-usage.md` | When to use superpowers, visual companion setup, execution mode. |
| `subagents.md` | Opus subagents for coding tasks. |
| `dev-style.md` | Cross-project development posture. |

## Import pattern

`index.md` chain-imports every module. `~/CLAUDE.md` imports only the
index:

```markdown
@~/.interslice-common/index.md
```

When adding a new module, add a matching `@./foo.md` line to
`index.md`. Run `./check-index.sh` to verify no module is missing:

```bash
$ ./check-index.sh
index.md is in sync (7 modules)
```

Claude Code's `@`-import syntax does not support globs or directory
imports, so the index is the single place drift can occur. The check
script fails loudly if a module is added without being wired up.

Projects inherit automatically through the user-level `CLAUDE.md`.
Project `CLAUDE.md` files do **not** re-import these — they contain
only project-specific content. A project that needs to *override* a
shared rule states the exception explicitly in its own `CLAUDE.md`.

## Non-Rails projects

Projects without a milestones/issues regime (e.g., single-file static
sites) can skip `project-tracking.md` by stating so in their own
`CLAUDE.md`. Each module is self-contained and can be omitted without
breaking the others.

## Related

- `chezmoi` (not this repo) — for dotfiles like `.vimrc` and `.bashrc`.
- Claude-harness config (`~/.claude/settings.json`, keybindings) —
  separate effort.
- Project-specific content — lives in each project's own `CLAUDE.md`.
