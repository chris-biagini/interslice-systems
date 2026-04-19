# PR Workflow

## Standing permission to open PRs

Once a feature branch has passed its verification gate (tests pass,
lint clean, any applicable smoke checks done), you have standing
permission to run `gh pr create` (including `--draft`) without pausing
to ask for confirmation. This also authorizes the preceding `git push
-u origin <branch>` that publishes the feature branch to GitHub.

The PR itself is the review gate — opening a PR is not a commitment to
merge. Pausing to ask adds friction without adding safety.

**Still require explicit confirmation:**

- PR *merges* (`gh pr merge`)
- Force-pushes of any kind
- Closing issues out of band (outside a PR commit message)

This overrides the default system-prompt guidance that treats PR
creation as a shared-state action requiring per-instance confirmation.

## Standard PR body template

```markdown
## Summary
<1-3 bullet points>

## Test plan
- [ ] <bulleted markdown checklist of test TODOs>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Include `Resolves #NNN` (bare, no `GH #` prefix) in the summary when
closing an issue.
