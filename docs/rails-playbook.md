# A vanilla Rails 8 playbook for a solo consumer app

**The short answer: follow 37signals exactly.** Ship a majestic monolith on Rails 8 with the Solid trifecta, Hotwire, Kamal 2, and Thruster on a single Hetzner VPS; write fat models with concerns and POROs rather than service objects; test with Minitest and fixtures; fight hard before every gem. This setup gives a solo developer — especially one pair-programming with an LLM — the shortest path from `rails new` to a real business, and it is *exactly* the stack 37signals has open-sourced from running Basecamp, HEY, and their 2026 products (Fizzy, Writebook, Campfire). Every piece below maps to something they either wrote the gem for or use in production. This report walks through the philosophy, the defaults, the architecture, the gems, Kamal/VPS deployment, multi-tenancy, performance, the solo-plus-AI workflow, and ends with a consolidated starter checklist.

---

## 1. The vanilla Rails philosophy

Jorge Manrubia's two essays — *Vanilla Rails is plenty* (Nov 2022) and *A vanilla Rails stack is plenty* (Dec 2024) — are the canonical statements. The first is architectural: *"We don't separate application-level and domain-level artifacts. Instead, we have a set of domain models (both Active Records and POROs) exposing public interfaces to be invoked from the system boundaries, typically controllers or jobs… we don't default to create services, actions, commands, or interactors to implement controller actions."* The second is about gems: *"Fight hard before adding Ruby dependencies. Keep that Gemfile that Rails generates as close to the original one as possible… Vanilla requires determination, because new dependencies always look shiny and shinier. It's always clear what you get when you add them, but never what you lose in the long term."* Manrubia's preferred call site, out of three syntactically equivalent options, is **always** `recording.incinerate` over `Recording::Incineration.new(recording).run` or `IncinerationService.execute(recording)` — the method on the model is the public interface; delegation to a PORO is an implementation detail.

The critique of **service objects, hexagonal architecture, and DDD-as-boilerplate** is direct. DHH calls heavy pattern-driven Rails *"a J2EE renaissance fair… a dense jungle of service objects, command patterns, and worse."* Manrubia steel-mans DDD by quoting Evans and Vernon against its over-eager adopters: *"Using Services overzealously will usually result in creating an Anemic Domain Model."* The indictment is practical: you end up either with tons of delegator boilerplate *or* data-bag models whose behavior lives in a parallel `app/services/` hierarchy. The rejection is not of object-oriented decomposition — it is of **ritualistic layering**. POROs are welcome; `app/services/XService#call` as a reflex is not.

**The "majestic monolith,"** coined by DHH in 2016 and refined in 2020's *The Citadel*, is the positive thesis: one Rails codebase does everything. Microservices and SOA are *"a great pattern"* for Amazon-scale orgs but *"patterns that make sense for organizations orders of magnitude larger than yours are often the exact opposite ones that'll make sense for you."* Basecamp 3, nearly a decade old, runs 500 models and 400 controllers in one codebase and serves millions. The Citadel concedes that very large apps can sprout "outposts" around the monolith — but even then, the monolith stays at the center. For a solo consumer app, "outpost" is a word you should not think about for years.

**The "one-person framework"** is DHH's 2021 framing of Rails's north star: *"A toolkit so powerful that it allows a single individual to create modern applications upon which they might build a competitive business."* Rails 8 is the most literal embodiment of that vision yet, because it removes whole subsystems (Redis, Memcached, Sidekiq, Heroku, Nginx, Devise, Sprockets) from the default stack and replaces them with first-party, database-backed alternatives. DHH's Rails World 2024 framing: *"Rails 7 is great at HELLO WORLD, but the bridge to IPO is missing."* Rails 8 is that bridge.

**Conceptual compression** is the mechanism that makes the one-person framework possible. From the 2018 RailsConf keynote: *"Through advances in leaky abstractions, we've managed to compress the conceptual overhead of the database so much that it needn't feature in the introduction material for making database-backed applications."* In his follow-up *Conceptual compression is lossy (and loss hurts)*, DHH acknowledges the tradeoff: *"To make things simpler, you have to take something away. That means giving up something of real value to get something else of greater value still."* Active Record hides SQL until you need it; Zeitwerk hides autoloading; Turbo hides SPA machinery; Solid Queue hides Redis. When the compression leaks, you unpack it — and then compress it back down. The point is not to pretend the complexity isn't there; it's to delay paying for it until you actually need to.

**"Fizzy infrastructure"** (Feb 2026) is the steelman of the philosophy written by 37signals themselves. For Fizzy, their new Kanban product, they tried to push past vanilla: per-customer SQLite files, replicated geographically with a custom Go replicator called Beamer, unifying SaaS and self-hosted deployment. Two days before launch they reverted to commingled MySQL. Kevin McConnell's reasoning: *"A year from now when the app's growing… are we going to be kicking ourselves for setting it up in this particular way?… We risked having an app that broke, which no one wants."* They kept what was reusable (the `activerecord-tenanted` gem, kamal-proxy load-balancing enhancements, an optimistic read-after-write trick) and shipped on boring MySQL. **If 37signals will bail on a year of ambitious infrastructure two days before launch, a solo developer should need extraordinary evidence to reach past the default stack.**

The tradeoffs are real. Critics point out that concerns can become a "junk drawer" (Bryan Helmcamp), that `default_scope`-heavy models do "spooky action at a distance," that rich AR models couple persistence and domain. Manrubia concedes the approach is tested "up to Shopify-adjacent scale, not Shopify scale." But for the realistic target — a solo developer building a consumer product up to the first million in revenue — every contrary pattern costs more than it saves. The answer to "when do I need the other stuff?" is: *almost certainly not yet, and you'll know when.*

---

## 2. Rails 8 defaults and the Solid trifecta

