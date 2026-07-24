# Official Go adversary catalog plan

## Product principles

The catalog is organized around engineering expertise rather than package names. Framework and library support is evidence that a domain is present; it is not the product boundary.

Every adversary will:

- parse Go and the domain configuration it needs without executing the target;
- synthesize a few remediation-oriented findings instead of emitting linter output;
- own `fixtures/excellent`, `good`, `average`, `poor`, and `terrible`;
- snapshot the complete stable review contract for each fixture;
- own a 50–100 repository calibration index without vendoring upstream code;
- measure high-confidence false positives before expanding its rule set;
- detect both repository relevance and change relevance, preferring precision;
- explain whether an experienced Go engineer would approve the change and what to fix first.

The shared fixture scale is semantic:

| Grade | Expected review |
| --- | --- |
| Excellent | No findings; concrete positive engineering signals; approval |
| Good | No material findings; perhaps one factual positive; approval |
| Average | One contained medium-risk issue; focused remediation |
| Poor | One or two issues that block approval |
| Terrible | A high-impact failure mode plus related lifecycle/design evidence; priorities are explicit |

Benchmark indexes store repository, default branch, calibration focus, and verification date. Calibration runs pin a commit separately so the corpus can remain current without making snapshots nondeterministic.

## Priority

| Order | Adversary | Why now |
| ---: | --- | --- |
| 1 | Go Concurrency | Highest cross-repository operational value; the workspace already has heavy context and channel use |
| 2 | Go Testing | Largest current surface and the fastest path to dogfooding review quality |
| 3 | Go CLI | The main Go repository has substantial Cobra and flag behavior |
| 4 | Go HTTP | Strong current `net/http` surface and high production impact |
| 5 | Go Modules | Applies to every module and supports supply-chain/reproducibility reviews |
| 6 | Go Security | High impact, but confidence and severity need careful calibration |
| 7 | Go Project | Broad value, but package-boundary advice needs corpus calibration to avoid taste-based findings |
| 8 | Go Observability | Useful once there is enough local instrumentation to dogfood |
| 9 | Go Database | Important catalog domain; current workspace has little database-driver usage |
| 10 | Go Performance | Requires the most evidence discipline and should build on benchmark/escape-analysis integration |

## 1. Go Concurrency

**Purpose.** Establish whether concurrent work has safe ownership, cancellation, synchronization, and completion semantics.

**Supported ecosystem.** Language goroutines and channels; `context`; `sync`; `sync/atomic`; `golang.org/x/sync/errgroup`, semaphore, and singleflight; recognizable worker-pool libraries without depending on them.

**Initial rules.**

- WaitGroup registration and completion lifecycle
- cancellation function ownership
- errgroup derived-context propagation
- deterministic unbuffered-channel self-deadlock
- later, after calibration: blocked sends/receives, goroutine leak ownership, channel closing ownership, lock-order risk, loop fan-out bounds

**Detection.** Repository match requires Go source. Change match starts with changed `.go` files; a programmatic detector should later require concurrency syntax/imports or modifications to code already owning concurrency. Docs-only and unrelated module changes are false.

**Benchmark repositories.** The implemented corpus contains 61 verified repositories, including `golang/go`, `golang/sync`, Kubernetes, etcd, containerd, Cilium, Prometheus, CockroachDB, Temporal, gRPC-Go, NATS, OpenTelemetry Collector, `sourcegraph/conc`, `uber-go/goleak`, and several worker-pool implementations.

**Fixture plan.** Bounded workers and structured cancellation at the top; discarded cancel, Add-inside-worker, and deterministic channel deadlock across the lower tiers. Every risky fixture has a clean ownership counterexample.

**Expected review.** “Worker completion is not reliable because registration can race with Wait. Move Add into the launching goroutine first.” Evidence names the goroutine, synchronization object, operation, and location.

**Status.** First implementation complete at the initial-rule stage.

## 2. Go Testing

**Purpose.** Decide whether the test suite gives reliable, deterministic evidence for the changed behavior.

**Supported ecosystem.** `testing`, `testify`, `gomock`, `mockery`, `httptest`, `testcontainers-go`, fuzz tests, benchmarks, and common golden-file patterns.

**Initial rules.**

- parallel subtests capturing or sharing mutable state
- missing cleanup for processes, servers, files, environment, and global state
- time/sleep/network randomness that makes tests flaky
- assertions lost inside background goroutines
- table tests whose cases do not exercise distinct behavior
- mocks that reproduce implementation details instead of boundaries
- changed behavior without proportional branch/error-path tests

