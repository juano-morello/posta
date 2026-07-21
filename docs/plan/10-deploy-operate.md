# E10 — Deploy & operate

**Milestone:** M3 · **Depends on:** E9, S0.7 · **Unblocks:** —

**Goal:** Posta live in São Paulo on `posta.lat`, running as container images on Kubernetes against managed datastores, with the alerts that would tell you the honest number stopped being honest.

**Done when:** a real link, shared into a real WhatsApp group, produces a real honest split on a real dashboard — and you would find out within minutes if it broke.

**Deployment target.** Every workload ships as a container image built in S0.7 and tagged by git SHA. Postgres, Redis and R2 are **managed services outside the cluster**, reached over env-supplied URLs. **The cloud provider is deliberately not chosen yet** — containers plus vanilla Kubernetes manifests are precisely what let that choice bind late. Nothing in this epic may name a provider outside `k8s/overlays/prod/`.

**Manifest layout.** Plain YAML plus Kustomize, no Helm — a templating dependency this project has not chosen and does not need for three workloads.

```
k8s/shared/     namespace · configmap · secret contract · ingress · networkpolicy · alert rules
k8s/api/        deployment · service · hpa · pdb · migrate-job
k8s/worker/     deployment · pdb · replay-job
k8s/web/        deployment · service · pdb
k8s/overlays/prod/   the only place a region id, an image registry or a hostname is written
```

---

## S10.1 — Domain, DNS & TLS

**As an** operator **I want** every host resolving and encrypted **so that** `<handle>.posta.lat` is a real address before anything is asked to serve it.

**Acceptance:**
- [ ] `posta.lat` registered; Cloudflare zone active, proxied
- [ ] Wildcard `*.posta.lat`, `app.posta.lat`, `api.posta.lat` → the cluster ingress
- [ ] Wildcard TLS covering `*.posta.lat`; SSL mode Full (strict), never Flexible
- [ ] HSTS with `includeSubDomains`, TLS 1.2 floor
- [ ] `POSTA_LINK_DOMAIN` defined **once** and consumed by all three workloads
- [ ] Zone config committed as a diffable export — it lives outside the repo, so it needs a record

**Tasks:**

#### T10.1.1 · `chore: register posta.lat and delegate the zone to Cloudflare`
Register `posta.lat`, create the Cloudflare zone, move the nameservers, confirm the zone reports active. Availability is assumed here; if the registrar disagrees this is the moment a fallback domain is chosen, and because every host derives from `POSTA_LINK_DOMAIN` (T0.3.3) that stays a config change rather than a code change.
→ **files** *(registrar + Cloudflare account, not the repo)* · **verify** `dig NS posta.lat +short` returns Cloudflare nameservers · **after** —

#### T10.1.2 · `chore: export the Cloudflare zone into the repo as a reviewable snapshot`
`scripts/cf-export.sh` pulls records, rulesets and zone settings via the Cloudflare API into `infra/cloudflare/zone.json`. This is not infrastructure-as-code — it is a snapshot that makes a console change show up in a diff, which is the cheapest available defence against config that no reviewer ever sees. The API token is read from env, never committed. [security]
→ **files** `infra/cloudflare/zone.json`, `scripts/cf-export.sh` · **verify** running the script twice against an unchanged zone produces a byte-identical file; `git diff` is empty · **after** T10.1.1

#### T10.1.3 · `chore: point the wildcard and named hosts at the cluster ingress` ⛔ blocked
`*.posta.lat`, `app.posta.lat` and `api.posta.lat` as proxied records aimed at the ingress address. **Blocked until a cloud account exists and the cluster ingress has an address** (T10.4.9) — there is nothing to point at until a provider is chosen.
→ **files** `infra/cloudflare/zone.json` · **verify** `dig +short app.posta.lat` returns Cloudflare proxy addresses and `curl -sI https://api.posta.lat/health/live` returns 200 · **after** T10.1.2, T10.4.9

#### T10.1.4 · `chore: issue wildcard TLS and set SSL mode to Full (strict)` [security]
Cloudflare's universal certificate covers one label only, so `*.posta.lat` needs a wildcard cert on the edge plus a Cloudflare Origin Certificate mounted on the ingress. SSL mode must be **Full (strict)** — under Flexible the edge-to-São-Paulo leg travels in plaintext, which is a real exposure and not a warning banner.
→ **files** `k8s/shared/ingress.yaml`, `infra/cloudflare/zone.json` · **verify** `openssl s_client -connect juano.posta.lat:443` presents a valid chain for a three-label host, and the zone export shows `ssl: "strict"` · **after** T10.1.3

#### T10.1.5 · `chore: enable HSTS and a TLS 1.2 floor` [security]
HSTS `max-age=31536000; includeSubDomains`, Always Use HTTPS, minimum TLS 1.2. `includeSubDomains` is the decision worth pausing on: it commits every future `<handle>.posta.lat` to HTTPS in every browser that has seen the header, and that is not retractable on a useful timescale. It is the right call here — there will never be a plaintext handle host.
→ **files** `infra/cloudflare/zone.json` · **verify** `curl -sI https://app.posta.lat | grep -i strict-transport-security` shows the max-age, and a forced TLS 1.1 handshake is refused · **after** T10.1.4

#### T10.1.6 · `test: assert one POSTA_LINK_DOMAIN value reaches all three workloads`
Renders the prod overlay and asserts `POSTA_LINK_DOMAIN` is declared exactly once — in `k8s/shared/configmap.yaml` — and reaches api, worker and web through `envFrom`, never re-declared per workload. Three copies that drift is how the dashboard starts minting links for a host the ingress does not serve.
→ **files** `tests/infra/domain-consistency.test.ts` · **verify** `pnpm test tests/infra/domain-consistency.test.ts` over the output of `kustomize build k8s/overlays/prod` · **after** T10.3.3

> The fallback-domain claim from E0 gets its one real test here. If `POSTA_LINK_DOMAIN` genuinely drives every host, switching domains is editing one ConfigMap key and one Ingress host in the overlay. If T10.1.6 has to be written with exceptions, the claim was never true.

---

## S10.2 — The Origin Rule

**As an** operator **I want** the path split configured and continuously proven **so that** the one-frontend-surface decision actually works in production.

**Acceptance:**
- [ ] Cloudflare Origin Rule on `*.posta.lat`: `path == "/"` → web origin; everything else → api origin [INV-11]
- [ ] The rule matches the root **only** — verified against `/`, `/slug`, `/slug/`, `/favicon.ico`, `/robots.txt`
- [ ] The rule still matches when a query string is present — `/?utm=x` is a bio link with tracking params and must not 404
- [ ] Redirect latency measured **with the rule live**; it must not add a hop to `/:slug` [INV-1][INV-2]
- [ ] The rule is captured in the committed zone export
- [ ] The assertion runs on a schedule after deploy, not as a checklist tick
- [ ] T8.6.5's routing proof runs against production

**Tasks:**

#### T10.2.1 · `feat: emit an x-posta-origin header from api and web`
`x-posta-origin: api` set by the redirect middleware in `apps/api/src/main.ts`, `x-posta-origin: web` set via `headers()` in `apps/web/next.config.ts`. Without it the routing assertion has to infer which origin answered from body shape, which will pass for the wrong reason the first time a 404 page is restyled.
→ **files** `apps/api/src/main.ts`, `apps/web/next.config.ts` · **verify** `curl -sI localhost:$API_PORT/x` and the web dev server each return their own `x-posta-origin` value · **after** —

#### T10.2.2 · `chore: create the Origin Rule splitting the bio root from the redirect path` [INV-11] ⛔ blocked
An Origin Rule scoped to `*.posta.lat` with expression `http.request.uri.path eq "/"`, overriding the origin to the web Service's ingress host; every other path falls through to the api origin. The expression matches on `uri.path`, which by definition excludes the query string — this is the field choice that keeps `/?utm=x` working. **Blocked until both origins are reachable** (T10.4.9).
→ **files** `infra/cloudflare/zone.json` · **verify** `curl -sI https://juano.posta.lat/` returns `x-posta-origin: web` and `curl -sI https://juano.posta.lat/promo` returns 307 with `x-posta-origin: api` · **after** T10.2.1, T10.4.9

#### T10.2.3 · `test: assert the origin rule matches the root and only the root`
Hits `/`, `/?utm=x`, `/?fbclid=y#frag`, `/promo`, `/promo/`, `/favicon.ico`, `/robots.txt` and `//` against the real domain and asserts the answering origin by `x-posta-origin`. `/?utm=x` is the sneaky one: a rule written against the full URI rather than the path 404s every bio link shared with tracking params, which is most of them.
→ **files** `tests/production/origin-rule.test.ts` · **verify** `pnpm test tests/production/origin-rule.test.ts` passes all eight cases against `POSTA_LINK_DOMAIN` · **after** T10.2.2

