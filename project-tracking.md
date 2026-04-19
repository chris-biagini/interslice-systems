# Project Tracking

GitHub Issues is the single source of truth for all project work —
code, ops, and ideas.

## Milestones as launch gates

Milestones represent concrete launch events — real-world moments where
scope changes (e.g., flipping a feature flag and sending invites). An
issue lives in a milestone iff closing it blocks that launch.
Milestones are **not** temporal phases.

## One live gate at a time

Check GitHub for the current open milestone — don't assume from
memory, which goes stale:

```bash
gh api repos/:owner/:repo/milestones --jq '.[] | select(.state=="open")'
```

Further-out gates are not created until actively driving toward them —
speculative blockers distort what "blocking" means. When a gate fires,
close its milestone and let the idea pile breathe before opening the
next.

## Unmilestoned = idea pile

Quick notes, half-baked bugs, tinkering candidates, hygiene work that
doesn't gate the next launch. Working on an unmilestoned issue is
normal and expected — the gate defines blockers, not priority order.

## No tracking issues

The milestone's own open-issues list is the critical path. A pinned
tracking issue duplicates that state and drifts whenever someone
forgets to tick a box after a merge.

## Convention

- When a session discovers new work, file a GitHub issue.
- When a session completes work, close it via PR commit message
  (`Resolves #NNN`).
- Don't maintain competing task lists in design docs, memory, or
  `CLAUDE.md`.

## Don't cache live GH state in durable docs

Don't bake current milestone names, issue assignments, issue counts,
or who-is-working-on-what into `CLAUDE.md` or other durable docs.
`CLAUDE.md` is always in Claude's context and reads as authoritative —
a line like "The current gate is X" becomes stale advice the moment X
fires.

- Write principles and `gh` commands, not snapshots.
- Design specs dated in the filename are explicitly historical — they
  can describe then-current state.
- Same applies to labels-in-use, open PR counts, active branches, etc.

## Labels

Keep labels flat and low-cardinality. No label = normal code work.
Each project picks its own small set (one per orthogonal axis —
category, urgency, whatever matters for that project).

## Screenshots

Save to `~/screenshots/`, not inside the repo.
