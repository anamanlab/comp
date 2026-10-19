# Deploy "your own version" of Comp (trycompai/comp) to Vercel Hobby (free)

> **Alternative assessed:** `CLOUDFLARE_DEPLOY_PLAN.md` — Cloudflare Containers (Workers Paid $5/mo)
> requires far less porting than this Vercel plan, has no non-commercial clause, and Neon + R2 cover
> the backing services. Read that file first if the goal is "working app" rather than "Vercel".
> This document remains the plan if Vercel is a hard requirement.

Status: plan only — no code changes made yet beyond repo setup.
Working copy: `/home/civo/comp` (separate from `/home/civo/braluma2`)
Upstream pinned: `trycompai/comp` @ `0117612` (v1.50.0), branch `feat/vercel-free-deploy`, remote `upstream` = trycompai/comp

---

## 0. TL;DR

Upstream Comp **does not support Vercel** — it ships a build-blocker and deploys via Docker → AWS ECS.
Getting your own version on Vercel free is therefore a real porting job, not a "connect Git and deploy".

The plan below gets you to a working, free-tier deployment in three gated stages:

| Stage | Goal | Gate |
|---|---|---|
| 0 | Reproduce a working local build (proves the fork compiles) | `next build` succeeds locally |
| 1 | Make `apps/app` deployable to Vercel (build pipeline, no `..` coupling) | Vercel preview deploy serves HTTP 200 |
| 2 | Provision free backing services, migrate + seed DB, go production | `/api/health` 200, login works, no Stripe needed |

**Two blockers must be resolved before anything else** (details in §2): upstream's `vercel-build.sh` blocker, and the fact that the app cannot build from a Vercel Root Directory because it depends on files outside it.

---

## 1. What I verified (evidence, not assumptions)

**Repo shape**
- Bun/Turbo monorepo: root `package.json` declares `workspaces: ["apps/*", "apps/browser-extension/*", "!apps/mcp-server", "packages/*"]`, `packageManager: bun@1.3.4`, `bun.lock` (1.2 MB).
- Apps: `api`, `app`, `browser-extension`, `framework-editor`, `mcp-server`, `portal`. The deployable customer app is `apps/app` (93 pages, 40 API route handlers, health check at `apps/app/src/app/api/health`).
- `apps/app`: Next.js 16.2.6, React 19, Prisma 7.6.0 (`@prisma/adapter-pg`), better-auth 1.6, Trigger.dev 4.4.3, Stripe, S3, Resend, OpenAI/Groq, Firecrawl, Upstash, PostHog, Sentry.
- 290 Prisma migrations (`packages/db/prisma/migrations`, 2.4 MB) + seed (`packages/db/prisma/seed`, 1.7 MB).
- 7,127 tracked files / 19 MB — **inside** Vercel's CLI limits (15,000 files / 100 MB).

**Local tooling available**
- `git`, `gh` (authed as `anamanlab`), `node v22.23.3`, `pnpm 10.27.0`, **`bun 1.4.3`**, `docker`, `psql`.
- `vercel` CLI 63.1.2, authed as `adesouza0021-4955`. Disk: 47 GB free.

**Upstream's deploy target is Docker, not Vercel**
- `Dockerfile`: 6 stages (deps → migrator → app-builder → app → portal-builder → portal), `NEXT_OUTPUT_STANDALONE=true`, `NODE_OPTIONS=--max_old_space_size=6144`.
- `deploy.sh` = AWS ECS deploy. `buildspec.yml` = AWS CodeBuild fragment.
- `apps/app/vercel.json` and `apps/portal/vercel.json` exist but only set `"regions": ["iad1"]` — no build config.
- **`apps/app/vercel-build.sh` contains `#!/bin/bash` + `exit 1`** → Vercel picks this up as the build command. Upstream deliberately blocks Vercel builds. Must be removed/renamed.

**Build-graph landmine (partially resolved — see the tsconfig paths note)**
- `packages/ui`, `email`, `kv`, `analytics`, `billing`, `auth`, `integration-platform` all declare `main`/`exports` pointing at `./dist/*`.
- `.gitignore:87` ignores `packages/*/dist` → **no `dist/` exists in a fresh clone** (verified: all 9 packages have no `dist`).
- **Resolution actually happens in two different ways**, and this is the key insight:
  - `apps/app/tsconfig.json` `paths` maps `@trycompai/ui`, `/email`, `/kv`, `/analytics`, `/integrations`, `/integration-platform`, `/utils` → **`../../packages/*/src/...` (source)**. These are resolved from source by Next's tsconfig-path support, so they need **no `dist/`**. (Verified: the app imports `@trycompai/ui` 990 times but never declares it as a dependency — it resolves purely via tsconfig paths + hoisting.)
  - `@trycompai/auth`, `/billing`, `/company`, `/db` are **not** in tsconfig paths, are declared as `workspace:*` deps, and resolve through node_modules → `exports` → `./dist/*`. **These four genuinely need `dist/`.**
