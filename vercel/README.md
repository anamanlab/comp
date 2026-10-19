# Comp on Vercel Hobby — environment & runbook

Your own version of [trycompai/comp](https://github.com/trycompai/comp) (AGPL-3.0), deployed to Vercel
Hobby at $0. Fork: https://github.com/anamanlab/comp

---

## 1. What runs where

| Piece | Where | Cost |
|---|---|---|
| Next.js app (`apps/app`) | Vercel project `comp-app`, Root Directory `apps/app` | $0 (Hobby) |
| Postgres | Neon project `comp-app` (`lively-wind-77614469`), region `aws-us-east-1` | $0 (Free: 1 GB) |
| Attachments / org assets | Cloudflare R2 buckets `comp-app-files`, `comp-app-questionnaires`, `comp-app-knowledge-base` | $0 (10 GB) |
| Transactional email | Resend (`comp@optvoo.com`) | $0 (3,000/mo) |
| Background jobs | Trigger.dev (67 tasks) | $0 ($5/mo credits) |
| Payments | **Disabled** — `NEXT_PUBLIC_SELF_HOSTED=true` auto-approves orgs | — |

## 2. Repo changes vs upstream

Two changes, both in `apps/app`:

1. **`vercel-build.sh` deleted.** Upstream shipped it containing `exit 1` — a deliberate Vercel
   build blocker (they deploy via Docker → AWS ECS).
2. **`apps/app/vercel.json`** added:

```json
{
  "regions": ["iad1"],
  "installCommand": "bun install --frozen-lockfile",
  "buildCommand": "bunx turbo run build --filter=@trycompai/app... --env-mode=loose",
  "build": {
    "env": {
      "SKIP_ENV_VALIDATION": "1",
      "NODE_OPTIONS": "--max_old_space_size=6144",
      "NEXT_TELEMETRY_DISABLED": "1"
    }
  }
}
```

Why each part matters:

- **`bun install --frozen-lockfile`** — the Root Directory is `apps/app`, but the lockfile lives at the
  repo root. Bun walks up and installs the whole workspace. Verified working.
- **`turbo run build --filter=@trycompai/app...`** — builds the four workspace packages that resolve
  through `./dist` (`auth`, `billing`, `company`, `db`). Every other `@trycompai/*` package resolves
  **from source** via `apps/app/tsconfig.json` `paths`, so it needs no build step. A plain `next build`
  fails with "module not found" on `packages/*/dist`.
- **`--env-mode=loose`** — turbo's default strict mode strips env vars not declared in `turbo.json`,
  which would drop `SKIP_ENV_VALIDATION` and `NODE_OPTIONS` before `next build` sees them.
- **`SKIP_ENV_VALIDATION=1`** — `apps/app/src/env.mjs` would otherwise fail the build when optional
  third-party keys are absent.

## 3. Vercel project settings (not in the repo)

| Setting | Value | Note |
|---|---|---|
| Root Directory | `apps/app` | Set in the dashboard / `PATCH /v10/projects/{id}` with `rootDirectory` |
| **Include source files outside of the Root Directory in the Build Step** | **ON** | Required — the build reads `../../packages/*`. On by default for projects created after 2020-08-27. API field: `sourceFilesOutsideRootDirectory` |
| Framework Preset | Next.js | Auto-detected |
| Node.js Version | 22 | Matches the repo's Dockerfile (`node:22-alpine`) |
| Bun version | 1.3.4 | From root `package.json` `packageManager` |

## 4. Environment variables

Set via the Vercel dashboard or API (`POST /v10/projects/{id}/env`). Scoped to **both** `preview` and
`production` unless noted.

### Required (app fails to boot without these)

| Key | Type | Value |
|---|---|---|
| `AUTH_SECRET` | sensitive | `openssl rand -base64 32` |
| `SECRET_KEY` | sensitive | `openssl rand -base64 32` — encrypts stored data |
| `REVALIDATION_SECRET` | sensitive | `openssl rand -base64 32` |
| `BETTER_AUTH_SECRET` | sensitive | `openssl rand -base64 32` |
| `DATABASE_URL` | encrypted | Neon **pooled** endpoint (see §5) |
| `RESEND_API_KEY` | encrypted | `re_…` |

### Required for correct behaviour

| Key | Value | Why |
|---|---|---|
| `NEXT_PUBLIC_SELF_HOSTED` | `true` | **Bakes into the client bundle.** Auto-approves orgs and bypasses Stripe/payment. Without it, users hit an upgrade wall. |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | `https://comp-app.vercel.app` | Must match the deployed domain |
| `NEXT_PUBLIC_PORTAL_URL` | portal domain | The employee portal runs as a separate deployment |
| `BETTER_AUTH_URL` | `https://comp-app.vercel.app` | Server-side auth base URL |
| `AUTH_TRUSTED_ORIGINS` | `https://comp-app.vercel.app` | Comma-separated |
| `RESEND_FROM_SYSTEM` | `Comp <comp@optvoo.com>` | Must be a verified Resend domain |
| `RESEND_FROM_DEFAULT` | `Comp <comp@optvoo.com>` | |

### Cloudflare R2 (S3-compatible)

| Key | Value |
|---|---|
| `APP_AWS_ACCESS_KEY_ID` | R2 API token access key id |
| `APP_AWS_SECRET_ACCESS_KEY` | R2 API token secret |
| `APP_AWS_REGION` | `auto` |
| `APP_AWS_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `APP_AWS_BUCKET_NAME` | `comp-app-files` |
| `APP_AWS_ORG_ASSETS_BUCKET` | `comp-app-files` |
| `APP_AWS_QUESTIONNAIRE_UPLOAD_BUCKET` | `comp-app-questionnaires` |
| `APP_AWS_KNOWLEDGE_BASE_BUCKET` | `comp-app-knowledge-base` |

### Optional

`OPENAI_API_KEY` / `GROQ_API_KEY` (AI chat, policy/risk generation) · `FIRECRAWL_API_KEY` (vendor
research) · `UPSTASH_REDIS_REST_URL` + `_TOKEN` (rate limiting) · `UPSTASH_VECTOR_REST_*` (knowledge
base) · `TRIGGER_SECRET_KEY` + `TRIGGER_API_KEY` (background jobs) · `NOVU_API_KEY` (notifications) ·
`DUB_API_KEY` (referrals) · `NEXT_PUBLIC_POSTHOG_KEY` + `_HOST` (analytics) · `NEXT_PUBLIC_APP_ENV`.

## 5. Neon connection string

Use the **pooled** endpoint. Vercel serverless functions are short-lived and highly concurrent; the
direct endpoint would exhaust Neon's connection limit.

```
postgresql://comp_owner:<password>@ep-empty-frog-b7zyzbj5-pooler.c-13.us-east-1.aws.neon.tech/comp?sslmode=require&channel_binding=require
```

`packages/db/src/ssl-config.ts` resolves TLS for any non-localhost host as
`{ checkServerIdentity: () => undefined }` — chain validation on, hostname check skipped. Works with
Neon; verified against both pooled and direct endpoints using node-postgres.

Neon Free suspends compute after 5 minutes idle and resumes in a few hundred milliseconds on the next
query — expect a slow first request after a gap, not an error.

## 6. Database bootstrap

```bash
cd packages/db
DATABASE_URL="<pooled url>" bunx prisma migrate deploy   # 290 migrations
DATABASE_URL="<pooled url>" bun prisma/seed/seed.ts      # frameworks, requirements, controls
```

Run these from your machine, **not** in the Vercel build. A 290-migration build step is slow and
races with concurrent deploys (Hobby allows only 1 concurrent build).

Verified end state: 156 tables, 21 MB, 23 frameworks, 1334 requirements, 204 control templates,
23 framework versions, 12 ISMS document templates.

## 7. Deploy

```bash
# one-time
vercel link --project comp-app --yes

# deploy
vercel deploy          # or: vercel --prod
```

The first build is the slow one (install + ~6 min build). Subsequent deploys reuse the turbo cache
and Vercel's build cache.

## 8. Remaining manual steps

1. **R2 API token** — Cloudflare dashboard → Workers & Pages → R2 → Manage R2 API Tokens →
   Create Account API Token → *Object Read & Write* scoped to the three `comp-app-*` buckets. Copy the
   **Access Key ID** and **Secret Access Key** into `APP_AWS_ACCESS_KEY_ID` /
   `APP_AWS_SECRET_ACCESS_KEY`. (There is no CLI/API path for this — the S3 endpoint requires
   HMAC-signed key pairs.)
2. **Trigger.dev login** — `cd apps/app && bunx trigger.dev@4.4.3 login`, then
   `bunx trigger.dev@4.4.3 deploy` to publish the 67 tasks. Put the resulting keys into
   `TRIGGER_SECRET_KEY` / `TRIGGER_API_KEY`.
3. **Optional portal** — `apps/portal` is a second Vercel project (`@trycompai/portal`), same recipe.
   Point `NEXT_PUBLIC_PORTAL_URL` and `BETTER_AUTH_URL_PORTAL` at it.
4. **Optional custom domain** — attach a route under an existing zone and update
   `AUTH_TRUSTED_ORIGINS`, `NEXT_PUBLIC_BETTER_AUTH_URL` and `BETTER_AUTH_URL`.

## 9. Hobby plan constraints to design around

| Limit | Hobby value | Practical effect |
|---|---|---|
| **Active CPU time** | **4 hours/month** | ≈70k–290k requests/month depending on page cost. The real ceiling. |
| Concurrent builds | 1 | Every push serialises; budget ~6 min per deploy |
| Build time | 45 min | Local build is ~6 min — comfortable |
| Function duration | 300 s | Fine; long work belongs in Trigger.dev |
| Function memory | 2 GB | Fine for Prisma + node-postgres |
| Runtime logs | 1 hour | Capture logs during deploys |
| Deployments | 100/day | Fine |

**Terms:** Hobby is personal / non-commercial use only. Vercel's Fair Use Guidelines treat any
deployment used for the financial gain of anyone involved in its production as commercial. Keep this
instance non-commercial, or move to Pro ($20/mo).

## 10. License

Comp is **AGPL-3.0**. If you modify it and offer it over a network, you must offer the corresponding
source of your modified version to those users (§13). This fork is public, which satisfies that for
the current state — keep it that way, and keep the `LICENSE` and copyright notices intact.