#### T10.2.4 · `ci: run the origin-rule assertion after every deploy and hourly`
A scheduled workflow plus a post-deploy step invoking T10.2.3 against production, failing loudly into the alert channel. The rule is configuration living outside the repo and outside CI's blast radius — the only thing that catches a silent Cloudflare change is something that keeps asking.
→ **files** `.github/workflows/production-smoke.yml` · **verify** the workflow runs green on schedule, and turning the rule off in a staging zone turns it red within the hour · **after** T10.2.3

#### T10.2.5 · `chore: capture the origin rule into the committed zone export`
Re-run `scripts/cf-export.sh` so the ruleset lands in `infra/cloudflare/zone.json`, and add a test asserting the export contains a rule whose expression is exactly `http.request.uri.path eq "/"`. A drift between the console and the export is the thing the export exists to reveal, so it needs an assertion, not a habit.
→ **files** `infra/cloudflare/zone.json`, `tests/infra/origin-rule-export.test.ts` · **verify** `pnpm test tests/infra/origin-rule-export.test.ts` fails when the expression is edited in the export · **after** T10.2.2

#### T10.2.6 · `test: run the E8 routing proof against production` [INV-11]
Points T8.6.5's path-split E2E at the live domain: `juano.posta.lat/` serves the bio from web, `juano.posta.lat/<slug>` 307s from api, and `/:slug` demonstrably never touched Next. Same test, real target — a second implementation would drift from the one E8 keeps green.
→ **files** `tests/production/routing-proof.test.ts` · **verify** `pnpm test tests/production/routing-proof.test.ts --domain posta.lat` passes and reports the answering origin for both paths · **after** T10.2.4, T8.6.5

#### T10.2.7 · `perf: measure redirect latency with the origin rule live` [INV-1][INV-2]
Compares p50/p95 of `/:slug` measured through the edge with the rule active against the same request sent straight at the api origin. The rule must not put a hop on the hot path; if the delta is not within noise the rule is over-matching or the origin override is being evaluated on every request rather than the root.
→ **files** `tests/production/redirect-latency.test.ts` · **verify** the measured p95 delta between edge-with-rule and direct-to-origin is under 2 ms, recorded in the test output · **after** T10.2.6

> `/?utm=x` is the sneaky one. A rule matching on "path is `/`" must still match when a query string is present, or shared bio links with tracking params 404. Test it explicitly, and test it forever — T10.2.4 is why this one is not a checklist tick.

---

## S10.3 — Cluster base: namespace, config, secrets

**As an** operator **I want** a rendered, validated manifest tree **so that** the whole deployment is reviewable in a diff before a provider is ever chosen.

**Acceptance:**
- [ ] `posta` namespace; every workload lands in it
- [ ] ConfigMap holding all non-secret configuration, keys matching the E0 env schemas
- [ ] Secret holding credentials, **never committed** — the repo holds only the contract [security]
- [ ] Kustomize base plus a `prod` overlay carrying region, hostnames, image tags and replica counts
- [ ] `kustomize build` renders and `kubeconform` validates in CI
- [ ] No literal domain and no provider name anywhere in `k8s/` outside the overlay
- [ ] Default-deny NetworkPolicy with explicit egress to the managed datastores [security]

**Tasks:**

#### T10.3.1 · `chore: add the posta namespace and kustomize base`
`k8s/shared/namespace.yaml` plus `k8s/kustomization.yaml` listing it, with `namespace: posta` set at the base so no child manifest repeats it. Nothing else yet — this commit exists so every later manifest has somewhere coherent to land.
→ **files** `k8s/shared/namespace.yaml`, `k8s/kustomization.yaml` · **verify** `kustomize build k8s` emits exactly one Namespace and exits 0 · **after** S0.7

#### T10.3.2 · `chore: add the ConfigMap for non-secret configuration`
`posta-config` carrying `POSTA_LINK_DOMAIN`, `POSTA_RESERVED_HANDLES`, `API_PORT`, `WORKER_CONCURRENCY`, `EVENT_BATCH_SIZE`, `EVENT_BATCH_INTERVAL_MS`, `SHUTDOWN_TIMEOUT_MS` and `LOG_LEVEL`. Key names are exactly the ones the E0 Zod schemas parse (T0.3.5–T0.3.7), so a typo fails the pod at boot with the key named rather than surfacing as a mystery default.
→ **files** `k8s/shared/configmap.yaml` · **verify** every key in the ConfigMap appears in one of the three env schemas — asserted by T10.3.6 · **after** T10.3.1

#### T10.3.3 · `chore: add the prod overlay carrying region, hosts and image tags`
`k8s/overlays/prod/kustomization.yaml` with the `images:` transformer (registry + tag), a ConfigMap patch supplying the real `POSTA_LINK_DOMAIN`, replica counts, and the region label. **This is the only directory permitted to contain a hostname, a registry or a provider-specific value** — that containment is what keeps the provider choice reversible.
→ **files** `k8s/overlays/prod/kustomization.yaml`, `k8s/overlays/prod/config-patch.yaml` · **verify** `kustomize build k8s/overlays/prod` renders with the real domain while `kustomize build k8s` renders with a placeholder · **after** T10.3.2

#### T10.3.4 · `chore: define the Secret contract without committing a secret` [security]
`k8s/shared/secret.example.yaml` documenting the required keys — `DATABASE_URL`, `DATABASE_URL_WORKER`, `REDIS_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `REVALIDATE_SECRET` — with every value as an obvious placeholder. No GeoIP key: DB-IP lite is CC BY 4.0 and baked into the image (T0.7.10), so there is no credential to leak here at all. The real `posta-secrets` is created out of band by the operator; `.gitignore` gains `k8s/**/secret.yaml`.
→ **files** `k8s/shared/secret.example.yaml`, `.gitignore` · **verify** `git check-ignore -v k8s/shared/secret.yaml` resolves to a rule; the example file contains no value longer than the word `REPLACE_ME` · **after** T10.3.3

#### T10.3.5 · `test: assert no secret material is committed under k8s/` [security]
Scans every tracked file under `k8s/` and `infra/` for a `kind: Secret` carrying non-placeholder `data`/`stringData`, plus high-entropy strings and anything matching a connection-string shape. A committed Secret is base64, not encryption — the distinction is exactly the one that gets forgotten at 1am on launch night.
→ **files** `tests/infra/no-committed-secrets.test.ts` · **verify** `pnpm test tests/infra/no-committed-secrets.test.ts` passes on the tree and fails when a real-looking `postgres://user:pass@host/db` is planted in a manifest · **after** T10.3.4

#### T10.3.6 · `test: forbid literal domains and provider names in the k8s base`
Extends the T0.3.9 grep to `k8s/`, failing on `posta.lat`, on any provider name, and on any region identifier — while explicitly allowing `k8s/overlays/`. Also asserts every ConfigMap key is parsed by one of the three env schemas, so dead config cannot accumulate unnoticed.
→ **files** `tests/infra/k8s-no-literals.test.ts` · **verify** `pnpm test tests/infra/k8s-no-literals.test.ts` passes, and fails when a hostname is planted in `k8s/shared/ingress.yaml` · **after** T10.3.5

#### T10.3.7 · `ci: render and validate the manifests on every push`
Adds a job running `kustomize build k8s/overlays/prod | kubeconform -strict -summary` against the pinned Kubernetes schema version. Manifests are the one part of this epic that can be fully checked without a cluster, so they should be — a typo'd `terminationGracePeriodSeconds` should never reach a rollout.
→ **files** `.github/workflows/ci.yml` · **verify** the job goes green, and turns red when a field name is misspelled in any manifest · **after** T10.3.6

#### T10.3.8 · `chore: default-deny NetworkPolicy with explicit egress to the datastores` [security]
Deny all ingress and egress in the `posta` namespace, then allow: ingress-controller → api/web, all pods → DNS, api/worker → the managed Postgres, Redis and R2 endpoints, api → the web Service for revalidation. The datastores are outside the cluster, so their egress rules are CIDR-based and live in the overlay alongside everything else provider-shaped.
→ **files** `k8s/shared/networkpolicy.yaml`, `k8s/overlays/prod/egress-patch.yaml` · **verify** a debug pod in the namespace cannot reach an arbitrary external host, while the api pod reaches Postgres and Redis · **after** T10.3.7

---

## S10.4 — Workload deployments

**As an** operator **I want** api, worker and web as three independent Deployments **so that** analytics load can never reach redirect latency.

