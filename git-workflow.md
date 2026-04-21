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
freely (messy history aids debugging), small fixes still go to main
directly, design docs and plans live on the branch. Two flavors:

- **Single squash at the end.** One PR, squash-merged when the whole
  effort is done. Branch is deleted post-merge.
- **Per-phase squash-merges, branch continues.** The effort is split
  into phases; each phase opens its own PR against main and
  squash-merges, but the feature branch lives on to carry the next
  phase. Mirepoix's vanilla-rails refactor uses this shape.

## After a squash-merge: catching the feature branch up

Trap: **rebase onto main after a squash-merge doesn't work.** Git's
"already-applied" detection is patch-based and the squash commit
doesn't match the individual commits it compressed, so rebase thinks
the local commits are still unique work and tries to re-apply them —
producing add/add conflicts on files the squash already contains.

For the **single-squash-at-the-end** flavor, this isn't an issue: the
branch is deleted post-merge.

For the **per-phase** flavor, after each phase's PR squash-merges:

```bash
# In the clone on the feature branch:
git fetch --prune              # pull down main's new state; clean up
                               # the remote branch GitHub auto-deleted
git reset --hard origin/main   # move the feature branch to match main
git branch --unset-upstream    # clear the dangling upstream ref
                               # (next `git push -u` re-sets it)
```

Reset --hard is safe here because the N local commits being discarded
are content-preserved in main's single new squash commit. Nothing is
lost. The branch pointer is just moving to where the work actually
lives now.

For the clone that stays on main, it's the usual `git pull`.

If anyone has uncommitted work on the feature branch at merge time,
stash first (`git stash -u`) and pop after (`git stash pop`).

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
