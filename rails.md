# Rails Project Conventions

Ruby + Rails idioms shared across projects. Framework-level postures
first, then Ruby language rules, then the architectural-comments
convention. Individual projects are expected to declare deliberate
divergences in their own `CLAUDE.md`.

## Rails Architectural Idiom

- **Convention over configuration.** Trust Rails defaults until they
  break for a concrete reason. Divergence owes an explanation.
- **Thin controllers, rich models.** Controllers parse params,
  dispatch one verb on an AR object, and render. Domain logic —
  queries, derivations, state transitions — lives on the AR class,
  not in `app/services/` POROs.
- **Resource verbs, not custom actions.** When behavior doesn't fit
  CRUD, introduce a new resource with its own controller
  (`POST /cards/:id/closure` creates a `Closure`) rather than a
  custom action on an existing controller.
- **Hotwire first.** Server-rendered HTML + Turbo Frames/Streams;
  Stimulus for interactivity. No React, Inertia, Phlex, or
  ViewComponent.
- **Rails first, gems last.** Prefer what Rails ships over a gem that
  wraps it — `rate_limit`, `encrypts`, Solid Queue, Solid Cache,
  `has_secure_password` obviate `rack-attack`, `attr_encrypted`,
  Sidekiq, Redis, and most of Devise. A new gem requires a concrete
  framework gap.
- **Homebrew before extracting.** New libraries grow in `lib/` next
  to the code that uses them. Gem extraction is earned by stability
  and reuse across multiple apps.

## Ruby Style

Write idiomatic, expressive, opinionated Ruby — not Python or
JavaScript translated into Ruby syntax. Ruby code should read like
English.

### Enumerable over imperative loops — this is non-negotiable

NEVER build collections with `each` + an accumulator. Use the right
Enumerable method:

```ruby
# WRONG — Claude's default, and it's unacceptable
result = []
items.each { |item| result << item.name if item.active? }
result

# RIGHT — idiomatic Ruby
items.select(&:active?).map(&:name)
```

Use `map`, `select`/`reject`, `flat_map`, `each_with_object`,
`any?`/`all?`/`none?`, `tally`, `group_by`, `sum`. Always use
`&:method_name` (Symbol#to_proc) when the block just calls one
method.

When appending to an existing collection, use `concat` + `map` — not
`each` + `<<`:

```ruby
# WRONG
custom.each { |item| list << { name: item, amounts: [] } }

# RIGHT
list.concat(custom.map { |item| { name: item, amounts: [] } })
```

### Method design

- Methods should be ≤ 5 lines. Extract smaller methods with
  descriptive names instead of adding comments.
- NEVER use explicit `return` at the end of a method. Ruby returns
  the last expression implicitly.
- Use guard clauses and early returns to flatten conditionals. Never
  nest more than 2 levels.
- Use postfix `if`/`unless` for single-line expressions:
  `return if list.empty?`
- Prefer `size` over `length` everywhere. `length` is Java/Python;
  `size` is Ruby.
- Prefer keyword arguments over positional arguments for clarity at
  call sites.
- Prefer `map` over `collect`, `select` over `find_all`, `key?` over
  `has_key?`.
- Never prefix with `get_` or `is_`. Use `name` not `get_name`. Use
  `valid?` not `is_valid?`.
- Safe-navigation cops: `Style/SafeNavigation` prefers `x&.foo` over
  `x.foo if x`; `Style/SafeNavigationChainLength` caps chained `&.`
  at 2. For longer nil-safe chains, use `.to_s` entry + `.presence`
  exit: `c.to_s.strip.downcase.squish.presence`.

### Comments

Comments that narrate code are the #1 tell of LLM-generated Ruby.
This is a hard rule:

- **Never** write a comment that restates the method name, class
  name, or what the code obviously does.
- **Never** write `# ClassName` or `# ClassName class` above a class
  definition.
- **Do** add comments that explain *why* — business rules, non-
  obvious constraints, or links to external references.
- If code needs a comment explaining *what*, extract a method with a
  descriptive name instead.

```ruby
# WRONG — restates what the code does
# Build a recipe from parsed tokens
def build_recipe
# Check if the ingredient is valid
def valid_ingredient?(name)

# RIGHT — the names are clear; no comment needed
def build_recipe
def valid_ingredient?(name)

# RIGHT — explains WHY, not WHAT
# Miscellaneous defaults to last unless explicitly ordered
return [2, 0] if aisle == 'Miscellaneous'
```

## Architectural Comments

To avoid overburdening `CLAUDE.md`, documentation on architecture
should live primarily in the code itself, next to the classes it
describes.

Every Ruby class/module and every JavaScript controller/utility gets
a header comment explaining its **role**, **key collaborators**, and
**non-obvious constraints**. Plain prose. Short, around 5 lines,
with a bulleted list of collaborators. The comments answer: *what
role does this play?*, *who does it talk to?*, and *why is it this
way?*

`CLAUDE.md` is the map; the comments are the territory. The project
`CLAUDE.md` need only contain a concise map of conventions and
workflows.

Add a header comment when creating a new file. Update comments when
responsibilities change — a stale comment is worse than none. Update
`CLAUDE.md` when adding new conventions or workflows.
