# Superpowers Usage

## When to invoke

Always use the superpowers plugin when changing more than a few lines
of code.

## Visual brainstorm companion

Explicit permission to use the visual brainstorm companion tool and
launch its server. **Always start it with `--host 0.0.0.0 --url-host
rika`** — the default 127.0.0.1 binding is unreachable from the user's
browser in this remote setup, and the user accesses the dev machine by
hostname "rika", not localhost.

## Execution mode

After committing the implementation plan, proceed immediately with
**Subagent-Driven execution**. Do not prompt to choose between
Subagent-Driven and Inline.

## Brainstorming questions

During brainstorming and any dialogue-style turn, ask questions inline
in chat ("Do you want X, Y, or Z? Here's why I'd lean toward...")
rather than firing the `AskUserQuestion` picker. The picker UI feels
heavier than the user wants. Save it for cases where the user
explicitly invokes a picker, or where there's a specific need for
structured selection (e.g., a long matrix of options).