**Acceptance:**
- [ ] Deployment + Service for api and web; Deployment only for worker
- [ ] The worker scales independently and is **not reachable from the ingress** — asserted, not assumed
- [ ] Ingress routes by host: `api.<domain>` and `*.<domain>` → api, `app.<domain>` → web
- [ ] Resource requests and limits on every container
- [ ] The api's memory request accounts for the two baked GeoIP mmdb files held in memory (S0.7)
- [ ] All three workloads pinned to São Paulo and spread across zones
- [ ] Non-root, read-only root filesystem, all capabilities dropped [security]
- [ ] Web's ISR cache is shared, so on-demand revalidation reaches every replica [INV-11]

**Tasks:**

#### T10.4.1 · `feat: api Deployment and Service`
Two replicas of the api image, `envFrom` the ConfigMap and Secret, container port from `API_PORT`, plus a ClusterIP Service. Probes, resources and lifecycle land in later commits so this one stays reviewable — it applies cleanly and serves, it is just not yet safe to roll.
→ **files** `k8s/api/deployment.yaml`, `k8s/api/service.yaml` · **verify** `kubectl apply -k k8s/overlays/prod` on a kind cluster brings both pods to `Running` and `kubectl port-forward svc/posta-api` answers the health route · **after** T10.3.8, S0.7

#### T10.4.2 · `feat: worker Deployment with no Service`
One replica of the worker image, same ConfigMap, but `DATABASE_URL_WORKER` from the Secret — the worker connects as the writer role while the api connects as a reader with no `SELECT` on raw `events` (T0.3.6, T4.2.4). **No Service object at all**: nothing should be able to route to the worker, and the cheapest way to guarantee that is for there to be no address.
→ **files** `k8s/worker/deployment.yaml` · **verify** the worker pod reaches `Running` and drains the queue; `kubectl get svc -l app=posta-worker` returns nothing · **after** T10.4.1

#### T10.4.3 · `feat: web Deployment and Service`
Two replicas of the Next.js image in standalone mode, ConfigMap only — web imports `contracts` and holds no datastore credential, so it gets no Secret beyond `REVALIDATE_SECRET`. Giving it the database URL "just in case" is how invariant boundaries erode.
→ **files** `k8s/web/deployment.yaml`, `k8s/web/service.yaml` · **verify** both pods reach `Running` and the dashboard renders through a port-forward · **after** T10.4.2

#### T10.4.4 · `feat: shared ISR cache so revalidation reaches every web replica` [INV-11]
A Next `cacheHandler` backed by the managed Redis, replacing the default filesystem cache. With more than one replica the default cache is per-pod, so the on-demand revalidation webhook from T8.6.2 invalidates exactly the one pod that received it and every other replica keeps serving the old bio indefinitely. Uses a `bio:` key prefix, distinct from `link:` and BullMQ's keyspace (spec §9), and **with a TTL** so `volatile-lru` can evict it under pressure [INV-7].
→ **files** `apps/web/cache-handler.js`, `apps/web/next.config.ts` · **verify** two local web instances sharing one Redis both serve the updated page after a single revalidation call · **after** T10.4.3, T8.6.1

#### T10.4.5 · `test: on-demand revalidation invalidates every web replica` [INV-11]
Scales web to three replicas, saves a bio, then polls each pod directly by IP asserting all three serve the new content within the revalidation window. A stale bio page is invisible to every alert in S10.10 — the page returns 200, quickly, with last week's links on it.
→ **files** `tests/production/isr-fanout.test.ts` · **verify** `pnpm test tests/production/isr-fanout.test.ts` asserts all replicas converge, and fails when the cache handler is reverted to the filesystem default · **after** T10.4.4

#### T10.4.6 · `chore: set resource requests and limits per workload`
api `250m`/`512Mi` request, worker `100m`/`256Mi`, web `100m`/`512Mi`, with memory limits at request × 1.5. **The api's memory floor is not arbitrary:** the two DB-IP mmdb files baked into the image (T0.7.10) are mmap'd and resident for the life of the process, and a limit set from an idle Node heap OOM-kills the first pod that actually answers a redirect. The worker needs no such headroom — it never holds the databases, because it never sees an IP [INV-6].
→ **files** `k8s/api/deployment.yaml`, `k8s/worker/deployment.yaml`, `k8s/web/deployment.yaml` · **verify** `kubectl top pod` under synthetic redirect load shows api RSS below the limit with the mmdb files loaded · **after** T10.4.5

#### T10.4.7 · `perf: remove the CPU limit from the api and record why`
The api keeps its CPU **request** and loses its CPU **limit**. A CFS quota throttles in 100 ms slices, so a pod at its limit stalls whole requests — on a path whose entire budget is 15 ms p95, throttling is indistinguishable from an outage and shows up only as tail latency. The request still guarantees the share; the limit only ever caps the headroom that absorbs a burst.
→ **files** `k8s/api/deployment.yaml`, `docs/runbooks/README.md` · **verify** `container_cpu_cfs_throttled_seconds_total` for the api stays at zero under a load test that previously throttled · **after** T10.4.6

#### T10.4.8 · `chore: pin all workloads to São Paulo and spread across zones`
`nodeAffinity` requiring `topology.kubernetes.io/region` to equal the region value supplied by the overlay, plus `topologySpreadConstraints` over `topology.kubernetes.io/zone` with `maxSkew: 1` for api and web. The region **identifier** is provider-specific and therefore lives only in `k8s/overlays/prod/`; the base expresses the constraint, not the value.
→ **files** `k8s/overlays/prod/region-patch.yaml` · **verify** `kubectl get pod -o wide` shows every pod in the São Paulo region and api replicas in different zones · **after** T10.4.7

#### T10.4.9 · `feat: ingress routing api and web by host`
One Ingress: `app.<domain>` → web Service, `api.<domain>` and the wildcard `*.<domain>` → api Service, TLS from the Cloudflare origin certificate Secret. The wildcard sends `<handle>.<domain>/anything` to the api; the `/` exception is made at Cloudflare (S10.2), **not here** — an in-cluster path rule would add a second place the split can be wrong.
→ **files** `k8s/shared/ingress.yaml`, `k8s/overlays/prod/ingress-patch.yaml` · **verify** `curl -H 'Host: juano.<domain>' http://<ingress-ip>/promo` returns 307 and the same with `Host: app.<domain>` reaches web · **after** T10.4.8

#### T10.4.10 · `chore: harden the pod security context on all three workloads` [security]
`runAsNonRoot: true` with the image's non-root UID (S0.7), `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`. Next needs a writable `/tmp` and `.next/cache`, supplied as `emptyDir` mounts rather than by giving up the read-only root.
→ **files** `k8s/api/deployment.yaml`, `k8s/worker/deployment.yaml`, `k8s/web/deployment.yaml` · **verify** `kubectl exec` into each pod and `touch /x` fails; all three stay `Running` · **after** T10.4.9

#### T10.4.11 · `test: assert the worker is unreachable from the ingress`
Renders the prod overlay and asserts no Service, no Ingress rule and no NetworkPolicy ingress selector resolves to the worker's pod labels. The worker holds the writer database role — reachability is a privilege-escalation surface, not only an architecture concern. [security]
→ **files** `tests/infra/worker-unreachable.test.ts` · **verify** `pnpm test tests/infra/worker-unreachable.test.ts` passes, and fails when a Service selecting the worker labels is added · **after** T10.4.10

> The worker being a separate Deployment is what makes invariant 1 structural at the infrastructure layer rather than only in code. A 10k-event backlog can pin the worker's CPU for minutes and the redirect path does not notice, because it is a different pod on a different node with its own request. Scaling them together would quietly undo that.

---

## S10.5 — Health, probes & graceful drain

**As an** operator **I want** readiness and liveness to answer different questions **so that** a datastore blip degrades service instead of causing a restart storm.

**Acceptance:**
- [ ] `/health/live` — process-only, no datastore call, on api and worker
- [ ] `/health/ready` — checks Postgres and Redis reachability, on api
- [ ] Readiness gates traffic; liveness restarts; a datastore outage must fail **only** readiness
- [ ] `terminationGracePeriodSeconds` exceeds the worker's `SHUTDOWN_TIMEOUT_MS` — asserted by a test
- [ ] `preStop` delay on api and web so endpoint deregistration precedes SIGTERM
- [ ] The worker's existing staleness `/health` (T3.1.7) is **not** wired to liveness

**Tasks:**

#### T10.5.1 · `feat: split the api health endpoint into liveness and readiness`
`GET /health/live` returns 200 whenever the event loop is turning — no I/O, no dependency. `GET /health/ready` pings Redis and issues `SELECT 1` against Postgres with a 500 ms budget each, returning 503 with the failing dependency named. Two endpoints because they answer two questions: *can I serve?* and *am I wedged?*
→ **files** `apps/api/src/health.controller.ts`, `apps/api/src/health.controller.test.ts` · **verify** `pnpm test health.controller.test.ts` asserts `/health/live` stays 200 with both datastores mocked as down while `/health/ready` returns 503 naming each · **after** T10.4.11

