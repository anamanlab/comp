# Cloudflare assessment — can Comp run on Cloudflare's free tier?

Date: 2026-10-19. Sources: Cloudflare docs (Containers, Workers limits, Workers pricing, Containers
pricing/limits/FAQ), Neon docs, Prisma 7 edge deployment docs, and **your live account** via the `cf` CLI.

---

## 0. Verdict (short)

| Question | Answer |
|---|---|
| Can Comp run on Cloudflare's **$0** tier, fully functional? | **No.** The blocker is Workers Free's **10 ms CPU per request** — a hard platform limit, not a tuning problem. |
| Can Comp run on Cloudflare for **~$5–7/mo**, fully functional? | **Yes, via Cloudflare Containers**, with near-zero code changes (reuse upstream's own Dockerfile). ← **recommended** |
| Is Neon a viable DB? | **Yes** — and it's the *only* DB that works without a rewrite. D1 is SQLite and cannot host Comp's 290 Postgres migrations. |
| Is there a commercial-use restriction (like Vercel Hobby)? | **No.** Cloudflare's Workers Paid plan is a normal paid plan with no non-commercial clause. |

**Bottom line:** true $0 on Cloudflare is not reachable for this app. The cheapest full-fidelity option
on Cloudflare is **Workers Paid ($5/mo flat)**, which is *half* Vercel Pro, has no ToS grey area, and
requires far less porting than either Vercel or the Workers/OpenNext route.

---

## 1. Your Cloudflare account right now (verified via `cf`)

| Item | State |
|---|---|
| Account | `89533fd25e868dce4cc47cb813054205` — personal ("Adesouza0021@gmail.com's Account"), type `standard` |
| Subscriptions | `Cloudflare Free Plan` (zones) · `R2 Paid` ($0 base, usage-billed) · `Teams Free Base` |
| **Workers plan** | **Workers Free — no `workers_paid` subscription present** |
| Workers deployed | 8: `optvoo-escola-production`, `optvoo-escola-preview`, `emcampo-production`, `field-service-saas-preview`, `everything-legal-production`, `everything-legal-preview`, `open-seo-selfhost`, `brazil`, `canada`, `optivoo-prospector` |
| Custom domains | `escola.optvoo.com`, `emcampo.optvoo.com`, `legal.optvoo.com`, `legal-preview.optvoo.com`, `seo.optvoo.com`, `brazil.optvoo.com`, `canada.optvoo.com` |
| R2 buckets | 17 (incl. `optvoo-escola-production-files`, `everything-legal-production-files`) |
| D1 databases | several (`optvoo-escola-production-db`, …) |
| Tooling | `cf` CLI installed + authenticated (`cf/config` + `defineConfig` convention). `wrangler` is **not** installed. `docker` available ✓ |

**Two things worth internalising from your own account:**
1. Your existing Workers apps are **Workers-native, not Next.js**: `optvoo-legal` has only two runtime
   deps (`better-auth`, `lucide`), entrypoint `./server/worker.js`, and uses **D1 + R2 + better-auth** —
   no Next.js, no Prisma, no Postgres. So you have *not* proven Next.js SSR on Workers Free.
2. You already have a Workers-native deployment muscle memory and an `optvoo.com` domain to attach to.

---

## 2. The Cloudflare beta surfaces, ranked for this app

| Surface | Status | Plan gate | Fit for Comp |
|---|---|---|---|
| **Containers** | Public beta | **Workers Paid ($5/mo)** | ✅ **Best fit.** Runs the existing `node:22-alpine` Next standalone image unmodified. Linux VM, full Node, TCP to Neon, real filesystem. |
| Workers + OpenNext | GA | Free *or* Paid | ⚠️ Free = 10 ms CPU → dies on SSR. Paid ($5/mo) = 30 s CPU → possible but needs a deep port. |
| Workflows | Beta | Free: 3,000 steps/day · Paid: 500,000/mo | ✅ Viable Trigger.dev replacement — but 67 tasks is a big port. Cheaper to keep Trigger.dev's free tier ($5/mo credits). |
| Queues | GA | Free tier | ✅ Same role as Workflows for event-driven jobs. |
| D1 | GA | Free | ❌ SQLite. 290 Postgres migrations, `pgcrypto`/extensions, enums, arrays → not portable. **Use Neon.** |
| R2 | GA | Free: 10 GB storage, 1M Class A / 10M Class B ops | ✅ Attachments. Comp already speaks S3 and has `APP_AWS_ENDPOINT` for S3-compatible endpoints. |
| Hyperdrive | GA | **Paid only** | Optional Postgres connection pooling — nice-to-have, not required (Neon pooler does it). |
| AI Gateway | GA | Free tier | ✅ Optional: proxy/observe OpenAI/Anthropic/Gemini calls, add key rotation. |
| Workers Static Assets | GA | Free: 20k files / 25 MiB each | ✅ If you ever split the app into static + dynamic. |
| Durable Objects | GA | Free: 100k req/day, 5 min alarms | ✅ Required plumbing for Containers (each Container is DO-managed). |

---

## 3. Why Workers Free ($0) cannot host this app

Workers Free limits (from `developers.cloudflare.com/workers/platform/limits/`):

| Limit | Free value | Why it breaks Comp |
|---|---|---|
| **CPU per HTTP request** | **10 ms** | Cloudflare's own docs: *"Heavier workloads that handle authentication, server-side rendering, or parse large payloads typically use 10–20 ms."* Comp is 93 auth-gated pages + 40 API routes; a dashboard page does better-auth + several Prisma queries. Expect **30–100 ms** → **Error 1102 (exceeded CPU time limit)** on nearly every navigation. |
| Memory / isolate | 128 MB | Next.js standalone server + Prisma + the app's dep graph (three, monaco, tiptap, pdf tooling) will crowd this. |
| Worker bundle | 64 MiB uncompressed | Comp's server bundle alone is far larger. Would need an aggressive dependency diet. |
| Requests | 100,000/day | Fine. |
| Subrequests | 50/request | Tight but workable. |
| Cron triggers | 5/account | Fine. |

Even if you fixed the CPU and memory limits, the porting cost is severe and *the port wouldn't be free
anyway* — you'd still pay for Workers Paid to get 30 s CPU. So: **Workers Free is a dead end for full
fidelity.**

---

## 4. Why Containers is the answer

### What it is
Cloudflare Containers (public beta) runs a real Linux container per instance, scheduled by Durable
Objects, reached through a Worker. You keep your own Dockerfile and your own Node runtime.

### Cost model (Workers Paid $5/mo flat)
Included with Workers Paid: 10M requests/mo, 30M CPU-ms/mo, **25 GiB-hours memory**, **375 vCPU-minutes**,
**200 GB-hours disk**, 1 TB egress (NA/EU).

| Scenario | Instance | Runtime/mo | Container overage | **Total/mo** |
|---|---|---|---|---|
| **A. Demo, scale-to-zero** | `basic` (1 GiB, ¼ vCPU) | ~25 h | $0 (inside allowance) | **$5.00** |
| **B. Light usage** | `basic` | 100 h | ~$1.70 | **~$6.70** |
| **C. Regular use** | `standard-1` (4 GiB, ½ vCPU) | 100 h | ~$6.50 | **~$11.50** |
| **D. Always-on** | `standard-1` | 720 h | ~$51 | **~$56** |

Rates: memory $0.0000025/GiB-s · CPU $0.000020/vCPU-s · disk $0.00000007/GB-s. Memory is billed on
**allocated** size, so `sleepAfter` is the single most important cost lever.

### Instance types
| Type | vCPU | Memory | Disk |
|---|---|---|---|
| `lite` | 1/16 | 256 MiB | 2 GB |
| `basic` | 1/4 | 1 GiB | 4 GB |
| `standard-1` | ½ | 4 GiB | 8 GB |
| `standard-2` | 1 | 6 GiB | 12 GB |
| `standard-3` | 2 | 8 GiB | 16 GB |
| `standard-4` | 4 | 12 GiB | 20 GB |

Custom types: 1–4 vCPU, ≤12 GiB memory, ≤20 GB disk, **min 3 GiB memory per vCPU**.
Account limits: 6 TiB concurrent memory, 1,500 vCPU, 30 TB disk, 50 GB total image storage.

### Operational facts that matter
- **Cold start: 1–3 s** (docs) — plus Next.js boot, so expect ~5–15 s on the first hit after sleep.
  `sleepAfter` defaults to 10 minutes on the `Container` class; tune to ~60 s for a demo.
- **Disk is ephemeral.** A sleeping container restarts on a fresh disk from the image. Persist nothing
  locally — the DB is Neon and files are R2. (Snapshots exist: 20 GB max, 30-day retention.)
- **`linux/amd64` required.**
- **`SIGTERM` on host stop** (15 min grace, then `SIGKILL`) — handle graceful shutdown.
- **You need a Worker + Durable Object shim.** You cannot deploy a container standalone; the Worker
  proxies requests to it.
- **No built-in autoscaling yet** for stateless routing (use `getRandom` over N instances); Cloudflare
  says it's coming.
- Container images are built and pushed with **Docker locally** at deploy time (or via Workers Builds in
  CI). You have Docker ✓.
- After the first deploy, wait several minutes while Cloudflare provisions container instances.

---

## 5. Requirement-by-requirement mapping

| Comp requirement | Cloudflare solution | Code change? |
|---|---|---|
| Next.js 16 standalone server (`node apps/app/server.js`) | Container running upstream's Dockerfile `app` stage | **None** |
| Prisma 7 + `@prisma/adapter-pg` (node-postgres) | Container → TCP → Neon **pooled** endpoint | **None** (TCP works from a container) |
| `prisma migrate deploy` (290 migrations) + seed | Run from your machine against Neon | **None** |
| S3 attachments / org logos | R2 via `APP_AWS_ENDPOINT` + `APP_AWS_REGION=auto` | **None** (already supported) |
| Trigger.dev background jobs (67 tasks) | Keep Trigger.dev Cloud free ($5/mo credits) — it calls your app over HTTPS | **None** |
| Transactional email | Resend free (3,000/mo) | **None** |
| AI features (policies, risks, vendors) | Provider API keys, optionally via AI Gateway | **None** |
| Payments / Stripe | `NEXT_PUBLIC_SELF_HOSTED=true` → orgs auto-approved, billing bypassed | **None** |
| `apps/portal` (trust portal) | 2nd container class in the same Worker, routed by path | Small |
| Rate limiting (Upstash) | Keep Upstash free tier, or Cloudflare WAF rules | **None** |
| Auth (better-auth) | Unchanged — runs inside the container | **None** |

**That is the whole point of choosing Containers over Workers:** the DB driver, the file storage, the
job runner and the auth layer all keep working exactly as upstream wrote them.

---

## 6. Execution plan

### Phase 1 — Enable the plan & provision (≈30 min, no code yet)
1. **Enable Workers Paid ($5/mo)** on account `89533fd25e868dce4cc47cb813054205`.
   This is what unlocks Containers (and also raises CPU to 30 s / 5 min, requests to 10M/mo).
   *If you'd rather not spend the $5 yet, stop here — the free path is a rewrite, not a port (see §7).*
2. **Create the Neon project** (Free): 1 GB storage, 100 CU-hrs/mo, 5 GB egress, auto scale-to-zero
   after 5 min idle (reactivates in a few hundred ms on the next query — no error, just latency).
   Create a `prod` branch and copy the **pooled** connection string.
3. **Create the R2 bucket(s)**: `comp-app-files`, `comp-app-questionnaires`, `comp-app-knowledge-base`
   (mirror the three `APP_AWS_*_BUCKET` vars the app expects).
4. **Create the Resend domain** + API key.
5. Keep `NEXT_PUBLIC_SELF_HOSTED=true` so Stripe is never needed.

### Phase 2 — Container image (≈1 hr, mostly waiting on Docker)
The upstream Dockerfile already produces exactly what you need. Build the `app` target:
```bash
cd /home/civo/comp
docker build --platform linux/amd64 -f Dockerfile \
  --build-arg NEXT_PUBLIC_BETTER_AUTH_URL=https://comp.example.com \
  --build-arg NEXT_PUBLIC_PORTAL_URL=https://portal.example.com \
  --build-arg NEXT_PUBLIC_SELF_HOSTED=true \
  --target app -t comp-app:latest .
```
Then push it to Cloudflare's managed registry:
```bash
cf containers build  --file Dockerfile --tag comp-app:latest      # or: cf containers push
cf containers images list
```
If the build is slow or you don't want Docker locally, use **Workers Builds** (GitHub-connected CI
builds the image for you).

