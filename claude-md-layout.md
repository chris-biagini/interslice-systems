# CLAUDE.md Layer Map

Claude Code loads CLAUDE.md context from multiple layers. Any audit,
quality review, or reasoning about "what instructions is Claude
operating under" should enumerate **all** of them:

1. **User-level index** — `~/CLAUDE.md`. Small file that `@`-imports
   the shared methodology below.
2. **Shared methodology** — `~/.interslice-common/*.md`. Cross-project
   conventions (git, PR, tracking, dev style, superpowers, subagents).
   Own git repo, imported by the user-level index.
3. **Project-level** — `<project>/CLAUDE.md` (and any nested
   `<project>/**/CLAUDE.md` in monorepos). Project-specific context
   and any deliberate departures from the shared baseline.

Tools that discover CLAUDE.md files via `find` in the project
directory — including the `claude-md-improver` skill's current
discovery step — will miss layers 1 and 2. When auditing, explicitly
include `~/CLAUDE.md` and every file in `~/.interslice-common/` in
scope.