#### T10.5.2 · `feat: add a process-only liveness endpoint to the worker`
`GET /health/live` on the worker, deliberately separate from the existing `GET /health` from T3.1.7. That endpoint returns 503 once `last_flush_age_ms` passes three flush intervals — correct as a staleness signal, catastrophic as a liveness probe, because an **idle** worker never opens a batch, never flushes, and would be restarted on a loop all night for the crime of having no traffic.
→ **files** `apps/worker/src/health.controller.ts`, `apps/worker/src/health.controller.test.ts` · **verify** `pnpm test health.controller.test.ts` asserts `/health/live` returns 200 after fake timers advance well past the staleness threshold with an empty queue, while `/health` returns 503 · **after** T10.5.1

#### T10.5.3 · `chore: wire liveness and readiness probes on all three deployments`
api: readiness → `/health/ready` (period 5 s, failureThreshold 3), liveness → `/health/live` (period 10 s, failureThreshold 6). worker: liveness → `/health/live` only, no readiness — it takes no traffic, so readiness would gate nothing. web: readiness and liveness both on a static route. `initialDelaySeconds` sized above cold start so a slow boot is not read as a crash.
→ **files** `k8s/api/deployment.yaml`, `k8s/worker/deployment.yaml`, `k8s/web/deployment.yaml` · **verify** `kubectl describe pod` lists both probes with the intended paths; pods reach `Ready` without a restart · **after** T10.5.2

#### T10.5.4 · `test: a datastore blip fails readiness and never liveness`
Against a kind cluster with the api running, pauses the Redis container for 30 s and asserts the pod goes `NotReady` (leaving the Service endpoint list), receives no traffic, and returns to `Ready` on recovery — with `restartCount` unchanged at zero throughout. Conflating the two probes turns a transient Redis hiccup into a rolling restart of every api pod, which is strictly worse than the hiccup.
→ **files** `tests/infra/probe-semantics.test.ts` · **verify** `pnpm test tests/infra/probe-semantics.test.ts` asserts readiness flapped, restart count stayed 0, and no request was routed to the unready pod · **after** T10.5.3

#### T10.5.5 · `chore: set terminationGracePeriodSeconds above the worker flush timeout`
Worker: `terminationGracePeriodSeconds: 60` against `SHUTDOWN_TIMEOUT_MS: 30000` from the ConfigMap. On SIGTERM the worker pauses the BullMQ consumer, awaits in-flight handlers and flushes the in-memory batch (T3.1.6); if Kubernetes SIGKILLs before that completes, every rolling deploy silently eats up to a full batch of buffered events and **nothing reports it** — the pod exits, the rollout goes green, the events are simply gone. api and web get 30 s.
→ **files** `k8s/worker/deployment.yaml`, `k8s/api/deployment.yaml`, `k8s/web/deployment.yaml` · **verify** `kubectl delete pod` on the worker mid-batch shows the flush log line before termination, and Postgres holds the buffered rows · **after** T10.5.4, T3.1.6

#### T10.5.6 · `test: assert the grace period exceeds the shutdown timeout with margin`
Reads the rendered prod overlay and asserts `terminationGracePeriodSeconds` for the worker is at least `SHUTDOWN_TIMEOUT_MS / 1000` plus a 20 s margin for in-flight handlers and the final insert. Both values are editable by different people for different reasons, and the failure mode of them crossing is invisible.
→ **files** `tests/infra/grace-period.test.ts` · **verify** `pnpm test tests/infra/grace-period.test.ts` passes, and fails when `SHUTDOWN_TIMEOUT_MS` is raised to 60000 without touching the manifest · **after** T10.5.5

#### T10.5.7 · `chore: add a preStop delay so endpoint removal precedes SIGTERM`
A `preStop` exec sleeping 5 s on api and web. Kubernetes sends SIGTERM and updates the Service endpoint list **concurrently**, so without the delay the ingress keeps sending requests to a pod that has already stopped accepting them — visible as a burst of 502s on every rollout, on the redirect path, for no reason at all.
→ **files** `k8s/api/deployment.yaml`, `k8s/web/deployment.yaml` · **verify** a rolling restart under sustained redirect load produces zero non-307 responses · **after** T10.5.6

> Readiness gates traffic; liveness restarts. Getting them backwards is how a five-second Redis blip becomes a fifteen-minute outage: every pod fails its liveness probe at once, every pod restarts, every pod cold-starts into the same still-blipping Redis, and the restart backoff outlives the original fault by an order of magnitude.

---

## S10.6 — Rollout, migrations & disruption

**As an** operator **I want** schema changes to land exactly once, before the new version serves **so that** a deploy is never half-migrated and a rollback is never blocked.

**Acceptance:**
- [ ] Migrations run as a **Job that runs to completion**, before the new image serves traffic
- [ ] Exactly once per deploy — not an initContainer, which races across replicas
- [ ] The Job is idempotent (T1.5.1 already is) and re-runnable
- [ ] Migrations are expand-contract, so a rollback needs no down migration
- [ ] `RollingUpdate` surge/unavailability tuned per workload
- [ ] PodDisruptionBudget so a node drain cannot take every redirect pod at once
- [ ] HorizontalPodAutoscaler on the api
- [ ] `kubectl rollout undo` rehearsed once against the real deployment

**Tasks:**

#### T10.6.1 · `feat: migration Job keyed on the image tag`
`k8s/api/migrate-job.yaml` runs `pnpm migrate` (T1.5.1) from the api image with `backoffLimit: 2` and `restartPolicy: Never`. The Job name carries the git SHA (`posta-migrate-<sha>`) because a completed Job is immutable and re-applying the same name fails — and because a per-SHA name makes "did this version's migration run?" a `kubectl get job` away.
→ **files** `k8s/api/migrate-job.yaml`, `k8s/overlays/prod/kustomization.yaml` · **verify** applying the Job against a fresh database produces every table, function and partition; applying the next SHA's Job applies nothing and completes · **after** T10.5.7, T1.5.1

#### T10.6.2 · `feat: deploy script gating the rollout on Job completion`
`scripts/deploy.sh <sha>`: apply the migration Job, `kubectl wait --for=condition=complete --timeout=10m`, and only then `kustomize edit set image` and roll the three Deployments. **Not an initContainer** — an initContainer runs once per replica, so three api pods race three concurrent migrations against one database, and the advisory-lock behaviour that saves you is the migrator's, not Kubernetes'. On Job failure the script exits non-zero and the old version keeps serving, untouched.
→ **files** `scripts/deploy.sh` · **verify** a deliberately failing migration leaves the previous Deployment's pods `Running` on the old image and the script exits non-zero · **after** T10.6.1

#### T10.6.3 · `docs: expand-contract migration policy so rollback needs no down migration`
The rule and its consequence: additive-only in the deploy that introduces a column, destructive changes only one deploy later once no running version reads the old shape. `kubectl rollout undo` reverts pods in seconds and cannot revert a migration — so the previous image must be able to run against the new schema, or the rollback path is a lie you discover under pressure. Covers the partitioned `events` table specifically, where a rewrite is not an option at all.
→ **files** `docs/runbooks/migrations.md` · **verify** the doc names the two-deploy sequence for a column rename and a reader can follow it without reading E1 · **after** T10.6.2

#### T10.6.4 · `chore: set the RollingUpdate strategy per workload`
api and web: `maxSurge: 1, maxUnavailable: 0` — never fewer serving pods than before the rollout, on a path with a latency claim. worker: `maxUnavailable: 1, maxSurge: 0` with `Recreate`-like behaviour, because two workers overlapping during a rollout both hold in-memory batches and the second one's flush is pure duplicated work that `ON CONFLICT` absorbs but the queue does not need [INV-8].
→ **files** `k8s/api/deployment.yaml`, `k8s/web/deployment.yaml`, `k8s/worker/deployment.yaml` · **verify** a rollout of api under load never drops the ready-replica count below 2 in `kubectl get deploy -w` · **after** T10.6.3

#### T10.6.5 · `chore: add PodDisruptionBudgets for api and web`
api `minAvailable: 1` at two replicas, web the same. Without it a node drain — routine on any managed cluster during an upgrade — can evict every redirect pod simultaneously, and the redirect path is down for the length of a cold start with no deploy and no incident to point at. **The worker deliberately gets no PDB:** at one replica a `minAvailable: 1` budget blocks node drains indefinitely, and the worker is exactly the workload that can afford a gap.
→ **files** `k8s/api/pdb.yaml`, `k8s/web/pdb.yaml` · **verify** `kubectl drain` on the node holding both api pods evicts one and blocks on the second until a replacement is `Ready` · **after** T10.6.4

