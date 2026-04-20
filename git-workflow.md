# Git Workflow

Trunk-based development with short-lived feature branches. **`main` is
always deployable.** CI gates every push.

## When to commit directly to main

Small, self-contained, low-risk changes — single-file bug fix, doc
update, `CLAUDE.md` edit, or cleanup. **Push immediately** to avoid
rebase conflicts after squash-merging PRs that touch the same files.

## When to use a feature branch + PR

The change touches multiple files, adds a feature, refactors code, or
is anything worth reviewing first. When in doubt, branch — easy to
merge, hard to undo a bad commit to main.

## Branch early

Create the feature branch *before* the first commit, including design
docs and plans. They're part of the feature work. If committed to main
first, the eventual squash-merge creates duplicate changes that cause
rebase conflicts on pull.

## Branch workflow

```bash
git checkout -b feature/short-description
# ... work, committing as you go ...
git push -u origin feature/short-description
gh pr create --title "..." --body "..."
# after merge on GitHub:
git checkout main && git pull && git branch -D feature/short-description
```

## Long-lived feature branches

For work that spans sessions (auth, billing, large refactors): commit
freely (messy history aids debugging), rebase onto main periodically
(force-push is expected and safe on feature branches), small fixes
still go to main directly, no PR until ready, squash-merge when done.
Design docs and plans live on the branch.

## Key rules

- **Squash-merge PRs** (`gh pr merge --squash`) for clean linear history.
- **No manual git worktrees.** Use simple `git checkout -b` branching.
  The Agent tool's built-in `isolation: "worktree"` handles subagent
  isolation automatically when needed. This overrides any superpowers
  skill that recommends worktrees.
- **GitHub auto-deletes remote branches** after PR merge.
- **Reference issues in commit messages** to auto-close on push:
  `Resolves #123` or `Resolves #123, resolves #124`. Use bare `#NNN` —
  prefixes like `GH #NNN` prevent GitHub's auto-close parser from
  matching.
- **Commit after finishing edits to a file** — don't batch unrelated
  changes.