Rails 8.0 shipped **November 7, 2024** under the banner *"No PaaS Required"*; Rails 8.1 shipped **October 22, 2025** with continuation jobs, local CI, and markdown rendering; 8.2 is in edge as of April 2026. All 8.x requires Ruby 3.2+. The thesis, in DHH's words: *"Deploying modern web apps has become so hard that many developers don't dare do it without a PaaS. But that's ridiculous… That's a job for open source, and Rails 8 is ready to solve it."*

**Solid Queue** is the Active Job backend. It uses `FOR UPDATE SKIP LOCKED` on Postgres 9.5+ / MySQL 8+ / SQLite, and runs as a set of worker, dispatcher, scheduler, and supervisor processes (defaulting to fork mode; `bin/jobs` runs the supervisor, or a Puma plugin runs it inline for single-server installs). HEY runs about **20 million jobs per day on it** across 800 workers. It supports priorities, delayed jobs, concurrency controls, pausing queues, and — new in Rails 8.1 — **continuations**, which break long jobs into resumable steps (important because Kamal gives containers 30 seconds to shut down). Its decisive advantage over Sidekiq isn't throughput — independent benchmarks show Sidekiq still 2.5–5× faster at extreme concurrency — but **transactional enqueueing**: a job enqueued in the same transaction as a DB write either both happen or neither does, without extra plumbing. Switch to Sidekiq only above roughly 2,000–5,000 jobs/minute sustained, if you already run Redis, or if you depend on Sidekiq Pro batches.

**Solid Cache** is the database-backed `Rails.cache`. It's FIFO, not LRU (no per-read tracking), and compensates by being vastly larger and longer-lived than a RAM store. **Basecamp stores roughly 10 TB with a 60-day retention window**, and after adoption their 95th-percentile request duration dropped from 375 ms to 225 ms while cache size grew 6× on 80% cheaper storage. Raw reads are about 40% slower than Redis, but the bigger, longer cache wins on hit rate by a wide margin. It supports optional encryption at rest (via Active Record encryption) and sharding across cache DBs. The only reasons to keep Redis as a cache: very hot sub-millisecond reads where those 40% matter, or you're already running Redis for something else.

**Solid Cable** is the Action Cable pub/sub adapter. It polls the database every 100 ms by default, retains messages for a day with automatic trimming, and — unlike the built-in Postgres NOTIFY adapter — has no 8 KB payload limit. In head-to-head benchmarks it's slower than AnyCable or Redis but "comparable in most situations." For a consumer app, it is plenty.

**The Rails 8 authentication generator** (`bin/rails generate authentication`) produces roughly 150 lines across `User`, `Session`, `Current` models, a `SessionsController`, a `PasswordsController`, an `Authentication` concern, `PasswordsMailer`, views, and migrations. It uses `has_secure_password` (bcrypt), signed cookies, `authenticate_by`, and `generates_token_for`. Crucially, it is **deliberately minimal**: email/password login and password reset only. No registration, no OAuth, no email confirmation, no locking, no roles — you build those. This is the point. It's Devise without the magic, and it matches 37signals' own hand-rolled auth pattern. Reach for Devise only if you genuinely need its breadth of strategies; reach for **Rodauth** if you need WebAuthn/OTP/JWT and don't want to write them.

**Propshaft** replaces Sprockets as the default asset pipeline. It does digest stamping, load-path management, and CSS `url()` rewriting — nothing else. It does not compile Sass, transpile, bundle, or process ERB. You're expected to use import maps for JS and either plain CSS or `cssbundling-rails` for output. Sprockets is still maintained with no deprecation timeline; upgrading existing apps from 7.x to 8 does not auto-migrate.

**Import maps** are the default `#nobuild` JS strategy. DHH: *"You can't get faster than no-build."* Your `importmap.rb` should import Turbo, Stimulus, your controllers, and very little else. Only switch to `jsbundling-rails` (esbuild or Bun) when you need npm packages that ship untranspiled syntax or require a real bundler — in other words, rarely.

**Hotwire** (Turbo + Stimulus, plus Strada/Hotwire Native for mobile bridges) is the frontend. Turbo Drive does SPA-style navigation; Turbo Frames scope page regions; Turbo Streams push HTML fragments over WebSockets or HTTP. Stimulus attaches small JS controllers via `data-controller` attributes. Rails 8.1 adds morphing (smoother partial replacement) and the new Action Text editor (Lexxy) to replace Trix. The entire HEY, Basecamp, and Fizzy UIs run on this stack.