#### T10.6.6 · `feat: HorizontalPodAutoscaler on the api`
`minReplicas: 2`, `maxReplicas: 10`, target 60% CPU utilisation against the request from T10.4.6, with a `scaleDown` stabilisation window of 300 s so a traffic spike does not immediately un-scale into the next one. Only the api autoscales — the worker's throughput is bounded by batch flushes and Postgres, not by replica count, and web is served from cache for the traffic that matters.
→ **files** `k8s/api/hpa.yaml` · **verify** synthetic load driving api CPU past the target scales to 4 replicas within two minutes and back down after the stabilisation window · **after** T10.6.5

#### T10.6.7 · `test: a rolling deploy under load drops no redirect and loses no event`
Sustains 200 redirects/sec through the ingress, rolls all three Deployments to a new image tag, and asserts every request returned 307, that the event count in Postgres equals the request count, and that zero entries reached the DLQ. This is the test that makes T10.5.5 and T10.5.7 mean something — each is individually plausible and collectively unverified until something rolls under load.
→ **files** `tests/production/rollout-under-load.test.ts` · **verify** `pnpm test tests/production/rollout-under-load.test.ts` asserts 100% 307s and exact event parity across the rollout · **after** T10.6.6

#### T10.6.8 · `chore: rehearse kubectl rollout undo against the real deployment`
Deploy a deliberately broken api image, watch the readiness probe refuse to promote it, run `kubectl rollout undo deployment/posta-api`, and time the recovery. Records the measured numbers in the rollback runbook. A rollback procedure nobody has run is a paragraph, not a capability.
→ **files** `docs/runbooks/rollback.md` · **verify** the runbook contains a real measured recovery time and the exact commands used, reproducible by a second person · **after** T10.6.7

> An initContainer is the tempting answer and the wrong one. It runs once per replica, so scaling to three api pods runs three migrations concurrently against one database, and it runs on **every** pod restart forever — including at 3am when a node evicts a pod and a migration you thought was history runs again against production.

---

## S10.7 — Managed datastores

**As an** operator **I want** Postgres, Redis and R2 provisioned outside the cluster **so that** a cluster rebuild is never a data event.

**Acceptance:**
- [ ] Managed Postgres in São Paulo, automated backups, PITR
- [ ] Managed Redis in São Paulo with `maxmemory-policy volatile-lru` **verified on the real instance** [INV-7]
- [ ] R2 buckets with a lifecycle policy; **never public-writable** [security]
- [ ] Separate database roles for api (reader) and worker (writer), matching T0.3.6's two URLs [security]
- [ ] Connection pool sizing that survives the HPA scaling the api to `maxReplicas`
- [ ] All three reached by env-supplied URLs from the Secret — no in-cluster datastore, ever

**Tasks:**

#### T10.7.1 · `chore: provision managed Postgres in São Paulo with backups and PITR` ⛔ blocked
Managed Postgres 16 in the São Paulo region, automated daily backups, point-in-time recovery enabled, TLS required on connections, private networking to the cluster where the provider offers it. **Blocked until a cloud provider and account are chosen** — this is the first task that binds the provider decision.
→ **files** `docs/runbooks/datastores.md` *(connection details go to the Secret, never the repo)* · **verify** a `psql` from a debug pod connects over TLS, and a PITR restore to a timestamp five minutes ago succeeds into a scratch instance · **after** T10.3.8

#### T10.7.2 · `chore: provision managed Redis in São Paulo` ⛔ blocked
Managed Redis 7 in the same region as Postgres and the cluster, TLS, with a `maxmemory` sized for the hot link cache plus the BullMQ keyspace plus the ISR cache from T10.4.4. **Blocked on the same provider decision as T10.7.1.**
→ **files** `docs/runbooks/datastores.md` · **verify** `redis-cli --tls PING` from a debug pod returns `PONG` and `INFO memory` reports the configured `maxmemory` · **after** T10.7.1

#### T10.7.3 · `chore: set maxmemory-policy to volatile-lru on the managed instance` [INV-7] ⛔ blocked
Set the eviction policy on the real instance, not in a compose file. Providers commonly default to `allkeys-lru`, under which memory pressure evicts BullMQ's keys — which carry no TTL — and a queue backlog silently eats its own jobs while every dashboard stays green. Under `volatile-lru` only TTL'd keys are evictable, so pressure degrades the cache, which self-heals from Postgres. **Blocked on T10.7.2**; if the provider does not expose this parameter at all, that provider is disqualified and this task records why.
→ **files** `docs/runbooks/datastores.md` · **verify** `redis-cli CONFIG GET maxmemory-policy` against the production instance returns `volatile-lru` · **after** T10.7.2

#### T10.7.4 · `feat: assert the Redis eviction policy at api and worker startup` [INV-7]
Both processes read `CONFIG GET maxmemory-policy` on boot and refuse to start if it is not `volatile-lru`, naming the actual value. A console setting can be changed by a provider migration, a failover or a support ticket; a startup assertion is the only version of this check that survives all three. Where the provider blocks `CONFIG GET`, it logs at `error` and sets a gauge instead of exiting — a missing check must be visible, not silent.
→ **files** `packages/core/src/redis/assert-policy.ts`, `packages/core/src/redis/assert-policy.test.ts` · **verify** `pnpm test assert-policy.test.ts` boots against a Redis configured `allkeys-lru` and asserts a non-zero exit naming the policy · **after** T10.7.3, T0.4.8

#### T10.7.5 · `chore: create the production R2 buckets with lifecycle and private access` [security]
`posta-events` and `posta-avatars` with public access disabled on both, a lifecycle rule transitioning event objects to infrequent access after 90 days, and a scoped API token holding write-only access to `posta-events`. The event log is the source of truth for every number the product claims [INV-7] — a public-writable bucket makes the honest number forgeable by anyone who finds the endpoint.
→ **files** `docs/runbooks/datastores.md` · **verify** an unauthenticated `PUT` to `posta-events` returns 403 and an unauthenticated `GET` of a known key returns 403 · **after** T10.7.4

#### T10.7.6 · `test: assert the R2 event bucket is neither publicly readable nor writable` [security]
A production smoke test attempting an anonymous `GET`, `PUT` and `LIST` against the events bucket and asserting all three are refused. Bucket ACLs are the kind of setting that gets loosened during a debugging session at midnight and never tightened, so this runs on the same schedule as the routing assertion.
→ **files** `tests/production/r2-access.test.ts`, `.github/workflows/production-smoke.yml` · **verify** `pnpm test tests/production/r2-access.test.ts` asserts 403 on all three verbs · **after** T10.7.5

#### T10.7.7 · `chore: create least-privilege database roles for api and worker` [security]
`posta_writer` (the worker: `INSERT` on `events`, full access to the CRUD tables) and `posta_reader` (the api: `SELECT` on `events_classified` and the CRUD tables, **no `SELECT` on raw `events`**), wired to `DATABASE_URL_WORKER` and `DATABASE_URL` in the Secret. This is where T4.2.4's "nothing queries raw `events`" stops being a lint rule and becomes a permission [INV-5].
→ **files** `packages/core/migrations/sql/0NN_roles.sql`, `k8s/shared/secret.example.yaml` · **verify** connecting as `posta_reader` and running `SELECT * FROM events LIMIT 1` raises `42501`, while the same query against `events_classified` succeeds · **after** T10.7.6, T4.2.4

#### T10.7.8 · `chore: size connection pools against the managed Postgres connection cap`
Sets `max` on the api's `pg` Pool to a value where `max × HPA maxReplicas + worker pool + migration Job` stays under the managed instance's connection limit, and adds a startup log line stating the arithmetic. Managed Postgres tiers cap connections aggressively; an HPA that scales the api from 2 to 10 pods multiplies the pool tenfold and exhausts the cap at exactly the moment traffic is highest — the autoscaler's success becomes the outage.
→ **files** `packages/core/src/db/pool.ts`, `k8s/shared/configmap.yaml` · **verify** a load test driving the HPA to `maxReplicas` shows `pg_stat_activity` count below the instance limit with headroom for the migration Job · **after** T10.7.7, T10.6.6

> Everything stateful is outside the cluster on purpose. The cluster becomes disposable — rebuildable from `k8s/` plus a Secret — and the two things that are genuinely irreplaceable, the R2 log and the Postgres projection it rebuilds, are never one `kubectl delete namespace` away from gone.

---

## S10.8 — Region & latency proof

**As an** operator **I want** the latency claim measured rather than asserted **so that** "fast redirects from LATAM" survives someone checking.

**Acceptance:**
- [ ] Cluster, Postgres and Redis confirmed co-located — by **measured round-trip**, not a console label
- [ ] Ingress overhead on the redirect path measured, not assumed
- [ ] Redirect p50/p95/p99 measured from real LATAM clients (AR, BR, MX minimum)
- [ ] p95 under the spec §4.1 budget **with ingress and the Origin Rule in place**, or the budget is revised in writing with the reason
- [ ] Cache hit rate measured
- [ ] Results recorded in `docs/M3-acceptance.md` — build-in-public material

