# interslice-systems wiki

Internal reference notes. Lives at the repo root rather than under `docs/`
because `docs/` is the deployed GitHub Pages site — wiki content is for
developers reading the repo, not for the public-facing page.

Entries are written long-form. Each one started as a quick ELI5
explainer (via the `eli5` skill in the `mirepoix` repo) and was promoted
here once it became clear the content was worth keeping around. Frontmatter
follows the convention from that skill: `title`, `tags`, optional `source`
provenance line.

## Rendering

How the Trinitron pipeline and its inputs actually work — a stack of
explainers that come at the same problem from different angles.

- [What is trinitron.js actually doing?](what-is-trinitron-js-actually-doing.md) — the photograph-of-a-CRT framing; three pipelines side by side (real 1985 CRT, modern LCD terminal, our canvas)
- [What can you put in a `<canvas>`?](what-can-you-put-in-a-canvas.md) — the eight categories of canvas content (shapes, text, raster, SVG, video, other canvases, per-pixel, gradients) and what they map to in this codebase
- [Why the shell cursor and the canvas cursor are not the same thing](why-the-shell-cursor-and-the-canvas-cursor.md) — abstraction-layer grounding: pixels with state vs pixels computed from arithmetic
- [Why trinitron.js is not just stacked CSS filters](why-trinitron-js-is-not-just-stacked-css.md) — the five things per-pixel canvas code can do that CSS filters structurally can't