**Detection.** High confidence when `_test.go`, `testdata`, fixtures, mocks, or test-only dependencies change. Medium when production behavior changes beside an existing test package and a diff-based coverage gap can be established. Ordinary production-only edits should not select it solely because tests exist.

**Benchmark seeds.** `golang/go`, `stretchr/testify`, `uber-go/mock`, `vektra/mockery`, Kubernetes, etcd, CockroachDB, Temporal, Caddy, Tailscale, Prometheus, and `gotestyourself/gotestsum`; expand to 60 with service, CLI, controller, and library strata.

**Fixture plan.** Excellent uses deterministic clocks, cleanup, and meaningful parallel isolation; good is conventional table coverage; average has one brittle timing boundary; poor leaks global state or asserts from a goroutine; terrible combines shared parallel state, sleeps, external network, and no cleanup.

**Expected review.** A small number of findings grouped by reliability or coverage, with the concrete shared resource/test cases and a judgment about whether failures will be reproducible.

**Priority.** 2.

## 3. Go CLI

**Purpose.** Review whether a command-line application has predictable configuration, cancellation, diagnostics, and automation behavior.

**Supported ecosystem.** Cobra, Viper, Kong, urfave/cli, `flag`, pflag, and hand-built command dispatch.

**Initial rules.**

- ambiguous flag/config/environment precedence
- validation after side effects begin
- command errors converted to success exit codes
- signal or context cancellation not reaching long-running work
- command construction that prevents dependency isolation in tests
- telemetry or logging emitted before opt-out/configuration is resolved
- generated completion/help drift and hidden required inputs

**Detection.** Confirm a Go CLI through `cmd/`, `main`, command dependencies, or command registration. Select high when command, flag, config, completion, or CLI entrypoint files change; do not select for unrelated library packages.

**Benchmark seeds.** Cobra, Viper, Kong, urfave/cli, GitHub CLI, Docker CLI, Helm, Hugo, Terraform, restic, rclone, and `go-task/task`; expand to 60 across developer tools, operators, and end-user CLIs.

**Fixture plan.** Progress from a context-aware command with explicit precedence and exit mapping to a monolithic command that mixes parsing, config mutation, network work, telemetry, and `os.Exit`.

**Expected review.** State the user-visible failure first: “Environment configuration silently overrides an explicit flag, so automation cannot reliably control the target.”

**Priority.** 3.

## 4. Go HTTP

**Purpose.** Assess whether Go HTTP services have safe request boundaries and production-ready server lifecycle behavior.

**Supported ecosystem.** `net/http`, Gin, Chi, Echo, Fiber, Gorilla handlers, and framework-neutral middleware.

**Initial rules.**

- server read/header/write/idle timeout coverage
- graceful shutdown and in-flight request draining
- request context dropped before downstream calls
- middleware ordering that defeats recovery, auth, tracing, or logging
- unbounded request bodies or decompression
- trusted-proxy/client-IP misconfiguration
- panic recovery that hides failures or skips cleanup
- response writes after error/timeout and missing validation boundaries

**Detection.** Confirm server/router construction or supported imports. Select high for handlers, middleware, router setup, server configuration, proxy trust, and lifecycle changes; medium for code directly called by changed handlers. Do not select for an unrelated Go file in an HTTP repository.

**Benchmark seeds.** Caddy, Traefik, Gin, Chi, Echo, Fiber, Prometheus, Grafana, gRPC-Gateway, go-kit, Tailscale, and Kubernetes API server; expand to 60 with frameworks and production services.

**Fixture plan.** Excellent includes bounded server settings, cancellation, validation, recovery, and graceful shutdown. Lower tiers isolate missing timeouts, incorrect middleware order, unbounded bodies, proxy trust, and abrupt shutdown.

**Expected review.** “The handler code is straightforward, but the server can hold connections indefinitely because header and idle timeouts are unset; fix lifecycle hardening before load testing.”

**Priority.** 4.

## 5. Go Modules

**Purpose.** Review module structure and dependency declarations for reproducibility, upgrade safety, and maintainable ownership.

**Supported ecosystem.** `go.mod`, `go.sum`, `go.work`, vendoring, toolchain directives, multi-module repositories, private modules, and Go tool dependencies.

**Initial rules.**

- local or branch-like replace directives escaping development
- module and toolchain version changes with rollout implications
- stale/inconsistent vendoring and sums
- accidental dependency major-version/path mismatch
- runtime dependencies introduced only for tooling
- fragmented modules without an ownership boundary
- retractions/excludes/replaces that hide unresolved compatibility risk