**Tasks:**

#### T10.8.1 · `test: measure pod-to-datastore round-trip and fail on a cross-region hop`
A Job running from inside the cluster that times 1000 Redis `GET`s and 1000 Postgres `SELECT 1`s, reporting p50/p99 and failing above 3 ms p99. A console region label can be right while the traffic still egresses through a regional gateway; 40 ms p99 on a "co-located" Redis is what a cross-region hop looks like, and the label will keep saying São Paulo.
→ **files** `k8s/api/colocation-job.yaml`, `tests/production/colocation.test.ts` · **verify** the Job reports sub-3 ms p99 to both datastores and exits non-zero above it · **after** T10.7.8

#### T10.8.2 · `perf: measure ingress overhead on the redirect path`
Compares p50/p95/p99 of `/:slug` measured through the ingress controller against the same request sent directly to the api pod IP. An ingress proxy hop costs roughly 1–3 ms — the 15 ms budget absorbs it comfortably, but "absorbs it" is a measurement, and the number belongs in the acceptance doc rather than in a sentence like this one.
→ **files** `tests/production/ingress-overhead.test.ts` · **verify** the test reports both distributions and asserts the p95 delta is under 3 ms · **after** T10.8.1

#### T10.8.3 · `test: synthetic redirect probes from AR, BR and MX`
Scheduled probes issuing a real redirect from Buenos Aires, São Paulo and Mexico City, recording TTFB per region. Buenos Aires is the honest test: it is the primary audience and it is not the region the cluster is in, so it measures the edge-plus-origin path rather than the flattering local one.
→ **files** `tests/production/latency-probes.test.ts`, `.github/workflows/production-smoke.yml` · **verify** the workflow records per-region TTFB on every run and retains the series · **after** T10.8.2

#### T10.8.4 · `test: assert redirect p95 against the spec §4.1 budget`
Asserts p95 TTFB from LATAM stays under 15 ms on a cache hit and under 40 ms on a Postgres fallback, measured end-to-end through Cloudflare, the Origin Rule, the ingress and the api. Failing the assertion is a decision point, not a nuisance: either the path gets faster or the budget is revised in writing with the reason recorded.
→ **files** `tests/production/latency-budget.test.ts` · **verify** `pnpm test tests/production/latency-budget.test.ts` asserts both thresholds against the T10.8.3 series · **after** T10.8.3

#### T10.8.5 · `feat: cache hit-rate metric on the redirect path`
A `posta_link_cache_hits_total` / `posta_link_cache_misses_total` counter pair incremented in the redirect middleware. The 15 ms budget assumes a cache hit; without the hit rate, a p95 that quietly drifts because the cache is being evicted is indistinguishable from one that drifts because the network got slower — and the two have opposite fixes.
→ **files** `apps/api/src/redirect/cache-metrics.ts`, `apps/api/src/redirect/cache-metrics.test.ts` · **verify** `pnpm test cache-metrics.test.ts` asserts a miss-then-hit sequence increments each counter exactly once · **after** T10.8.4

#### T10.8.6 · `docs: record the measured latency and co-location results`
`docs/M3-acceptance.md` gains the real numbers: per-region p50/p95/p99, datastore round-trip, ingress overhead, cache hit rate, and the exact commands used. Published as build-in-public material, including the numbers that are worse than hoped — a latency claim with a method attached is worth more than a better number without one.
→ **files** `docs/M3-acceptance.md` · **verify** a reader can reproduce every figure from the commands in the document · **after** T10.8.5

---

## S10.9 — Observability

**As an** operator **I want** the honesty of the number instrumented **so that** it degrading is visible before a user notices.

**Acceptance:**
- [ ] Prometheus-format `/metrics` on api and worker, scraped by whatever the cluster runs
- [ ] Redirect latency p50/p95/p99 + error rate
- [ ] **Enqueue failure rate** — the invariant-1 escape valve; silent growth means events are dropped by design and nobody knows [INV-1]
- [ ] Queue depth, worker lag, batch-flush success, DLQ depth
- [ ] R2 vs Postgres write divergence [INV-7]
- [ ] **Classification distribution over time** [INV-5]
- [ ] Structured JSON logs to stdout only, **no IP and no secrets**, verified [INV-6][security]
- [ ] Uptime checks on redirect, bio and dashboard

**Tasks:**

#### T10.9.1 · `feat: OpenMetrics endpoint on api and worker`
`GET /metrics` via `prom-client` with default Node process metrics, on the api's existing port and the worker's health port. Plain OpenMetrics rather than a vendor SDK, so the collector — Prometheus, an OTel agent, a managed scraper — binds as late as the cloud provider does.
→ **files** `packages/core/src/metrics/registry.ts`, `apps/api/src/metrics.controller.ts`, `apps/worker/src/metrics.controller.ts` · **verify** `curl localhost:$API_PORT/metrics` returns a parseable OpenMetrics body with `process_cpu_seconds_total` present · **after** T10.8.6

#### T10.9.2 · `feat: redirect latency histogram and error counter`
`posta_redirect_duration_seconds` as a histogram with buckets tuned to the §4.1 budget (2, 5, 10, 15, 25, 50, 100 ms — a default bucket set puts everything interesting in one bucket), plus `posta_redirect_total{status}`. Recorded in the middleware after the response is flushed, so instrumentation never sits between the request and the 307 [INV-1][INV-2].
→ **files** `apps/api/src/redirect/metrics.ts`, `apps/api/src/redirect/metrics.test.ts` · **verify** `pnpm test redirect/metrics.test.ts` asserts a 307 increments `status="307"`, a 404 increments `status="404"`, and the histogram observes into a sub-15 ms bucket · **after** T10.9.1

#### T10.9.3 · `feat: enqueue failure counter` [INV-1]
`posta_enqueue_failures_total` incremented in the `catch` of the fire-and-forget `queue.add` (spec §4 step 6). Invariant 1 says the redirect succeeds even when the enqueue fails — this counter is what stops that from being a silent data-loss channel. Without it, "we drop events by design under Redis pressure" and "we are dropping events right now" look identical.
→ **files** `apps/api/src/redirect/enqueue.ts`, `apps/api/src/redirect/enqueue-metrics.test.ts` · **verify** `pnpm test enqueue-metrics.test.ts` asserts the counter increments and the response is still 307 when the queue client throws · **after** T10.9.2

#### T10.9.4 · `feat: queue depth, DLQ depth and flush-age gauges`
`posta_queue_depth`, `posta_dlq_depth`, `posta_last_flush_age_seconds` and `posta_batch_size`, sourced from the same values the worker health endpoint already computes (T3.1.7) so the metric and the probe can never disagree. Flush age is the one that distinguishes a wedged worker from an idle one — queue depth alone reads healthy in both cases.
→ **files** `apps/worker/src/metrics/queue-gauges.ts`, `apps/worker/src/metrics/queue-gauges.test.ts` · **verify** `pnpm test queue-gauges.test.ts` asserts each gauge tracks the health endpoint's value across a planted DLQ entry and an advanced clock · **after** T10.9.3

#### T10.9.5 · `feat: R2 versus Postgres divergence gauge` [INV-7]
A periodic job comparing the `event_id` set in the last complete hour's R2 objects against Postgres **in both directions**, exporting `posta_store_divergence_rows{direction}`. T3.4.7 proves the two stores agree under test; this is the same assertion running forever against production, because the coupling in T3.4.6 is exactly the kind of thing a future refactor loosens by accident.
→ **files** `apps/worker/src/reconcile/divergence.job.ts`, `apps/worker/src/reconcile/divergence.job.test.ts` · **verify** `pnpm test divergence.job.test.ts` plants one Postgres-only row and one R2-only record and asserts the gauge reads 1 in each direction · **after** T10.9.4, T3.4.7

#### T10.9.6 · `feat: classification distribution gauge` [INV-5]
`posta_classification_ratio{classification}` over a rolling window, queried from `events_classified` — never from raw `events`, which the api's role cannot read anyway after T10.7.7. This is the series the most important alert in S10.10 is built on, so it is a first-class metric rather than a dashboard query.
→ **files** `apps/worker/src/metrics/classification-gauge.ts`, `apps/worker/src/metrics/classification-gauge.test.ts` · **verify** `pnpm test classification-gauge.test.ts` seeds a known mix and asserts the ratios sum to 1 with each label's value matching the seed · **after** T10.9.5, T4.1.1

#### T10.9.7 · `chore: structured JSON logs to stdout only` [INV-6][security]
One JSON line per event to stdout, no file sinks and no log-shipping sidecar — the container runtime collects stdout, and a second path is a second place a secret can land. Fields: level, timestamp, message, `request_id`, `tenant_id`. Never: `ip`, `user_agent` in full, or any Secret value.
→ **files** `packages/core/src/logging/logger.ts`, `apps/api/src/main.ts`, `apps/worker/src/main.ts` · **verify** `kubectl logs` shows parseable JSON, and no file descriptor other than stdout/stderr is opened for logging · **after** T10.9.6