- Consequence: `turbo run build --filter=@trycompai/app...` builds exactly the right set. Dry-run confirms **18 tasks**: `app#build`, `app#db:generate`, and `build` + `db:generate` for `auth`, `billing`, `company`, `db`, `email`, `integration-platform`, `tsconfig`, `utils`.
- `turbo.json`: `build` task `dependsOn: ["^build", "db:generate"]` → turbo builds workspace deps first. The upstream Dockerfile bypasses turbo and only compiles `packages/db`.
- Published to npm: `@trycompai/db@2.3.1`, `@trycompai/ui@1.3.2`, `@trycompai/email@1.0.0`, `@trycompai/kv@1.0.0`, `@trycompai/design-system@1.1.19`.
- **Not published**: `@trycompai/billing`, `@trycompai/auth`, `@trycompai/company`, `@trycompai/integration-platform` → must be built from source inside the Vercel build scope.

**Vercel Root Directory constraint — RESOLVED**
- `apps/app` build reads outside its own directory: `prebuild` → `db:getschema` copies `packages/db/prisma/schema/*.prisma` into `apps/app/prisma/schema/`; then `node ../../packages/db/scripts/fix-generated-extensions.js`. The tsconfig `paths` also point to `../../packages/*`. `next.config.ts` sets `outputFileTracingRoot = <repo root>` and `turbopack.root = <repo root>`.
- Vercel docs (Root Directory) say *"Your app will not be able to access files outside of that directory. You also cannot use `..` to move up a level."*
- **But** Vercel's monorepo FAQ documents the escape hatch: *"To access source files outside of the Root Directory, enable the **Include source files outside of the Root Directory in the Build Step** option in the Root Directory section within the project settings. Vercel projects created after August 27th 2020 23:50 UTC have this option **enabled by default**."*
- → **Root Directory = `apps/app` IS viable for a newly created project.** Confirm the toggle is ON after project creation. No vendoring required.


**Env contract** (`apps/app/src/env.mjs`, `skipValidation` when `CI`/`SKIP_ENV_VALIDATION` set)
- Required: `AUTH_SECRET`, `DATABASE_URL`, `RESEND_API_KEY`, `REVALIDATION_SECRET`, `NEXT_PUBLIC_PORTAL_URL`.
- Optional but load-bearing: `OPENAI_API_KEY`/`GROQ_API_KEY`, AWS S3 creds, `TRIGGER_SECRET_KEY`/`TRIGGER_API_KEY`, `UPSTASH_REDIS_REST_*`, `UPSTASH_VECTOR_REST_*`, `FIRECRAWL_API_KEY`, `DUB_API_KEY`, `NOVU_API_KEY`.
- Build-time (baked into the client bundle): `NEXT_PUBLIC_SELF_HOSTED`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_POSTHOG_*`, `NEXT_PUBLIC_API_URL`.
- **`NEXT_PUBLIC_SELF_HOSTED=true` auto-approves orgs and bypasses Stripe/billing** (`create-organization-minimal.ts`, `upgrade/[orgId]/page.tsx`). No Stripe account needed.

**SSL/DB** (`packages/db/src/ssl-config.ts`): any non-localhost URL gets `{ checkServerIdentity: () => undefined }` — TLS with chain verification, hostname check skipped. Works with Neon/Supabase; `PRISMA_ALLOW_INSECURE_TLS=1` is the escape hatch.

---

## 2. The two blockers

### Blocker 1 — upstream build blocker
`apps/app/vercel-build.sh` contains `#!/bin/bash` + `exit 1`. Vercel supports a root-level
`vercel-build.sh` as an alternative build command; regardless of whether it takes precedence over the
npm `build` script here, upstream clearly intends to block Vercel builds (their production path is
Docker → ECS).
**Fix:** delete it (`git rm apps/app/vercel-build.sh`). Trivial, but mandatory — do not skip it.

