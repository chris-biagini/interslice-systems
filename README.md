# Interslice Common

Shared Claude Code methodology for this developer's projects. These
files are imported into `~/CLAUDE.md` via the `@` path-import syntax,
so every project on the machine inherits the same baseline.

## Modules

| File | Contents |
|------|----------|
| `git-workflow.md` | Trunk-based development, branching, squash-merge, no worktrees. |
| `pr-workflow.md` | Standing permission to open PRs, standard PR body template. |
| `project-tracking.md` | GitHub Issues as source of truth, milestones as launch gates. |
| `superpowers-usage.md` | When to use superpowers, visual companion setup, execution mode. |
| `subagents.md` | Opus subagents for coding tasks. |
| `dev-style.md` | Cross-project development posture. |

## Import pattern

In `~/CLAUDE.md`:

```markdown
@~/.interslice-common/git-workflow.md
@~/.interslice-common/pr-workflow.md
@~/.interslice-common/project-tracking.md
@~/.interslice-common/superpowers-usage.md
@~/.interslice-common/subagents.md
@~/.interslice-common/dev-style.md
```

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