### Phase 3 — Worker + Durable Object shim (≈2–3 hrs)
Create `cloudflare.config.ts` (your `cf/config` convention) or `wrangler.jsonc`:
```jsonc
{
  "name": "comp-app",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-19",
  "compatibility_flags": ["nodejs_compat"],
  "containers": [
    { "class_name": "CompApp", "image": "./Dockerfile", "max_instances": 1,
      "instance_type": "basic" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "COMP_APP", "class_name": "CompApp" }]
  },
  "exports": { "CompApp": { "type": "durable-object", "storage": "sqlite" } },
  "observability": { "enabled": true }
}
```
`src/worker.ts` — the `Container` class + proxy:
```ts
import { Container } from "@cloudflare/containers";

export class CompApp extends Container<{ COMP_APP: Fetcher }> {
  defaultPort = 8080;          // your Next server must listen here
  sleepAfter = "60s";          // the single biggest cost lever
  envVars = { PORT: "8080", NODE_ENV: "production" };
  // secrets: forward from Worker secrets in the constructor
}

export default {
  async fetch(request: Request, env: Env) {
    return env.COMP_APP.getByName("app").fetch(request);
  },
} satisfies Exporter<Env>;
```
> The `envVars` / secret forwarding details are the one place to read the Containers docs closely:
> `developers.cloudflare.com/containers/examples/env-vars-and-secrets/`.