**Detection.** High when module, workspace, vendor metadata, tool dependency declarations, or module-release automation changes. Go source-only changes are false.

**Benchmark seeds.** `golang/go`, `golang/mod`, Kubernetes, Grafana, Terraform, Caddy, Tailscale, Helm, GoReleaser, Hugo, Temporal, and Prometheus; expand to 60 with single-module, workspace, and multi-module strata.

**Fixture plan.** Cover a clean pinned module, a justified workspace, a lingering local replace, vendor drift, and a confused multi-module/tool dependency layout.

**Expected review.** Explain the build/release consequence, not syntax: “This release would resolve an unpublished local replacement and cannot be reproduced outside the author’s checkout.”

**Priority.** 5.

## 6. Go Security

**Purpose.** Review Go trust boundaries, cryptographic choices, secret handling, and transport/authentication behavior.

**Supported ecosystem.** Standard `crypto` and `crypto/tls`, JWT implementations, OAuth/OIDC clients, `x/crypto`, secret stores, HTTP authentication middleware, and certificate tooling.

**Initial rules.**

- disabled or incomplete TLS/certificate verification
- insecure randomness used for credentials, nonces, or tokens
- JWT algorithm/key confusion and missing claim validation
- secrets in logs, errors, URLs, command lines, or persistent config
- user-controlled file/network targets crossing a trust boundary
- authentication without authorization at the protected operation
- unsafe crypto primitives only when security purpose is established

**Detection.** High for auth, permission, token, TLS, crypto, secret, and boundary code changes; high for relevant dependency/config changes; false for trivial docs-only changes. Repository use alone is insufficient in PR mode.

**Benchmark seeds.** `golang/crypto`, age, Vault, step-ca, Caddy, Tailscale, Cosign, oauth2-proxy, go-jose, golang-jwt, Cloudflare Tunnel, and Trivy; expand to 60 across identity, PKI, signing, networking, and applications.

**Fixture plan.** Pair every vulnerable fixture with a valid security-context counterexample so the same primitive used for checksums or tests does not trigger security advice.

**Expected review.** Lead with the violated boundary and realistic impact, with critical severity reserved for exploitable credential, authentication, or code-execution paths.

**Priority.** 6.

## 7. Go Project

**Purpose.** Review repository-level package boundaries, dependency direction, ownership, and maintainability without enforcing one canonical layout.

**Supported ecosystem.** Single binaries, libraries, multi-command repositories, monorepos, `internal/`, `cmd/`, optional `pkg/`, generators, and platform-specific packages.

**Initial rules.**

- dependency cycles or boundary inversions introduced by a change
- `internal` ownership bypassed through duplicated/public surface
- command packages accumulating reusable domain logic
- catch-all packages and cross-domain mutable state
- package splits that create forwarding-only indirection
- generated and handwritten ownership becoming ambiguous
- package naming or layout feedback only when it causes navigation/ownership risk

**Detection.** Full-repository mode or package/import graph changes. In PR mode require added/moved packages, import-direction changes, module/workspace changes, or broad cross-package edits; a local function edit is normally false.

**Benchmark seeds.** Go, Kubernetes, Caddy, Prometheus, Terraform, Tailscale, restic, Hugo, Grafana, Temporal, Docker/Moby, and Helm; expand to 60 stratified by repository size and product type.

**Fixture plan.** Use equivalent features implemented with cohesive boundaries versus unnecessary `manager/factory/service` layers, plus command/domain coupling and invalid dependency direction.

**Expected review.** Describe the maintenance path: “Policy now flows from `internal/storage` back into `cmd`, so both the service and CLI must change together.”

**Priority.** 7.

## 8. Go Observability

**Purpose.** Decide whether logs, traces, metrics, and error reporting can explain production behavior without creating cardinality or context gaps.

**Supported ecosystem.** `slog`, Zap, Zerolog, OpenTelemetry, Prometheus client libraries, StatsD-style metrics, and framework-neutral wrappers.

**Initial rules.**

- trace or correlation context dropped at async/process boundaries
- metrics labels with user IDs, URLs, errors, or other unbounded values
- counters/histograms that cannot answer the named operational question
- duplicate error recording across layers
- logs missing stable operation/outcome context at major boundaries
- secret/PII exposure in telemetry
- exporters/batchers not flushed during CLI, worker, or server shutdown