### Blocker 2 — the app is not self-contained
Three separate couplings to the repo root:
1. `prebuild` → `../../packages/db/prisma/schema` (combined Prisma schema)
2. `prebuild` → `../../packages/db/scripts/fix-generated-extensions.js`
3. `next.config.ts` → `outputFileTracingRoot: <repo root>`, `turbopack.root: <repo root>`

Plus the `dist/` landmine (§1) and 4 unpublished workspace packages.

**Fix (Shape C, below):** make `apps/app` build with nothing outside its own directory.

---

## 3. Target architecture

```
/home/civo/comp/                     your fork (github.com/anamanlab/comp, public)
├── apps/app/                        ← THE ONLY THING VERCEL DEPLOYS  (Root Directory)
│   ├── vercel.json                  ← installCommand + buildCommand + regions
│   └── package.json                 ← unchanged
├── apps/portal/                     optional 2nd Vercel project (public trust portal)
├── packages/*                       ← read by the build via tsconfig paths (allowed: see below)
└── vercel/
    └── env.production.example       ← full env matrix, redacted
```

### Shape A — "Root Directory = `apps/app`" (RECOMMENDED)
Keep the monorepo exactly as upstream has it. Point the Vercel project's **Root Directory** at
`apps/app` and let Vercel's default Next.js builder find `next.config.ts` there.

Build:
```
bunx turbo run build --filter=@trycompai/app... --env-mode=loose
```
- The filter builds exactly the four packages that need `dist/` (`auth`, `billing`, `company`, `db`);
  everything else resolves from source through tsconfig paths.
- `--env-mode=loose` is **required**: turbo's default strict env mode strips undeclared vars, which
  would drop `SKIP_ENV_VALIDATION` and `NODE_OPTIONS` before `next build` ever sees them.

The build reads outside `apps/app` (tsconfig paths, `../../packages/db`, `outputFileTracingRoot`).
Vercel permits this via the project setting **"Include source files outside of the Root Directory in the
Build Step"**, which is **enabled by default on projects created after 2020-08-27**. Verify the toggle
is ON right after creating the project.

### Shape C — "self-contained app" (FALLBACK, only if Shape A is blocked)
Vendor the 4 unpublished packages under `apps/app/vendor/`, commit the combined Prisma schema, point
`db:generate` at the local copies, add the vendored packages to `transpilePackages`, and reset
`outputFileTracingRoot` to `apps/app`.

Why it exists: it removes every `..` dependency, making the build hermetic and immune to the Root
Directory setting. Costs: a much larger fork delta and ongoing merge friction against upstream.

### Shape B — "Builds API" (`builds: [{ src: "apps/app/next.config.ts", use: "@vercel/next" }]`)
Legacy escape hatch that decouples the app dir from the project root. Keep in the back pocket.

**Decision rule:** try Shape A first (Gate 1). If the preview build fails specifically on missing
`../../packages/*` files, switch the project setting off and execute Shape C.


---

## 4. Free-tier reality check (verified against Vercel docs, Oct 2026)

### Vercel Hobby
| Limit | Hobby value | Relevance |
|---|---|---|
| Build time / deployment | 45 min | Tight for a monorepo Next build. `turbo` cache + filtered install are essential. |
| Build memory | 8 GB | Docker uses `--max_old_space_size=6144`. Set `NODE_OPTIONS=--max_old_space_size=6144` on Vercel too. |
| Function duration | 300 s (max) | Fine; long jobs belong in Trigger.dev anyway. |
| Function memory / CPU | 2 GB / 1 vCPU (max) | Prisma + node-postgres fine; heavy PDF/browser work is not. |
| Active CPU time | **4 hrs / month** | The tightest real limit. A compliance dashboard with polling could burn this. |
| Function invocations | 1M / month | Fine. |
| Bandwidth | 100 GB / month | Fine. |
| Deployments | 100/day, 100 builds/hour, **1 concurrent build** | 1 concurrent build means every push serialises. Use branch previews sparingly. |
| Disk | 32 GB | Fine. |
| Runtime logs retention | 1 hour | Debugging is painful — capture logs during deploy. |
| CLI deploy limits | 15,000 files / 100 MB | Repo is 7,127 / 19 MB. OK. |
| Git integration | Cannot connect Git **organization** repos | `anamanlab` is a personal account → fine. |