The app's Docker image listens on **3000**; set `defaultPort = 3000` or change the image's `EXPOSE`/
`CMD` to 8080. Pick one and make them agree.

### Phase 4 — Data + secrets
```bash
# migrations + seed, from your machine, against Neon
cd /home/civo/comp/packages/db
bunx prisma migrate deploy --schema=prisma/schema
bun run db:seed

# background jobs
cd /home/civo/comp/apps/app && bunx trigger.dev@4.4.3 deploy
```
Set Worker secrets: `DATABASE_URL`, `AUTH_SECRET`, `RESEND_API_KEY`, `REVALIDATION_SECRET`,
`NEXT_PUBLIC_PORTAL_URL`, `APP_AWS_*` (R2), `TRIGGER_SECRET_KEY`, `TRIGGER_API_KEY`, `BETTER_AUTH_URL`,
`AUTH_TRUSTED_ORIGINS`, `OPENAI_API_KEY`/`GROQ_API_KEY`.

### Phase 5 — Deploy & verify
```bash
cf deploy
cf containers applications instances list
cf containers images list
```
**Gate:** `curl -fsS https://<worker>.workers.dev/api/health` → 200, then sign up → org auto-approved
(no Stripe screen), upload an attachment → lands in R2, trigger one Trigger.dev task → completes.