**Kamal 2** is the deployment tool, covered in depth in §5. **Thruster** is a tiny Go HTTP/2 proxy that wraps Puma inside the container (Rails 8's Dockerfile runs `./bin/thrust ./bin/rails server`). It provides HTTP/2, X-Sendfile, gzip with BREACH mitigation, basic public asset caching, and process supervision — eliminating the need for Nginx in most setups.

**SQLite in production** got serious attention in Rails 8, led by Stephen Margheim and Mike Dalessio. WAL mode, `synchronous=NORMAL`, IMMEDIATE transactions by default, GVL release during write-lock acquisition, and tuned PRAGMAs make the full Solid trifecta viable on SQLite. ONCE products (Campfire, Writebook) run this way in thousands of installs. For a consumer app with collaboration or real-time features, you'll still want Postgres; for a tiny tool or a single-tenant self-hosted product, SQLite is now genuinely ready.

Rails 8.1 additions worth naming: **Active Job continuations**, **structured events** for observability, a **local CI DSL** (`config/ci.rb` + `bin/ci`) that makes ditching GitHub Actions plausible (37signals runs their full suite in ~70 s locally), native **markdown rendering** aimed at AI-generated content, a deprecation API for associations, and Kamal 2.8 local registry support.

---

## 3. Architecture patterns idiomatic to 37signals-style Rails

The organizing rule is that **models are rich, and their public API is your domain API.** Controllers call model methods. Models delegate to POROs. Nothing goes through a generic service layer.

### Fat models, organized

The two tactics are **concerns for file-level organization** and **POROs for real decomposition.** Shared mixins (`Taggable`, `Positioned`) live in `app/models/concerns/`. Model-specific organizational concerns live in `app/models/recording/` as `Recording::Incineratable`. POROs that do real work — `Recording::Incineration`, `Projects::Search` — live as plain classes in `app/models/`, not in `app/services/`.

```ruby
# app/models/recording.rb
class Recording < ApplicationRecord
  include Incineratable, Copyable, Subscribable
end

# app/models/recording/incineratable.rb
module Recording::Incineratable
  extend ActiveSupport::Concern
  def incinerate
    Incineration.new(self).run
  end
end

# app/models/recording/incineration.rb
class Recording::Incineration
  def initialize(recording) = @recording = recording
  def run
    ActiveRecord::Base.transaction do
      purge_attachments
      delete_children
      @recording.destroy
    end
  end
end
```

Michael Feathers' distinction, which Manrubia leans on: **SRP violations at the interface level are fine; violations at the implementation level are not.** A model with a broad public API is acceptable when it's a facade over cohesive small classes. Extract to a PORO when the operation has its own state, spans aggregates, has interchangeable algorithms, or is "application coordination" rather than domain logic — not because the model file grew past some arbitrary line count.

### The Delegated Type pattern

Jeffrey Hardy's Dec 2025 article is the best treatment. A **parent** table (say `recordings`) holds shared metadata and a polymorphic pointer (`recordable_id`, `recordable_type`). **Concrete** types (`Message`, `Document`, `Comment`, `Upload`, `Todo`) live in their own tables. You query and operate on the parent; the child is dumb content. Compared with STI (one wide table that every type modifies) and plain polymorphic associations (the arrow points the wrong way for "list all content in this project"), delegated types give you small parent tables, cheap mixed-type pagination, uniform caching via the parent's `cache_key`, and the ability to add new types without migrating a shared table.

```ruby
class Recording < ApplicationRecord
  include Recordables, Copyable, Incineratable, Subscribable
  belongs_to :bucket
  has_many :events, dependent: :destroy
end

module Recording::Recordables
  extend ActiveSupport::Concern
  TYPES = %w[Message Document Comment Upload Todo]
  included do
    delegated_type :recordable, types: TYPES, dependent: :destroy
  end
end

module Recordable
  extend ActiveSupport::Concern
  included { has_one :recording, as: :recordable, touch: true }
  def commentable? = false
  def copyable?    = true
end

class Message < ApplicationRecord
  include Recordable
  def commentable? = true
end
```

37signals uses this everywhere: Basecamp's `Recording` → messages, documents, comments, uploads, todos, chats; HEY's `Entry` → messages, replies, notes; HEY Calendar's unified event/countdown/highlight timeline in one query. Uniquely powerful at 37signals' scale: **copy/move becomes cheap** (new recording row pointing at the same recordable, no content duplication), version history and Russian-doll caching fall out of the immutable-recordable pattern, and a **single `/recordings` API** feeds mobile clients every type without releases. Reach for it when you have many content-like entities sharing lifecycle operations and mixed-type timelines. Don't reach for it with only two or three types, or when you need cross-cutting belongs-to (tagging, attaching) — that's polymorphic's job.

### Multi-tenancy in Rails

Three real options. **Row-level** (`acts_as_tenant` or hand-rolled scopes + `ActiveSupport::CurrentAttributes`) is simple, scales linearly to hundreds of thousands of tenants, allows cross-tenant admin queries, and is what nearly every SaaS Rails app should start with. The cost is that isolation is logical, not physical; every tenanted index must lead with `tenant_id`; and `default_scope` needs `unscoped`/`without_tenant` for admin tasks. **Schema-based** (Apartment) has been effectively abandoned: the original repo is archived, migrations run O(n) per tenant, Postgres chokes on many schemas, modern Rails connection pooling was incompatible with early Apartment, and it doesn't tenant Active Storage, Action Text, Action Cable, or the cache without extra plumbing. The maintained fork (`rails-on-services/apartment`) now openly recommends row-level instead. **Database-per-tenant** is what 37signals explored for Fizzy via Mike Dalessio's `activerecord-tenanted` gem — real isolation, trivial delete/export, geographic data locality — but the operational cost of replication and failover (their Beamer project) caused them to revert to commingled MySQL two days before launch. Watch `activerecord-tenanted` as it matures and absorbs production miles through ONCE products; don't adopt it yet for a solo consumer app.

Practical row-level pattern for a consumer app with workspaces or teams:

```ruby
# app/models/current.rb
class Current < ActiveSupport::CurrentAttributes
  attribute :account, :user, :membership
end

# app/controllers/application_controller.rb
before_action :set_current_account, :require_membership

def set_current_account
  Current.account = Account.find_by!(subdomain: request.subdomain)
end
def require_membership
  Current.membership = Current.account.memberships.find_by!(user: Current.user)
end

# app/models/concerns/tenanted.rb
module Tenanted
  extend ActiveSupport::Concern
  included do
    belongs_to :account, default: -> { Current.account }
    default_scope { where(account: Current.account) if Current.account }
    validate { errors.add(:account, "mismatch") if Current.account && account_id != Current.account.id }
  end
end

class Project < ApplicationRecord
  include Tenanted
end
```

Always scope Action Cable channels to the tenant and include the tenant in fragment cache keys: `cache([Current.account, project]) do … end`. If you need hardening without a gem, set `require_tenant = true` behavior yourself by raising in `ApplicationRecord` when a tenanted class is queried with no `Current.account`.

### Action Text, Action Mailbox, Active Storage

Use Active Storage for any file attachment (avatars, documents, variants, direct uploads, signed URLs); back it with Cloudflare R2 for free egress. Use Action Text when you need a WYSIWYG body field with inline attachments (comments, posts, notes) — it stores HTML in `action_text_rich_texts` and attaches files through Active Storage. Use Action Mailbox when your app receives email (support tickets, reply-to-comment, forwarding apps); it routes raw email to mailbox classes the way controllers route HTTP. All three compose naturally with Hotwire and multi-tenancy as long as blob keys include the tenant.

### Query, form, and service objects — when they earn their keep

**Query objects** are worth it when a search chains three or more optional filters, spans joins you don't want on the model, or powers a UI with permutations. **Form objects** are worth it when one form writes to multiple models (signup creates `User` + `Account` + `Membership`), when you need validations that don't belong on any one AR model, or for wizard flows. **Service objects** are worth it for genuine multi-step business processes that coordinate aggregates (e.g., `Payments::Charge`, `Account::Incineration`) or wrap external APIs. **None** of these are worth it as a reflex for every controller action — that's the anemic-model anti-pattern. The litmus test: does the name mean something specific, or is it `XCreator`/`XUpdater` padding?

### Testing philosophy

37signals uses Minitest + fixtures + Capybara, with `webmock` blocking real HTTP. Minitest ships with Rails, parallelizes cleanly (`parallelize workers: :number_of_processors`), and uses plain assertion syntax. **Fixtures load once per suite inside a transaction per test**, which makes the suite dramatically faster than the FactoryBot pattern of creating small object graphs in every test — TestProf's EventProf consistently shows factory cascades as the #1 cause of slow Rails suites. Fixtures also force you to think about a realistic shared dataset early, which tends to surface integration bugs. Keep system tests sparse and reserved for critical happy paths; cover branches in model and controller tests. If your team already knows RSpec well, the switch cost isn't worth it — but don't start a new app there.

### Callbacks and validations

Validations are fine for UX (presence, format, length, uniqueness). **Back uniqueness with a DB unique index** — `validates_uniqueness_of` has race conditions — and enforce critical invariants with `NOT NULL`, `CHECK`, and foreign keys, because validations can be bypassed by `update_column`, raw SQL, or another app. Rails 7.1's `normalizes :email, with: ->(e) { e.strip.downcase }` replaces many `before_validation` normalizers.

Callbacks are fine when the side effect is pure, fast, local, and cannot fail — setting slugs, touching associations, bumping cache keys. Manrubia's *Globals, callbacks and other sacrileges* explicitly defends them. They become a liability when they send email or make network calls (extend transactions, run during seeds and imports, should at minimum be `after_commit`), cross-model save chains that cause infinite loops, or business logic whose conditional execution gets hard to trace. Rule of thumb: **callbacks for data-consistency side effects that should run every time the record changes; explicit method calls for business processes.**

---

## 4. Gem choices for a vanilla Rails app in 2026

The short version, modeled on what 37signals actually uses in Fizzy:

| Category | Pick | 37signals | Deviate when |
|---|---|---|---|
| Authentication | `bin/rails g authentication` + OmniAuth for social | Custom (~150 LOC, magic links) | SAML/enterprise → Rodauth |
| Authorization | Methods on User (`current_user.can_x?(record)`) | Same | 10+ roles × 30+ resources → Action Policy |
| Background jobs | Solid Queue | Solid Queue (wrote it) | >2k jobs/min or existing Redis → Sidekiq |
| Admin panel | Build your own `/admin` controllers | Custom admin app | Non-dev CRUD users → Avo |
| Pagination | Pagy | `geared_pagination` (their own) | Rarely — Pagy wins |
| Search | `ILIKE` → Postgres FTS / `pg_search` → Meilisearch | Custom MySQL FTS | Typo tolerance at scale |
| File uploads | Active Storage + S3 / Cloudflare R2 | Active Storage | Complex derivative pipelines → Shrine |
| Image processing | `image_processing` + `ruby-vips` | Same | — |
| Payments | `pay` gem (Stripe) | N/A (custom billing) | One-time only → raw `stripe` |
| Email | Postmark over SMTP + Action Mailer | Own infrastructure | High-volume marketing → separate tool |
| Error/APM | Honeybadger (or AppSignal for all-in-one) | Self-hosted Prometheus | — |
| Feature flags | `Feature` model → Flipper later | Deploy-based releases | Need percentage rollouts → Flipper |
| HTTP client | Faraday for services; `Net::HTTP` for one-offs | — | — |
| Rate limiting | Rails 8 `rate_limit` + `rack-attack` | — | — |
| Markdown | Action Text (user content); Redcarpet + Rouge (rendering) | Same + Lexxy | — |
| Charts | Chartkick + Groupdate | — | Custom viz → Stimulus + d3 |
| Secrets/config | Rails credentials + `ENV.fetch` | Same | Skip `dotenv-rails` |
| Testing | Minitest + fixtures + Capybara + webmock | Same | — |

A few decisions deserve their rationale. For **auth**, the Rails 8 generator is essentially what 37signals wrote for themselves, upstreamed; Devise becomes your problem the moment you need multi-step onboarding, Turbo Native, or a second user type. For **authorization**, Pundit/CanCan/Action Policy invent a parallel class hierarchy to express rules that are fundamentally about your domain; a `current_user.can_administer_card?(card)` method on User is usually clearer, and Fizzy confirms this pattern is used throughout. For **admin**, ActiveAdmin/RailsAdmin bolt a generic CRUD UI onto your tables, which is almost always the wrong product decision — admin dashboards should show business metrics and specific workflows (ban user, refund charge, extend trial), which plain namespaced controllers with reusable partials produce naturally. For **email**, Postmark is the boutique-Rails consensus for its transactional-only focus and deliverability reputation; Resend is the modern alternative; SES is cheapest at scale if you manage reputation; SendGrid is deliberately avoided in this circle. For **search**, Postgres full-text with trigram covers most consumer apps to millions of rows before you need Meilisearch; don't start with Elasticsearch. For **image processing**, libvips is 10× faster at 10% the memory of MiniMagick and is moving toward default.

What's deliberately **not** on this list: Devise, Pundit, CanCanCan, Sidekiq, Redis, dotenv-rails, RSpec, FactoryBot, Kaminari, ActiveAdmin, RailsAdmin, Shrine, CarrierWave, Searchkick, HTTParty, ViewComponent, dry-rb, Interactor, Trailblazer. Every one solves a real problem; none of them solves one that vanilla Rails 8 hasn't already addressed for a consumer-app solo developer.

---

## 5. Deployment with Kamal 2 to an inexpensive VPS

Kamal 2 turns a fresh Ubuntu VPS with an SSH key into a production host in about two minutes. It builds your Docker image, pushes it to a registry, pulls it on the server, runs it behind **kamal-proxy** (a purpose-built Go reverse proxy that replaced Traefik in v2), and handles zero-downtime rolling deploys with health checks and automatic Let's Encrypt TLS. Versus Capistrano it trades "Ruby running rake tasks on the server" for "Docker containers behaving identically everywhere"; it is still imperative (unlike Kubernetes), which is the point.

**VPS provider pick: Hetzner Cloud.** The CPX22 at roughly €8/mo after the April 2026 price adjustment gives 2 vCPU, 4 GB RAM, and 20 TB of EU bandwidth — about 60% cheaper than DigitalOcean's equivalent and with 5× the bandwidth. Trade-offs: no managed database, weekday-only support, thinner docs. Put Cloudflare in front for CDN, DDoS protection, and free cert at the edge.

**Sizing.** For pre-launch or MVP, a CPX11 or CX22 (2 vCPU / 2–4 GB) is plenty with Rails and Postgres on the same box. For 100–1,000 users, CPX22 with 2 Puma workers × 3 threads. For 1,000–10,000 users, CPX32 (4 vCPU / 8 GB) with 3–4 × 5 still co-located. Split Postgres onto a dedicated VPS when its CPU steady-states above ~40%, when vacuum/backups affect web response, or when the memory ceiling approaches. **Nate Berkopec's rule of thumb still holds**: most Rails apps never need more than one server, and with Russian-doll caching and AR tuning, a well-tuned VPS serves thousands of requests per minute comfortably. Basecamp historically ran on ~30 app servers against one big DB — scale up the database, scale out the app.

**Thruster** sits inside the container wrapping Puma, automatic and zero-config: HTTP/2, X-Sendfile (so ActiveStorage downloads don't tie up a Puma worker), gzip with BREACH jitter, public asset caching. Its default port is 80, which is why Kamal 2's default `app_port` is also 80. **kamal-proxy** at the host handles TLS and routing across multiple apps on the same server — you can colocate side projects on one VPS without label gymnastics.

A representative `config/deploy.yml` for a Rails 8 app on a 4 GB Hetzner box with Postgres, Redis (optional), and daily offsite backups to Cloudflare R2:

```yaml
service: myapp
image: myuser/myapp

servers:
  web:
    hosts: [ 1.2.3.4 ]
  jobs:
    hosts: [ 1.2.3.4 ]
    cmd: "bin/jobs"

proxy:
  ssl: true
  host: app.example.com,www.example.com
  app_port: 80
  forward_headers: true
  healthcheck: { path: /up, interval: 3s }

registry:
  username: myuser
  password: [ KAMAL_REGISTRY_PASSWORD ]

ssh: { user: deploy }  # not root

env:
  clear:
    DB_HOST: myapp-postgres
    WEB_CONCURRENCY: "2"
    RAILS_MAX_THREADS: "5"
    RAILS_LOG_TO_STDOUT: "1"
  secret: [ RAILS_MASTER_KEY, POSTGRES_PASSWORD, SECRET_KEY_BASE ]

asset_path: /rails/public/assets

accessories:
  postgres:
    image: postgres:16
    host: 1.2.3.4
    port: "127.0.0.1:5432:5432"    # never publicly expose DB
    env:
      clear: { POSTGRES_USER: myapp, POSTGRES_DB: myapp_production }
      secret: [ POSTGRES_PASSWORD ]
    directories: [ "data:/var/lib/postgresql/data" ]

  pgbackup:
    image: eeshugerman/postgres-backup-s3:16
    host: 1.2.3.4
    env:
      clear:
        SCHEDULE: "@daily"
        BACKUP_KEEP_DAYS: 30
        S3_BUCKET: myapp-backups
        S3_ENDPOINT: https://abc.r2.cloudflarestorage.com
        POSTGRES_HOST: myapp-postgres
        POSTGRES_DATABASE: myapp_production
        POSTGRES_USER: myapp
      secret: [ POSTGRES_PASSWORD, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY ]
```

And the matching `config/puma.rb` for a 4 GB / 2 vCPU box:

```ruby
threads ENV.fetch("RAILS_MIN_THREADS", 5).to_i, ENV.fetch("RAILS_MAX_THREADS", 5).to_i
workers ENV.fetch("WEB_CONCURRENCY", 2).to_i
preload_app!
plugin  :tmp_restart
plugin  :solid_queue if ENV["SOLID_QUEUE_IN_PUMA"] == "true"
```

**Two workers × three to five threads** is the sweet spot: each Rails worker is ~300–500 MB, so 2 × 450 MB leaves headroom for Postgres shared_buffers and the OS. DB pool size should meet or exceed `RAILS_MAX_THREADS` plus any in-process Solid Queue threads.

**Secrets** go in `.kamal/secrets`. For a solo dev, the simplest pattern sources `RAILS_MASTER_KEY` from the file and pulls per-environment keys with the **1Password CLI** (`op`) — the `.kamal/secrets` file becomes safe to commit because it only contains lookups. Rails 8's `bin/rails credentials:fetch` can also source individual keys into Kamal secrets. Every secret must appear *both* in `.kamal/secrets` and in `deploy.yml`'s `env.secret` for each role that needs it.

**Backups** are the non-negotiable discipline. Tiered, in order of robustness: a daily `pg_dump` to Cloudflare R2 (zero egress fees, S3-compatible — the `eeshugerman/postgres-backup-s3` image above does this), Hetzner VPS snapshots as a second layer, and **pgBackRest** with WAL archiving when you want point-in-time recovery. At least one copy must live on a provider other than the VPS. Test restores periodically — untested backups don't exist.

**Monitoring and logs.** `kamal logs -r web -f` and `kamal app exec` cover most ops. Set Docker log rotation in `/etc/docker/daemon.json` (`max-size: 10m`, `max-file: 5`) or disk will fill in weeks. For aggregation, **Better Stack** (hosted) is the simplest Rails/Docker integration; Loki + Grafana Cloud free tier is the self-hosted option. For metrics, **Netdata** installs in one line; kamal-proxy exposes Prometheus metrics on port 9090. For APM, AppSignal bundles errors, traces, and host metrics in one Ruby-first tool; Honeybadger is excellent for errors + uptime + cron alone. For uptime, **Upright** (37signals' own open-source tool) runs synthetic checks from cheap VPS nodes via Kamal.

**The hardening checklist is mundane but essential.** Always add swap (2–4 GB on a 4 GB box) or Postgres and Docker builds will OOM during deploys. `timedatectl set-timezone UTC` and install `chrony` for NTP — TLS depends on accurate time. `ufw default deny incoming; ufw allow 22,80,443/tcp` and layer the Hetzner Cloud Firewall above it. Install `fail2ban` for SSH, disable password auth, change to a non-root `deploy` user in the `docker` group. Install `unattended-upgrades` for security patches. Bind Postgres to `127.0.0.1` or a private IP, never publicly. Use `asset_path: /rails/public/assets` so in-flight requests to the old container can still load fingerprinted assets during a deploy. Put `bin/rails db:prepare` in `bin/docker-entrypoint`. Kamal is imperative and low-magic; the operational discipline is just Linux.

The **"fizzy infrastructure" post** sits over all this as a reminder: 37signals themselves tried to get more clever than vanilla, built real software to do it (Beamer, kamal-proxy load balancing, the optimistic read-after-write trick), and decided at the eleventh hour to ship boring MySQL. The deep lesson for a solo developer isn't "don't experiment"; it's "ship the boring thing, and keep the interesting experiments as your next year's optionality." Kamal 2 on a Hetzner box is the boring thing. It is also, right now, one of the highest-leverage deployment setups in the industry.

---

## 6. Multi-tenancy for a consumer app

Consumer apps reach for multi-tenancy the moment they support collaboration — families, teams, workspaces, households, shared libraries. The **default choice is row-level tenancy via an `Account` (or `Team`/`Workspace`) model**, with `Membership` joining users to accounts, and every tenanted table carrying `account_id`. The code pattern in §3 is the shape to use. `acts_as_tenant` is the battle-tested gem wrapper and handles uniqueness validations, Action Cable connection helpers, and `ActsAsTenant.with_tenant` blocks for jobs and rake tasks. Roll your own if you want to understand every line; use the gem if you want to ship faster.

Key decisions for a consumer app. **Subdomains vs. path-based** tenant resolution: subdomains (`acme.myapp.com`) feel more like SaaS and give you natural cookie isolation between tenants; path-based (`myapp.com/acme`) is simpler to ship and friendlier to consumer contexts where users might belong to several accounts. **Single-owner vs. multi-member accounts**: even a "solo consumer" app tends to evolve toward sharing — a notes app becomes a family notes app; a budgeting app becomes a household one. Build the `Account`+`Membership` structure from day one even if the first N releases only allow one member; it costs nothing early and is painful to retrofit. **Cross-tenant entities** (the global User record, profile photos, social graph): keep them in the public/untenanted tables, and index them separately. This is exactly what tripped up 37signals' per-tenant-SQLite Fizzy plan.

Ship with row-level. Watch `activerecord-tenanted` as it matures through ONCE products and eventually Rails itself. The database-per-tenant option will become more reachable over the next year or two, but it is not the right bet for a solo developer starting today.

---

## 7. Performance and scaling on vanilla Rails

The performance playbook is nearly all built-in features used well. **Russian-doll caching** with `cache(record)` on nested partials — the outer cache busts on change but reuses the inner fragments. Solid Cache's huge, long-lived footprint means you cache more aggressively than you could with Redis. Tag it with the tenant: `cache([Current.account, project]) do … end`.

**N+1 queries** are the biggest performance issue in most Rails apps and the easiest to fix. Run `bullet` in development to catch them. Enable **strict loading** per-model (`self.strict_loading_by_default = true`) on anything that ever renders a collection view, and let test failures force explicit `includes`. Know the difference: `preload` always emits a second query, `eager_load` always produces a JOIN, and `includes` picks — use `includes` with `references(:association)` when you need to filter on the association. For bulk data pipelines, `pluck(:id)` avoids model instantiation; `find_each` and `in_batches` keep memory flat; `update_all` and `delete_all` skip callbacks (which you want here, not usually).

**Push Postgres before reaching for extra services.** Full-text search via `to_tsvector` + GIN indexes, ideally with a stored generated column, handles millions of rows with sub-100 ms queries — the `pg_search` gem adds the DSL sugar when you want it. JSONB with `GIN (column jsonb_path_ops)` indexes covers semi-structured data. Partial indexes (`WHERE published_at IS NOT NULL`) cut hot-index size. Counter caches via `belongs_to :post, counter_cache: true` eliminate `COUNT(*)` queries on association pages. None of this requires Elasticsearch, Redis, or a separate service.

**HTTP caching** is underused. `fresh_when @post, public: true` plus `expires_in 5.minutes, public: true` turns repeat requests into 304s served by Thruster or the CDN without ever touching Rails. Combine with Cloudflare in front and your effective capacity multiplies.

**Turbo is a performance strategy**, not just a UX one. Less JavaScript shipped means faster initial loads; Turbo Drive keeps the document mounted so subsequent navigations skip JS reparse; Turbo Frames scope updates so you don't re-render the whole page; Turbo Streams push HTML fragments over WebSockets. The combination produces SPA-feeling interactivity with server-rendered HTML, which is vastly cheaper to operate than a React + JSON API stack.

**How far does this take you?** Berkopec's canonical answer is that most Rails apps never need more than one server. A 4 GB Hetzner box with Puma at 2 × 5, Solid Cache filling disk, and disciplined caching can sustain several hundred requests per minute with 50–100 ms response times — and with caching, cheap DB tuning, and Cloudflare doing edge work, that scales 5–10× before you need anything more. DHH's cited data point: 37signals engineers routinely optimize critical endpoints *"from 4 ms to under 0.5 ms."* 37signals' cloud exit saves on the order of $1.5M/year serving Basecamp and HEY on their own hardware. The ceiling for a solo consumer app on a single well-tuned VPS is almost certainly above wherever you'll be when the business is working.

---

## 8. Solo developer and AI-assisted workflow

Rails is disproportionately good for AI-assisted development for structural reasons. **Convention over configuration collapses context requirements**: an agent (Claude, Copilot, Cursor) can reliably guess that a `Post` model lives at `app/models/post.rb` and its controller at `app/controllers/posts_controller.rb`, that routes are in `config/routes.rb`, and that tests mirror the structure under `test/`. DHH, speaking on The Pragmatic Engineer in April 2026: *"Rails is one of the most token-efficient ways of building web apps and is well-suited for agent workflows. Testing is part of the framework, which helps agents write tests and validate their own outputs."* He now runs a tmux + neovim split-pane setup with Gemini and Claude Opus and "barely writes code by hand."

**Fixtures beat factories for AI.** Static YAML under `test/fixtures/` is deterministic, visible in the repo, and reasonable for an agent to read directly; FactoryBot requires tracing trait chains through Ruby code with sequences and callbacks. Fixtures also load once per suite inside transactions, which keeps iteration fast — important when you're having the agent write and run tests in a loop.

**The built-in productivity primitives matter even more with an AI pair.** `rails g model Post title:string body:text user:references` produces migration, model, test, and fixture in one command — ideal scaffolding for the agent to iterate on. `rails g scaffold` gets you a full CRUD skeleton in seconds. `rails runner "Post.where(...).update_all(...)"` runs one-off scripts without ceremony. `rails console` with the full app loaded lets the agent inspect data directly. Generators exist for migrations, models, mailers, jobs, channels, and tests — every one of them produces the canonical layout.

**What to avoid** in this workflow is the same as in vanilla Rails generally, but with higher stakes. Premature service objects scatter behavior across `app/services/`, `app/interactors/`, `app/operations/` — the agent has to chase indirection to find where `User.create!` actually runs. Over-abstract patterns (dry-rb value objects, hexagonal architecture, heavy DI) obscure the "find the controller, find the model" convention. Gem-heavy replacements (Devise, Sidekiq, Pundit used for simple policies) add DSLs the agent must learn alongside Rails itself. **Every deviation from vanilla is a line item the LLM has to relearn.** Keep the stack small, keep the layout canonical, keep tests as fixtures-and-assertions, and the agent's hit rate climbs.

One practical habit: **commit after every green test**, because an AI agent in agentic mode will sometimes refactor widely and you want cheap rollbacks. Use `bin/ci` (Rails 8.1's local CI DSL) to bundle RuboCop, Brakeman, bundler-audit, and tests into one command the agent can run before it hands a change back to you.

---

## 9. Basecamp SDK and 37signals open source

The **[basecamp-sdk](https://github.com/basecamp/basecamp-sdk)** repo is the most recent signal about how 37signals thinks about API design. It's Smithy-IDL-driven (one spec generates OpenAPI 3.1 and clients in Ruby, Go, TypeScript, Swift, Kotlin), classic REST rather than GraphQL or gRPC, with OAuth 2.0 + PKCE, ETag-based HTTP caching opt-in across clients, automatic retry with exponential backoff respecting `Retry-After`, Link-header pagination (RFC 5988), and webhook signature verification built in. The Ruby client uses Faraday with `faraday-http-cache`. The pattern is *"boring, HTTP-native, spec-generated"* — the same bet on HTTP and conventions that underpins Rails itself.

The broader 37signals open-source landscape reinforces the vanilla-Rails philosophy by letting you **delete something from a typical stack** with each adoption:

| Project | Role | What it lets you delete |
|---|---|---|
| **Kamal** | Container deploy over SSH | Heroku, Render, Fly, K8s |
| **kamal-proxy** | Go reverse proxy with TLS + rolling deploys | Traefik, Nginx, cert-manager |
| **Thruster** | In-container HTTP/2 proxy for Puma | Nginx in front of app, separate TLS |
| **Solid Queue** | DB-backed Active Job | Sidekiq + Redis |
| **Solid Cache** | DB-backed Rails.cache | Memcached, Redis cache |
| **Solid Cable** | DB-backed Action Cable | Redis pub/sub |
| **Mission Control — Jobs** | Web UI over Active Job | Sidekiq Web, Resque Web |
| **Turbo + Stimulus + Hotwire** | HTML-over-the-wire UX | React, Vue, JSON API |
| **Hotwire Native / Strada** | Bridge components for native mobile | Separate native codebases |
| **Trilogy** | Lean MySQL client (default since 7.1) | libmysqlclient dependency |
| **Marginalia** | SQL comments for AR queries | Manual trace instrumentation |
| **Geared Pagination** | Variable-size cursor pagination | Kaminari for infinite feeds |
| **Lexxy** | New rich-text editor | Trix (now older) |
| **Active Storage Office Previewer** | LibreOffice previews | External conversion service |
| **Once-Campfire / Writebook** | Full-source self-hosted products | Cloud chat/docs services |
| **activerecord-tenanted** | DB-per-tenant multi-tenancy | Apartment |
| **Upright** | Synthetic uptime monitor on Kamal | Pingdom, Uptime Robot |

The unifying theme is sovereignty: each tool takes a piece of infrastructure that had drifted to a SaaS or a cloud service and puts it back in your own repo, on your own server, run by your own Rails process or Docker container.

---

## 10. Recommended starter stack

Here is the consolidated checklist for the user's Rails 8 consumer app. Work through it in order.

**Setup and defaults.** `rails new myapp --database=postgresql` on Rails 8.1+. Accept all defaults: Solid Queue, Solid Cache, Solid Cable, Propshaft, import maps, Hotwire, Thruster, Kamal, Minitest. Skip only if you have a specific reason. Add `bcrypt` and run `bin/rails generate authentication`; layer OmniAuth if you want social login.

**Domain model.** Start with an `Account` + `User` + `Membership` structure even if the first version only allows one member per account. Include a `Tenanted` concern on every account-owned model. Use `ActiveSupport::CurrentAttributes` for `Current.account`, `Current.user`, `Current.membership`, set in `ApplicationController`. Back uniqueness validations with DB indexes; enforce invariants with `NOT NULL`, `CHECK`, and foreign keys.

**Architecture discipline.** Fat models with concerns for organization and POROs for real decomposition. Controllers call `model.action`; models delegate to POROs in `app/models/`. No `app/services/`, `app/interactors/`, `app/operations/`, or `app/forms/` directory. Reach for a delegated type if you have multiple content-like entities sharing lifecycle; reach for a form object only when one form writes to multiple models; reach for a query object only when a search chains several optional filters.

**Gems beyond defaults**: `pagy`, `image_processing` + `ruby-vips`, `aws-sdk-s3` (for S3 / Cloudflare R2), `pay` if you take subscriptions, `faraday` + `faraday-retry` for outbound HTTP, `rack-attack` for IP throttling, `honeybadger` (or `appsignal`), and — if your content needs it — `redcarpet` + `rouge`. That's it. Resist the rest.

**Testing.** Minitest + fixtures + Capybara + webmock. Parallelize. Keep system tests sparse; put branch coverage in model and controller tests. Write fixtures that tell a coherent story across the app, not minimal isolated objects.

**Frontend.** Import maps, Turbo, Stimulus. No bundler unless you have to. Plain CSS with modern features; use `cssbundling-rails` only if you genuinely need PostCSS or Tailwind's JIT. Make the app a PWA — Rails 8 scaffolds the manifest.

**Deployment.** Kamal 2 to a Hetzner CPX22 in a region near your users. Postgres as a Kamal accessory on the same VPS bound to `127.0.0.1`. `postgres-backup-s3` accessory writing nightly dumps to Cloudflare R2. Cloudflare in front of the app for CDN and DDoS. kamal-proxy with `ssl: true` handling Let's Encrypt. Thruster inside the container. Non-root `deploy` SSH user, UFW, fail2ban, unattended-upgrades, 4 GB swap, NTP via chrony, Docker log rotation. 1Password CLI for secrets. `/up` health endpoint wired to kamal-proxy. Run the `bin/jobs` Solid Queue supervisor as a separate role so web restarts don't drop jobs.

**Observability.** Honeybadger or AppSignal for errors. Better Stack for log aggregation if you want it, Netdata on the host for metrics, Upright or UptimeRobot for uptime checks. Mission Control at `/jobs` for background job introspection.

**Performance.** Bullet in development, `strict_loading_by_default` in test, `fresh_when` on show/index actions, Russian-doll caching on collection partials with the tenant in the cache key. Postgres full-text search before anything external. Counter caches on frequently-counted associations.

**AI-assisted workflow.** Commit frequently. Use `bin/ci` to run the full local suite. Keep the layout canonical and the gemset small so the agent's context requirements stay low. Prefer fixtures over factories. Use scaffolding and generators as first drafts for the agent to refine.

---

## Conclusion

The vanilla Rails bet is not "Rails is fine" — it is that **the framework's defaults are now better than anything a small team would assemble themselves**, and that every deviation should be justified against the cost of learning, maintaining, and eventually replacing it. Rails 8 has absorbed the deployment stack (Kamal, Thruster, kamal-proxy), the background-job stack (Solid Queue, Mission Control), the cache and pub/sub stacks (Solid Cache, Solid Cable), the asset pipeline (Propshaft, import maps), the frontend (Hotwire), the authentication skeleton, and even — in 8.1 — the local CI runner. What was a framework five years ago is now a *product*, and a product optimized for exactly the shape of developer this user is: solo, AI-assisted, shipping a consumer web app, with neither the time nor the need to become an infrastructure specialist.

The most important insight from the Fizzy infrastructure post-mortem isn't that 37signals got it wrong — it's that *they* could build Beamer and Active Record Tenanted and kamal-proxy load balancing over a year and still decide that boring MySQL was the right ship. A solo developer's decision space is strictly narrower. Boring is the right bet. Ship the monolith on the Hetzner box with the Solid trifecta and the authentication generator and fixtures and Pagy and Postmark and Honeybadger, and spend the saved complexity budget on the product itself. That is what vanilla Rails is for, and it is, genuinely, plenty.