#### T10.9.8 · `test: assert no IP and no secret reaches a production log line` [INV-6][security]
Drives 200 real redirects against the deployed api, captures the pod's full log output, and asserts no line contains an IPv4 or IPv6 literal, no Secret value, and no full `user_agent`. T0.3.10 proves the logger scrubs; this proves nothing downstream of it — an unhandled rejection, an SDK error path, a framework access log — reintroduces what the logger removed.
→ **files** `tests/production/log-hygiene.test.ts` · **verify** `pnpm test tests/production/log-hygiene.test.ts` passes against captured production logs and fails when an IP is deliberately logged · **after** T10.9.7, T0.3.10

#### T10.9.9 · `chore: scrape annotations and a portable dashboard definition`
`prometheus.io/scrape`, `port` and `path` annotations on the api and worker pod templates, plus `docs/observability/dashboard.json` defining the panels — redirect latency quantiles, error rate, queue depth, flush age, DLQ, divergence, classification split — as plain queries against the metric names above. Grafana-compatible JSON, but the value is the recorded query set, which survives changing the tool.
→ **files** `k8s/api/deployment.yaml`, `k8s/worker/deployment.yaml`, `docs/observability/dashboard.json` · **verify** the scraper discovers both targets and every panel query returns a series · **after** T10.9.8

#### T10.9.10 · `chore: add external uptime checks on redirect, bio and dashboard`
Three checks from outside the cluster: a real `/:slug` redirect asserting 307, a bio root asserting 200 with expected content, and the dashboard login page. External because every in-cluster check shares a failure domain with the thing it is checking — when the cluster's networking breaks, so does its monitoring.
→ **files** `docs/runbooks/oncall.md`, `infra/cloudflare/zone.json` · **verify** each check alerts within 2 minutes when its target is scaled to zero replicas · **after** T10.9.9

---

## S10.10 — Alerts

**As an** operator **I want** the specific failures that make the number dishonest to page me **so that** the system cannot look healthy while lying.

**Acceptance:**
- [ ] Alert rules committed as a ConfigMap, not configured in a console
- [ ] Redirect error rate · enqueue failure rate [INV-1] · queue depth · DLQ non-empty · missing next partition · store divergence [INV-7] · **classification drift** [INV-5]
- [ ] Every alert routes to a channel that is actually read
- [ ] Every alert has been fired once deliberately

**Tasks:**

#### T10.10.1 · `chore: add the alert rules ConfigMap scaffold`
`k8s/shared/alert-rules.yaml` as a ConfigMap holding Prometheus-format rule groups, mounted by whatever evaluates them. Plain rule YAML rather than a CRD, so this does not silently commit the project to an operator it has not chosen. One empty group, wired and mounting — rules land in the commits that follow.
→ **files** `k8s/shared/alert-rules.yaml` · **verify** `promtool check rules` on the extracted ConfigMap passes on an empty group · **after** T10.9.10

#### T10.10.2 · `feat: alert on redirect error rate`
Fires when non-307, non-404 responses exceed 1% of redirects over 5 minutes. 404s are excluded deliberately: a mistyped slug is a user event, not a system fault, and folding it in sets a floor of noise that trains everyone to ignore the alert.
→ **files** `k8s/shared/alert-rules.yaml` · **verify** driving 5% 500s at a staging api fires the alert within 6 minutes and it resolves within 6 of stopping · **after** T10.10.1

#### T10.10.3 · `feat: alert on enqueue failure rate` [INV-1]
Fires when `posta_enqueue_failures_total` grows at all over 10 minutes. This is the one alert whose corresponding user experience is *perfect*: every redirect succeeded, every visitor got where they were going, and the analytics quietly lost a slice of the day. Invariant 1 makes that the correct trade — it does not make it acceptable unnoticed.
→ **files** `k8s/shared/alert-rules.yaml` · **verify** stopping Redis at staging while driving redirects fires the alert while every request still returns 307 · **after** T10.10.2

#### T10.10.4 · `feat: alert on queue depth and worker lag`
Two rules: `posta_queue_depth` above 10 000 for 10 minutes, and `posta_last_flush_age_seconds` above 5× the batch interval for 5 minutes. Depth catches a worker too slow; flush age catches a worker wedged — a worker that has stopped consuming shows a growing depth *and* a growing flush age, while a traffic spike shows only the first.
→ **files** `k8s/shared/alert-rules.yaml` · **verify** pausing the worker Deployment while pushing events fires both rules; scaling it back resolves both · **after** T10.10.3

#### T10.10.5 · `feat: alert on a non-empty DLQ`
Fires when `posta_dlq_depth` is above zero for 5 minutes. Not a rate and not a threshold: a single dead-lettered batch is up to 100 events that reached neither store, and it needs a human deciding whether to replay it rather than a graph nobody opens.
→ **files** `k8s/shared/alert-rules.yaml` · **verify** planting one DLQ entry at staging fires the alert; draining it resolves within one evaluation interval · **after** T10.10.4

#### T10.10.6 · `feat: alert on a missing next partition`
Two rules from T1.3.5's `posta_events_default_rows` gauge and a partition-count gauge: rows in `events_default` above zero (the maintenance job has already failed), and fewer than 2 months of partitions provisioned ahead (it is about to). The second is the useful one — it fires with weeks of margin, in business hours, instead of at midnight on the 1st.
→ **files** `k8s/shared/alert-rules.yaml`, `apps/worker/src/partitions/partition-maintenance.job.ts` · **verify** dropping a future partition at staging fires the lookahead alert within one job interval · **after** T10.10.5, T1.3.5

#### T10.10.7 · `feat: alert on classification drift` [INV-5]
Fires when the `humano` share moves more than 15 percentage points from its trailing 7-day baseline over a 1-hour window. **This is the alert that matters most.** A swing in the humano/bot ratio means either an attack or a broken rule, and neither shows up in an error rate — every other signal in this story stays green while the product's single claim quietly stops being true. The threshold is a starting guess and the runbook says so; it gets tuned against real traffic in T10.12.2.
→ **files** `k8s/shared/alert-rules.yaml`, `docs/runbooks/classification-drift.md` · **verify** replaying a burst of unfurler traffic at staging moves the ratio past the threshold and fires the alert · **after** T10.10.6, T10.9.6

#### T10.10.8 · `feat: alert on R2 versus Postgres divergence` [INV-7]
Fires when `posta_store_divergence_rows` is non-zero in either direction for two consecutive evaluations. Divergence in the R2-ahead direction is recoverable by replay; divergence in the Postgres-ahead direction means the coupling in T3.4.6 broke and the log is no longer the source of truth — the same alert, two very different runbook branches.
→ **files** `k8s/shared/alert-rules.yaml` · **verify** planting a Postgres-only row at staging fires the alert with the direction label visible in the notification · **after** T10.10.7

#### T10.10.9 · `chore: route every alert to a channel that is actually read`
Alertmanager-format routing committed alongside the rules: everything to one channel for now, with severity labels distinguishing page-worthy from review-worthy. One channel, because a routing tree built for a team of one is a way to lose alerts in a folder nobody opens. Includes the deliberate firing of each rule from T10.10.2–T10.10.8, recorded with timestamps.
→ **files** `k8s/shared/alertmanager-config.yaml`, `docs/runbooks/oncall.md` · **verify** each of the seven alerts appears in the channel with its runbook link during a single rehearsal session, logged in the on-call doc · **after** T10.10.8

> **Classification drift is the alert that matters most.** A sudden swing in the humano/bot ratio means either an attack or a broken rule. Both need eyes, and neither shows up in an error rate — the system will be perfectly healthy while lying, which is the only failure mode that damages the thesis rather than the uptime.

---

## S10.11 — Runbooks

**As an** operator **I want** written procedures for the failures that will happen **so that** the 3am version of me is following a document instead of improvising.

**Acceptance:**
- [ ] `docs/runbooks/` covering: replay from R2 · queue backlog · DLQ drain · missing partition · Redis down · Postgres failover · broken Origin Rule · rollback
- [ ] Each has symptoms, diagnosis, fix, and verification
- [ ] The replay runbook has been **executed at least once** against the deployed stack
- [ ] Every alert in S10.10 links to its runbook
- [ ] An on-call summary: what alerts exist, what each means, first action

**Tasks:**