### Backing services (all have usable free tiers)
| Service | Free tier | Role | Notes |
|---|---|---|---|
| **Neon Postgres** | 1 GB storage/project, 100 CU-hrs/mo, 5 GB egress, scale-to-zero after 5 min | Primary DB | Vercel Postgres no longer exists (moved to Neon Dec 2024). Use the **pooled** endpoint; cold start ~1–3 s after suspend. |
| **Cloudflare R2** | 10 GB storage, 1M Class A / 10M Class B ops | Attachments/S3 | The app already supports S3-compatible endpoints via `APP_AWS_ENDPOINT` → point it at R2. |
| **Resend** | 3,000 emails/mo (100/day) | Transactional email | `RESEND_API_KEY` is required by env validation. |
| **Trigger.dev** | $5/mo credits, 20 concurrent runs | Async jobs (67 task files) | Tasks stop when credits run out — acceptable for a demo. |
| **Upstash Redis** | 10k commands/day | Rate limiting | Optional. |
| **Groq** | Free tier | AI chat / policy generation | `OPENAI_API_KEY` is optional in env validation, so AI can be deferred. |
| **Firecrawl** | 500 credits | Vendor research | Optional. |
| **Upstash Vector** | Free tier | Knowledge base | Optional. |

### Two constraints that are not technical
1. **Vercel Hobby is personal / non-commercial use only.** Vercel's Fair Use Guidelines define commercial
   usage as *"any Deployment that is used for the purpose of financial gain of anyone involved in any
   part of the production of the project"* — explicitly including *"any method of requesting or
   processing payment from visitors of the site"*, advertising, and affiliate linking. Your other repos
   (`optivoo-saas`, `emcampo`, `everything`) are commercial SaaS products. If "my own version" of Comp
   is a revenue product, Hobby violates Vercel's ToS → you need Vercel Pro ($20/mo) or self-host the
   Docker image. Hobby is fine for a personal/portfolio/demo deployment. (Note: `NEXT_PUBLIC_SELF_HOSTED=true`
   removes Stripe from the app, but that does **not** make the *deployment* non-commercial.)
2. **AGPL-3.0.** Comp is AGPL-3.0. If you modify it and offer it to users over a network, AGPL §13
   obliges you to offer the **corresponding source of your modified version** to those users, and to
   retain the `LICENSE` and copyright notices. Keep the repo public (or publish a source link) and do
   not strip attribution.

---

## 5. Execution plan

### Stage 0 — Local build proof (no Vercel yet)
**Why first:** the `dist/` landmine and the unpublished packages mean the build is the highest-risk
unknown. Never discover it on a 45-minute Vercel build.