### Phase 6 — Custom domain
Attach a route under an existing zone (e.g. `comp.optvoo.com`) and set `AUTH_TRUSTED_ORIGINS` +
`NEXT_PUBLIC_BETTER_AUTH_URL` to match.

---

## 7. The $0 path, honestly assessed

If you insist on $0, the only route is **Workers Free + OpenNext + Neon HTTP driver**, and it fails on
two independent axes:

1. **The 10 ms CPU wall.** Even a perfect port of an auth-gated Next.js dashboard to Workers Free
   would blow the limit on most page loads. This is a platform constant you cannot tune away.
2. **The port itself.** It requires, at minimum:
   - Swap `@prisma/adapter-pg` → `@prisma/adapter-neon` (HTTP transport) in `packages/db/src/client.ts`
   - Cache the `PrismaClient` at module scope — Prisma's WASM query compiler leaks if you construct it
     per request (prisma/prisma#29660), which will OOM a 128 MB isolate
   - Strip `three`, `monaco-editor`, `stagehand`, `browserbase`, `puppeteer-core`, `playwright-core`,
     `pdf-parse`, `mammoth` and remove `serverExternalPackages: ['jspdf']`
   - Get under 64 MiB bundle and 128 MB memory
   - Replace 67 Trigger.dev tasks with Cloudflare Workflows/Queues (Free: 3,000 steps/day)
   - Handle `experimental.serverActions.bodySizeLimit: '150mb'` vs Workers' 100 MB request-body cap
   - Next.js 16 on Workers is supported by OpenNext ("all minor and patch versions of Next.js 16"), but
     there is a known Next 16 Proxy-architecture friction point (cloudflare/workers-sdk#13755)

Realistically that is **days of work with a real chance the SSR still times out.** It does not deliver
"fully use the app".

### Third option worth naming
**Keep the Docker image, drop the container.** Run it on a free/cheap host that speaks Docker:
Fly.io, Koyeb, or a VPS you already have (this machine has Docker + 47 GB free). Comp's `docker-compose.yml`
gives you `migrator` + `seeder` + `app` + `portal` out of the box, Neon replaces Postgres, R2 replaces
S3. **$0–$5/mo, zero porting, full fidelity.** If "free" is the hard constraint and "Cloudflare" is not,
this beats both Cloudflare and Vercel.

---

## 8. Recommendation

1. **If Cloudflare is required:** enable Workers Paid ($5/mo) and use **Containers**. Realistic total:
   **$5–7/mo** for a demo with `sleepAfter = "60s"`, scaling up only if you get real traffic. No ToS
   risk, no Next.js-on-edge rewrite, Neon + R2 + Trigger.dev free tiers cover everything else.
2. **If $0 is the hard constraint:** do **not** use Vercel Hobby (non-commercial clause + a monorepo
   port) and do **not** use Cloudflare Workers Free (10 ms CPU). Use the **Docker image on a free
   container host** with Neon + R2. Full app, $0, no rewrite.
3. **Never mind $0 entirely:** Vercel Pro ($20/mo) with the plan already in `VERCEL_DEPLOY_PLAN.md` is
   also viable and gives you the most conventional Next.js deployment.

---

## 9. Facts and figures cited

- Workers Free: 100,000 req/day · 10 ms CPU/request · 128 MB memory · 50 subrequests · 64 MiB bundle · 100 Workers · 5 cron triggers · 20,000 static files
- Workers Paid: $5/mo · 10M req/mo · 30M CPU-ms/mo · 30 s default / 5 min max CPU per invocation · 10,000 subrequests · 500 Workers · 250 cron triggers
- Containers: 25 GiB-hr + 375 vCPU-min + 200 GB-hr included; $0.0000025/GiB-s, $0.000020/vCPU-s, $0.00000007/GB-s; 1 TB egress NA/EU; 6 instance types; 1–3 s cold start; ephemeral disk; SIGTERM on stop; linux/amd64; 6 TiB/1,500 vCPU/30 TB account limits; 50 GB image storage
- Containers: **Workers Paid plan required**
- Neon Free: 1 GB storage/project (20 GB account) · 100 CU-hrs/project/mo · 5 GB egress/project · scale-to-zero after 5 min, auto-resume in a few hundred ms · pooled connections included
- Trigger.dev Free: $5/mo credits · 20 concurrent runs · unlimited tasks
- Resend Free: 3,000 emails/mo
- R2 Free: 10 GB storage · 1M Class A · 10M Class B ops/mo · zero egress
- OpenNext Cloudflare: supports all minor/patch versions of Next.js 16
- Prisma 7 on Cloudflare: `nodejs_compat` + driver adapters; Neon via `@prisma/adapter-neon`