**Detection.** Confirm supported telemetry APIs or wrappers. Select high for instrumentation, exporter, middleware, logging, metric, or shutdown changes; medium when an instrumented boundary changes and loses context. Uninstrumented business code alone is false.

**Benchmark seeds.** OpenTelemetry Go, OpenTelemetry Collector, Prometheus, client_golang, Zap, Zerolog, Grafana, Loki, Tempo, Thanos, VictoriaMetrics, and Caddy; expand to 60 with libraries, services, agents, and CLIs.

**Fixture plan.** Progress from bounded labels and propagated context to duplicated errors, high-cardinality metrics, secret-bearing logs, and an unflushed short-lived process.

**Expected review.** Judge reporting trustworthiness: “Requests are traced, but tenant IDs are used as metric labels, so production cardinality will make the metric expensive and unreliable.”

**Priority.** 8.

## 9. Go Database

**Purpose.** Review transaction, pool, query, and migration behavior independent of the chosen data-access library.

**Supported ecosystem.** `database/sql`, pgx, sqlx, Bun, GORM, sqlc, common migration tools, and PostgreSQL-specific COPY/batch behavior.

**Initial rules.**

- rows, transactions, and connections not closed on every path
- transaction boundaries that split one invariant
- context cancellation not reaching query/commit/rollback
- retries around non-idempotent or partially committed work
- pool settings incompatible with service concurrency/lifetime
- N+1 query shape and avoidable serialized batches
- unchecked `Scan`, `Rows.Err`, commit, or rollback failures
- locking and migration changes that are unsafe for rolling deploys

**Detection.** Confirm database imports, generated query packages, SQL/migrations, or configured drivers. Select high for query, transaction, migration, pool, repository/data-layer, or directly generated sqlc changes; do not select for unrelated service logic.

**Benchmark seeds.** pgx, sqlc, Gitea, Grafana, Temporal, CockroachDB, Vitess, GORM, Bun, sqlx, Goose, and Ent; expand to 60 across libraries and production applications.

**Fixture plan.** Include library-equivalent implementations of one workflow so rules prove they understand the domain rather than spelling. Lower tiers cover leaks, broken transaction invariants, unsafe retries, N+1, and rollout-incompatible migrations.

**Expected review.** “The retry wraps a transfer after its debit may have committed, so a transient error can double-charge. Make the operation idempotent or move retry below the transaction boundary.”

**Priority.** 9.

## 10. Go Performance

**Purpose.** Review material allocation, copying, buffering, and contention risks with evidence rather than micro-optimization taste.

**Supported ecosystem.** Standard slices, maps, strings, buffers, `sync.Pool`, encoders, I/O pipelines, benchmarks, profiles, and compiler escape-analysis output when explicitly available.

**Initial rules.**

- allocation or copying growth inside established hot loops/paths
- repeated slice/string conversion with retained duplicate data
- unbounded buffers or maps in long-lived services
- `sync.Pool` retaining oversized/sensitive objects or fighting the allocator
- lock contention introduced into a parallel hot path
- tiny I/O and missing batching where call volume is established
- benchmark regressions only when before/after evidence is available

**Detection.** Require changed executable Go code plus a credible hot-path signal: benchmark/profile files, loop/call-site context, performance-sensitive package, or explicit full-repository mode. Do not select for every Go change.

**Benchmark seeds.** VictoriaMetrics, fasthttp, Sonic, json-iterator/go, Ristretto, Badger, Pebble, CockroachDB, Zap, xxhash, klauspost/compress, and Prometheus; expand to 60 across storage, networking, serialization, and general applications.

**Fixture plan.** Include justified allocation tradeoffs and readability-first code at the top, then measurable copying, retention, contention, and unbounded growth. Snapshot evidence includes operation counts or before/after benchmark data when present.

**Expected review.** “This adds one allocation” is never enough. A valid finding says where it repeats, what data is retained/copied, and why that path is operationally material.

**Priority.** 10.

## Implementation sequence

Each adversary advances through the same gates:

1. Verify the initial 50–100 repository corpus and stratify it by ecosystem.
2. Write the five graded expected reviews before adding broad detection.
3. Implement the smallest parser-backed rule set that distinguishes those reviews.
4. Run a 20-repository high-confidence false-positive audit.
5. Dogfood against Adversary Labs Go repositories and add only actionable regressions.
6. Add precise automatic detection and artifact-isolation tests.
7. Publish only after CI, corpus checks, snapshots, manifest validation, and pack validation pass.

Go Concurrency is the reference implementation for this process. Go Testing is next.