0.1 Install
```bash
cd /home/civo/comp
bun install --frozen-lockfile          # bun 1.4.3 is installed; repo pins bun@1.3.4
```
0.2 Build the workspace deps and the app exactly as Vercel would
```bash
bunx turbo run build --filter=@trycompai/app...
```
0.3 Confirm the compiled artefacts exist (this is the part upstream's Dockerfile skips)
```bash
ls packages/ui/dist/index.js packages/email/dist/index.mjs packages/kv/dist/index.js \
   packages/billing/dist/index.js packages/integration-platform/dist/index.js \
   packages/auth/dist/index.js packages/db/dist/index.js
```
0.4 Provide throwaway env so `next build` can typecheck (env validation is skipped under `CI`)
```bash
cd apps/app
CI=1 SKIP_ENV_VALIDATION=true NODE_OPTIONS=--max_old_space_size=6144 \
  NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:3000 \
  NEXT_PUBLIC_PORTAL_URL=http://localhost:3002 \
  NEXT_PUBLIC_SELF_HOSTED=true bunx next build
```
**Gate 0:** `next build` completes and `apps/app/.next` exists. Record the wall-clock time — that number
is your Vercel build budget (must be < 45 min with margin). If it OOMs, raise `NODE_OPTIONS` and
confirm the 8 GB build container is enough.

**Fallback if the build fails:** `docker compose build app` exercises the same `next build` in the
upstream-supported path and gives you a comparison build log.

### Stage 1 — Vercel-ready fork (the actual port)
1.1 Create the fork (needed for git-connected deploys; Hobby can't connect org repos, but a personal
fork is fine)
```bash
gh repo fork trycompai/comp --clone=false --remote=false   # →.anamanlab/comp
cd /home/civo/comp && git remote add origin git@github.com:anamanlab/comp.git
```
> Done: `github.com/anamanlab/comp` (public — also satisfies AGPL-3.0 §13). Use the HTTPS remote; the
> account has no SSH host key for github.com and `gh` provides an HTTPS credential helper.
1.2 Remove the build blocker
```bash
git rm apps/app/vercel-build.sh
```
1.3 Write `apps/app/vercel.json` (Shape A — adjust after the probe)
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["iad1"],
  "framework": "nextjs",
  "installCommand": "bun install --frozen-lockfile",
  "buildCommand": "bunx turbo run build --filter=@trycompai/app...",
  "build": { "env": { "SKIP_ENV_VALIDATION": "1", "NODE_OPTIONS": "--max_old_space_size=6144" } }
}
```
1.4 Pin the Bun version so the Vercel build matches local
- Root `package.json` already has `"packageManager": "bun@1.3.4"` → Vercel honours it. Local bun is
  1.4.3; if the build diverges, install bun 1.3.4 locally for parity.
1.5 Make `apps/app` self-contained (Shape C) **if** the probe in 1.6 fails
- `git mv packages/billing packages/auth packages/company packages/integration-platform apps/app/vendor/`
- Rewrite `apps/app/package.json` deps: `"@trycompai/billing": "file:./vendor/billing"` etc.
- Commit the combined Prisma schema into `apps/app/prisma/schema/` and change `db:getschema` to copy
  from the local dir instead of `../../packages/db/prisma/schema`.
- Copy `packages/db/scripts/fix-generated-extensions.js` → `apps/app/prisma/generate/`.
- Add the 4 vendored packages to `transpilePackages` in `apps/app/next.config.ts`.
- Reset `outputFileTracingRoot` to `__dirname` (remove the `..` escape).
1.6 Probe deploy (fast feedback, no DB yet)
```bash
cd /home/civo/comp
vercel link --yes                        # create project 'comp-app' on adesouza0021-4955
vercel env add DATABASE_URL preview      # dummy value; env validation is skipped in CI
vercel deploy                            # preview
```
**Gate 1:** the deployment reaches `Ready` and the build log shows `next build` completing (not a
`..`-permission error, not a missing `dist/…` module error). Inspect with `vercel logs <url>` or
`vercel inspect`.

### Stage 2 — Free backing services + production
2.1 Provision Neon
- Create a Neon project (Free, 1 GB), then a branch `prod`.
- Use the **pooled** connection string for `DATABASE_URL`:
  `postgresql://USER:PASS@ep-xxx-pooler.<region>.aws.neon.tech/comp?sslmode=require`
- Note: Neon Free suspends compute after 5 min idle. Accept ~1–3 s cold start, or use the non-pooled
  host with `pgbouncer=false` if you prefer fewer moving parts.
2.2 Run migrations + seed from your machine (not in the Vercel build — 290 migrations in a build is slow
and racy, and Hobby has 1 concurrent build)
```bash
cd /home/civo/comp/packages/db
bunx prisma migrate deploy --schema=prisma/schema
bun run db:seed        # bun prisma/seed/seed.ts
```
2.3 Provision the rest of the free services
- Resend (domain + API key) → `RESEND_API_KEY`, `RESEND_FROM_*`
- Cloudflare R2 bucket + API token → `APP_AWS_ACCESS_KEY_ID`, `APP_AWS_SECRET_ACCESS_KEY`,
  `APP_AWS_REGION=auto`, `APP_AWS_BUCKET_NAME`, `APP_AWS_ENDPOINT=https://<account>.r2.cloudflarestorage.com`
- Trigger.dev (Free) → `TRIGGER_SECRET_KEY`, `TRIGGER_API_KEY`, then deploy the tasks:
  `cd apps/app && bunx trigger.dev@4.4.3 deploy`
- Upstash Redis (optional), Groq/OpenAI (optional), Firecrawl (optional)
2.4 Set production env on Vercel
```bash
vercel env add AUTH_SECRET production            # openssl rand -base64 32
vercel env add REVALIDATION_SECRET production    # openssl rand -base64 32
vercel env add DATABASE_URL production
vercel env add RESEND_API_KEY production
vercel env add NEXT_PUBLIC_SELF_HOSTED production true      # auto-approve orgs, no Stripe
vercel env add NEXT_PUBLIC_BETTER_AUTH_URL production https://<domain>
vercel env add NEXT_PUBLIC_PORTAL_URL production https://<portal-domain>
vercel env add BETTER_AUTH_URL production https://<domain>
vercel env add AUTH_TRUSTED_ORIGINS production https://<domain>
```
2.5 Promote
```bash
vercel --prod
```
**Gate 2:**
- `curl -fsS https://<domain>/api/health` → 200
- Sign up via email → org created and auto-approved (proves `NEXT_PUBLIC_SELF_HOSTED` took effect)
- No Stripe/payment screen appears
- Attachments upload to R2 succeeds
- One Trigger.dev task completes