#### T10.11.1 · `feat: replay Job manifest and the Kubernetes addendum to the replay runbook`
`k8s/worker/replay-job.yaml` running the worker image's `posta replay` CLI (T3.6.4) as a one-off Job with the range as args, generous resources and no restart on failure. Extends `docs/runbooks/replay.md` with the k8s-shaped steps: how to template the range, where to watch progress (`kubectl logs -f job/`), and why the worker Deployment should be scaled to zero first so live and replayed writes are not interleaved.
→ **files** `k8s/worker/replay-job.yaml`, `docs/runbooks/replay.md` · **verify** the Job runs a `--dry-run` over one day against production and reports a non-zero record count without inserting · **after** T10.10.9, T3.6.8

#### T10.11.2 · `chore: rehearse the replay runbook against the deployed stack`
Truncate one non-current `events` partition on a restored copy of production, follow `docs/runbooks/replay.md` literally without improvising, and record the wall-clock time, the reconciliation report and every step where the document was wrong. **An unrehearsed replay runbook is indistinguishable from not having one** — T3.6.6 proved the code works; this proves the procedure does, under the conditions where it will actually be read.
→ **files** `docs/runbooks/replay.md`, `docs/M3-acceptance.md` · **verify** the rehearsal restores the partition to row-for-row equality and the runbook is updated with the measured duration and the corrections found · **after** T10.11.1

#### T10.11.3 · `docs: queue backlog and DLQ drain runbooks`
Backlog: how to read depth versus flush age, when to scale the worker Deployment versus when scaling makes it worse (Postgres connection pressure, T10.7.8), and how to confirm recovery. DLQ: how to inspect an entry's payload and failure reason (T3.1.5), how to decide replay-versus-discard, and the command to re-submit through `flushBatch`.
→ **files** `docs/runbooks/queue-backlog.md`, `docs/runbooks/dlq-drain.md` · **verify** an operator who has not read E3 can drain a planted DLQ entry at staging using only the document · **after** T10.11.2

#### T10.11.4 · `docs: missing partition runbook`
Symptoms (`events_default` filling, the lookahead alert), the immediate fix (`ensurePartitionsAhead(3)` by hand), how to move rows out of `events_default` into their correct partitions afterwards, and the root-cause check on the maintenance job (T1.3.4). The DEFAULT partition means nothing is lost — but rows sitting there are invisible to every partition-pruned analytics query, so the dashboard is wrong while the database is fine.
→ **files** `docs/runbooks/missing-partition.md` · **verify** an operator can move a planted `events_default` row into its month and see it appear in a dashboard query · **after** T10.11.3

#### T10.11.5 · `docs: Redis down and Postgres failover runbooks`
Redis: what still works (redirects on Postgres fallback, at higher latency), what stops (enqueue — events are lost by design, invariant 1), and the eviction-policy check to run after any provider-side failover, because a rebuilt instance comes back on the provider default. Postgres: failover behaviour, connection-string handling, what the api and worker do while it is unreachable, and how to confirm no events were lost once it returns.
→ **files** `docs/runbooks/redis-down.md`, `docs/runbooks/postgres-failover.md` · **verify** both documents state explicitly what data is lost versus delayed in each scenario, and the Redis one names the `CONFIG GET maxmemory-policy` check · **after** T10.11.4

#### T10.11.6 · `docs: broken Origin Rule runbook`
The two failure shapes and their opposite symptoms: the rule over-matching, so `/:slug` hits Next and every link 404s or renders a bio; and the rule under-matching, so `/` hits the api and every bio page 404s — the `/?utm=x` case landing here most often. Includes the T10.2.3 assertion as the diagnostic, the exact expression to restore, and the note that Cloudflare changes propagate in seconds, so recovery is fast once the cause is named.
→ **files** `docs/runbooks/origin-rule.md` · **verify** an operator can reproduce both failure shapes in a staging zone and restore correct routing using only the document · **after** T10.11.5

#### T10.11.7 · `docs: rollback runbook`
`kubectl rollout undo` per Deployment, how to decide whether the migration needs anything (usually nothing, per the expand-contract policy in T10.6.3), how to verify recovery with the smoke suite, and the honest statement of what rollback cannot fix — a destructive migration that already ran. Incorporates the measured recovery time from the T10.6.8 rehearsal.
→ **files** `docs/runbooks/rollback.md` · **verify** the document's commands match what was actually run in T10.6.8 and name the smoke test used to confirm recovery · **after** T10.11.6, T10.6.8

#### T10.11.8 · `docs: on-call summary linking every alert to its runbook`
One page: each of the seven alerts, what it actually means, its first action, and a link to its runbook — plus the reverse index from symptom to alert, since the 3am path usually starts at "the dashboard looks wrong" rather than at a notification. Every alert rule gains a `runbook_url` annotation pointing here.
→ **files** `docs/runbooks/oncall.md`, `k8s/shared/alert-rules.yaml` · **verify** every alert in `alert-rules.yaml` has a `runbook_url` resolving to a section that exists — asserted by a test over the rule file · **after** T10.11.7

---

## S10.12 — Launch

**As** JuanoDev **I want** a real link producing a real honest split **so that** the thesis is demonstrated in public rather than described.

**Acceptance:**
- [ ] Seeded account live with a real bio page
- [ ] A real link shared into a real channel; unfurlers, prefetches and humans all appear correctly split
- [ ] The `recibos` stream shows genuine traffic with honest reasons
- [ ] Security pass: no exposed secrets, no debug endpoints, rate limits verified, headers hardened
- [ ] Novel real-traffic cases promoted into the corpus (T4.4.10)
- [ ] `docs/M3-acceptance.md` complete
- [ ] Build-in-public post drafted from the real numbers

**Tasks:**

#### T10.12.1 · `chore: seed the production account and publish the real bio`
Run the seed script against production Postgres as a one-off Job from the api image, creating the single account (`tenant_id == user_id`, invariant 9), then publish a real bio page with real links. Uses the same Job pattern as the migration so the seed is auditable and repeatable rather than a `kubectl exec` nobody recorded.
→ **files** `k8s/api/seed-job.yaml` · **verify** `https://<handle>.posta.lat/` serves the real bio with correct OG tags, confirmed by a link preview in WhatsApp · **after** T10.11.8

#### T10.12.2 · `test: share a real link and assert the split is honest`
Share a real link into a real WhatsApp group and a real Instagram story, then assert against `events_classified`: the WhatsApp unfurler appears as `unfurler` with a `why` naming its user-agent, browser prefetches appear as `prefetch`, and human opens appear as `humano`. This is the epic's "done when" — and the moment the T10.10.7 drift threshold gets tuned against a real baseline instead of a guess.
→ **files** `docs/M3-acceptance.md` · **verify** the recorded event ids for all three classes are inspectable in `recibos` with their reasons, and the drift alert's baseline is updated from measured traffic · **after** T10.12.1

#### T10.12.3 · `chore: final production security pass` [security]
Verify against the live deployment: no debug or introspection endpoint reachable, rate limits enforced on `/v1/*` and the redirect path, security headers present, no Secret value in any log or error response, no publicly writable bucket, and `posta_reader` genuinely unable to read raw `events`. A checklist executed against production, with each result recorded — not a re-read of code that already passed review.
→ **files** `docs/M3-acceptance.md` · **verify** every item is recorded with the command used and its actual output · **after** T10.12.2

#### T10.12.4 · `feat: promote novel real-traffic cases into the corpus`
Adds the genuinely new UA and header combinations observed in T10.12.2 as corpus fixtures via the T4.4.10 procedure, with `provenance` set to the real production event id. Anything the view classified wrongly is recorded as an **ambiguous fixture with a rationale**, not quietly relabelled to match whatever the current rules happen to do — the corpus is the record of what is known, including what is known to be uncertain.
→ **files** `packages/core/src/classification/corpus/*.json` · **verify** `pnpm test corpus/golden.test.ts` stays green with the new fixtures and at least one carries a production event id as provenance · **after** T10.12.3, T4.4.10

#### T10.12.5 · `docs: complete the M3 acceptance record`
Consolidates the whole epic's measured results: latency by region, co-location round-trips, ingress overhead, the classification split from real traffic, the replay rehearsal duration, and the alert-firing log. The document is the evidence for every claim the launch post makes, which is what makes the post checkable by someone who doubts it.
→ **files** `docs/M3-acceptance.md` · **verify** every numeric claim in the document names the command or query that produced it · **after** T10.12.4

#### T10.12.6 · `docs: draft the build-in-public launch post from the real numbers`
The post writes itself from T10.12.2 if that was done honestly: the gap between what another shortener would have reported for that link and what Posta reports **is** the product, stated as one number. Publish the real one, including the parts less flattering than expected — the adversarial corpus limits (T4.4.8) belong in it too.
→ **files** `docs/launch-post.md` · **verify** every number in the draft traces to a row in `docs/M3-acceptance.md` · **after** T10.12.5

> The launch post is checkable or it is marketing. Every figure in it should point at a query someone else could run — that is the same property the product is selling, applied to its own announcement.