2.6 Optional second project: the trust portal (`apps/portal`, `@trycompai/portal`) — same recipe, own
Vercel project, `NEXT_PUBLIC_PORTAL_URL` + `BETTER_AUTH_URL_PORTAL` pointed at it.

---

## 6. Risks and fallbacks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Build OOM on Vercel** | **Happened, then fixed** | Next.js runs type checking in a *separate* build worker. The Turbopack compile peaks first, then the TS worker (a second Node process inheriting `NODE_OPTIONS`) exceeds the 8 GB Basic build container → SIGKILL / `out_of_memory`. Fixed by gating `typescript.ignoreBuildErrors` on `SKIP_TYPES=1` in the Vercel build env; type checking stays covered by `bun run typecheck` (its own turbo task) locally and in CI. **Hobby is locked to the Basic build machine (2 vCPU / 8 GB)** — Enhanced (16 GB) and Turbo (60 GB) are Pro/Enterprise only. |
| Build exceeds 45 min on Vercel | Low | Local build: 5m46s on 6 CPUs. Vercel Basic has 2 vCPUs, so expect ~12–18 min — still well inside 45. Turbo cache + filtered install keep it down. |
| Vercel blocks `..` in Root Directory | Resolved | New projects have **"Include source files outside of the Root Directory in the Build Step"** enabled by default (API field `sourceFilesOutsideRootDirectory`, confirmed `true` on `comp-app`). Confirmed by a successful build that read `../../packages/db/prisma/schema`. |
| Missing `dist/` at build time | Resolved | `turbo run build --filter=@trycompai/app...` compiles the four packages that resolve via `./dist` (`auth`, `billing`, `company`, `db`); the rest resolve from source through tsconfig paths. Dry-run confirms 18 tasks. |
| Hobby 4 CPU-hrs/mo exhausted | Medium | Disable PostHog/Sentry, cache aggressively, keep polling client-side low-frequency. |
| Neon suspends between requests | Handled | Neon Free auto-resumes in a few hundred ms — a slow first request, not an error. Use the **pooled** endpoint so lambdas don't exhaust the connection limit. |
| Hobby ToS (non-commercial) | Certain if commercial | Pro $20/mo, or self-host the Docker image on a free container host. |
| AGPL source-disclosure obligation | Certain | The fork is public; keep it that way and keep `LICENSE` + notices. |
| Upstream drift | Ongoing | Keep the fork's diff small and isolated to `apps/app` + `vercel/`; rebase onto `upstream/main` periodically. |

**Fallback path if Vercel fails outright:** the repo's Docker path is upstream-supported and is a
better fit for a heavy compliance backend anyway — build the image and run it on a free container host
(Fly.io, Koyeb, or your own VPS with Docker). You already have Docker and `psql` on this machine, and
`docker-compose.yml` gives you `migrator` + `seeder` + `app` + `portal` out of the box.

---

## 7. Open decisions for you

1. **Commercial or demo?** Decides Hobby vs Pro vs self-host, and how much AGPL work you want to do.
2. **App only, or app + portal?** Portal is a separate Vercel project and adds a second deploy target.
3. **Which free services do you want wired up?** Minimum viable = Neon + Resend. Recommended = + R2 +
   Trigger.dev. Everything else is optional.
4. **How much do you want to diverge from upstream?** Shape C vendors 4 packages into `apps/app` — a
   bigger initial diff but a much more stable fork. Shape A keeps the monorepo pristine but is fragile.
5. **Your own domain, or `*.vercel.app`?** Domain affects `AUTH_TRUSTED_ORIGINS` and Resend domain
   verification.

---

## 8. Command reference

```bash
# repo
cd /home/civo/comp
git checkout feat/vercel-free-deploy

# local build proof
bun install --frozen-lockfile
bunx turbo run build --filter=@trycompai/app...

# vercel
vercel whoami                       # adesouza0021-4955
vercel link --yes
vercel deploy                       # preview
vercel --prod

# db
cd packages/db && bunx prisma migrate deploy --schema=prisma/schema && bun run db:seed

# background tasks
cd apps/app && bunx trigger.dev@4.4.3 deploy
```
