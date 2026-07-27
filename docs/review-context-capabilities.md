# ReviewContext capability discovery for Go adversaries

## Decision

The Go catalog should adopt one architectural boundary:

> The runtime prepares review evidence. The adversary applies domain judgment.

An adversary should not receive a repository path and reconstruct a pull request by walking a checkout. It should receive an immutable, bounded, revision-aware `ReviewContext` whose evidence already carries provenance.

This document is capability discovery, not an SDK design or implementation. The API sketches show ownership and intent. Names and object boundaries can change.

## Inventory

There are currently two implemented Go-oriented repositories:

| Repository | Status | Current character |
| --- | --- | --- |
| `go-concurrency-adversary` | Initial implementation | Parser-backed deterministic concurrency reviewer |
| `go-adversary` | Legacy implementation | Generic regex-based Go security scanner |

The catalog plan also defines nine additional domain reviewers: Go HTTP, Database, CLI, Testing, Performance, Modules, Security, Observability, and Project.

The legacy `go-adversary` should not remain a separate product. Its TLS, shell execution, and filesystem permission evidence belongs under Go Security. Its implementation is nevertheless valuable for identifying runtime capabilities.

## Current SDK/runtime boundary

The runtime has already started centralizing change discovery, but the SDK does not expose it as reviewer context:

- CLI input v1 can contain base/head refs and changed file names.
- The CLI also materializes a richer `ADVERSARY_CHANGE_CONTEXT` containing statuses, renames, and repository files.
- TypeScript `RuntimeInput` types only the source path and leaves all other fields untyped.
- `RuleContext` exposes `repoPath`, `glob`, and `rglob`, but not the authoritative change context.
- `RuleContext` exposes no revisioned reads, evidence provenance, language semantics, related-code mapping, tests, deterministic analysis providers, or model-review capability.

As a result, current adversaries reconstruct context from `repoPath` even when the runtime has already resolved some of it. `repoPath`, `glob`, and `rglob` should be considered transitional APIs for expert reviewers.

### Observed failure mode

During this audit, Go Concurrency fixture snapshots stopped seeing their fixture source when unrelated documentation was dirty in the parent repository. The adversary invoked Git from a nested fixture path, observed the parent worktree diff, then attempted to interpret that diff as the fixture's review change.

The fixture harness was isolated outside the parent checkout so documentation validation remains stable. The adversary's Git heuristic was intentionally not refined; runtime-owned context is the actual fix.

This is not merely a test-harness inconvenience. It demonstrates why an adversary cannot be allowed to choose its own baseline or scope:

- the runtime knows the intended review target;
- the runtime already resolved whether this is a PR, branch, worktree, or full-repository review;
- nested worktrees and subdirectories make repository-relative interpretation ambiguous;
- two adversaries can otherwise review different changes during the same run.

The migration should remove this heuristic rather than refine it. Fixture tests in the future should replay a prepared `ReviewContext`.

## Current responsibility audit

### Go Concurrency

`src/discover.ts` currently owns:

- detecting whether the target is a Git repository;
- choosing `HEAD`, a merge base, a default branch, or `HEAD^`;
- invoking Git for changed paths, rename detection, hunks, and tracked files;
- deciding between change review and repository review;
- walking directories when Git is unavailable;
- maintaining ignored-directory and file-count policy;
- reading file contents and enforcing size/binary limits;
- normalizing paths;
- deciding which changed lines can support findings.

`src/parser.ts` and `src/analyze.ts` currently own:

- loading a Go grammar and parsing source;
- detecting syntax errors;
- finding functions and methods;
- resolving import aliases;
- locating declarations and call expressions;
- approximating local symbol identity;
- reconstructing WaitGroup, cancellation, and channel lifecycles;
- determining whether evidence belongs to changed code;
- generating snippets and source locations;
- sorting and deduplicating evidence.

These are context preparation responsibilities. The reviewer should consume facts such as:

- “`workers.Add(1)` is inside goroutine G while `workers.Wait()` is reachable from the launcher”;
- “the cancellation result of `context.WithTimeout` is discarded”;
- “this unbuffered channel operation has no concurrent peer in the local control-flow graph.”

The reviewer should decide whether those facts are material, how they relate, what risk they create in this change, and what remediation deserves priority.

`src/review.ts` is closest to the desired boundary, but remains rule-engine shaped. It maps fact identifiers directly to fixed findings and fixed overall assessments. It should evolve into an expert review rubric over prepared evidence.

### Legacy Go adversary

`src/analyze.ts` currently owns:

- recursively walking the repository;
- ignoring directories and applying file limits;
- reading all matching files;
- implementing glob matching;
- searching source with regular expressions;
- finding the first matching line and snippet;
- checking repository-wide file presence;
- deciding when a missing file or missing content matters;
- sorting detections.

`src/spec.ts` mixes three concerns:

- evidence queries;
- security interpretation;
- final finding language and severity.

The runtime should provide file inventory, revisioned reads, structural search, Go syntax/semantic facts, and evidence locations. Go Security should own the trust-boundary interpretation. For example, the runtime can state that `tls.Config.InsecureSkipVerify` is assigned the constant `true`; the reviewer decides whether this is test scaffolding, a deliberately constrained connection, or a material certificate-validation bypass.

## Capability model

The SDK should expose capabilities rather than a more convenient filesystem wrapper. `ctx.Read()` is better than `fs.readFile`, but it is still insufficient unless the runtime controls revision, relevance, limits, provenance, and context budgeting.

A conceptual shape:

```ts
interface ReviewContext {
  change: ChangeContext;
  repository: RepositoryContext;
  code: CodeContext;
  tests: TestContext;
  analyses: AnalysisContext;
  model: ReviewModel;
  capabilities: CapabilitySet;
}
```

Every returned item should include a stable evidence identifier and provenance:

```ts
interface EvidenceRef {
  id: string;
  file: string;
  revision: "base" | "head";
  range?: SourceRange;
  origin: "diff" | "source" | "syntax" | "types" | "call-graph" | "analysis" | "metadata";
  truncated?: boolean;
}
```

### Shared capability proposals

| Capability | Why reviewers need it | General value | Runtime ownership | Possible API |
| --- | --- | --- | --- | --- |
| Authoritative change set | Reviewers must know what changed without inventing a Git baseline | Universal | Yes | `ctx.change.files({ language, role, includeDeleted })` |
| Revision-aware hunks | Findings must point to changed code and compare old/new behavior | Universal | Yes | `ctx.change.hunks(file, { contextLines })` |
| Renames and deletions | Lifecycle, tests, configuration, and APIs can regress through removal | Universal | Yes | `ChangedFile.status`, `previousPath`, base/head evidence |
| Repository inventory | Reviewers need manifests, configs, tests, and domain files | Universal | Yes | `ctx.repository.files(query)` |
| Safe revisioned reads | Reviewers need bounded source around evidence, not unrestricted filesystem access | Universal | Yes | `ctx.repository.read(file, { revision, range })` |
| Search | Reviewers need references, configuration keys, event names, and declarations | Universal | Yes | `ctx.repository.search({ query, syntax, scope, revision, limit })` |
| File classification | Generated, vendored, test, source, config, migration, and fixture files need different treatment | Universal | Yes | `ctx.repository.classify(files)` |
| Related files | A changed handler, query, or worker rarely makes sense alone | Universal | Yes | `ctx.repository.related({ seeds, relations, depth, budget })` |
| Repository metadata | Full review versus PR, language versions, CI/deploy shape, ownership, and repository scale affect judgment | Universal | Yes | `ctx.repository.metadata()` |
| Parsed syntax | Reviewers need declarations and operations without shipping parsers | Language-general | Yes, through language services | `ctx.code.syntax(file, { language: "go" })` |
| Symbols and types | Text is insufficient for aliases, methods, interfaces, generated code, and framework wrappers | Language-general | Yes | `ctx.code.symbolAt(location)`, `symbol(id)`, `typeOf(expr)` |
| Packages and modules | Domain applicability and architectural boundaries depend on package/module identity | Go and other ecosystems | Yes | `ctx.code.package(id)`, `ctx.code.modules()` |
| References | Ownership and behavior often cross files | Language-general | Yes | `ctx.code.references(symbol, { direction, limit })` |
| Call graph | Context, cancellation, transaction, handler, and shutdown reasoning crosses calls | Language-general | Yes | `ctx.code.callers(symbol)`, `callees(symbol)` |
| Control-flow facts | Definite leaks, missing cleanup, exits, retries, and deadlocks require path information | Language-general | Yes | `ctx.analyses.controlFlow(symbol)` |
| Data-flow facts | Context, identity, secrets, errors, and values flow through wrappers | Language-general | Yes | `ctx.analyses.dataFlow({ sources, sinks, scope })` |
| Resource lifecycle | Rows, transactions, bodies, channels, goroutines, timers, and exporters have ownership lifecycles | Cross-domain | Yes, provider-backed | `ctx.analyses.resources({ kinds, scope })` |
| Test mapping | Reviewers need tests for changed behavior, not every `_test.go` file | Universal | Yes | `ctx.tests.forSymbols(symbols)`, `ctx.tests.related(files)` |
| Test evidence | Failures, race results, coverage, and flake history are valuable when already available | Universal | Yes; runtime decides execution policy | `ctx.tests.results()`, `coverage()`, `history()` |
| Dependency graph | Frameworks, drivers, instrumentation, and module changes affect review | Cross-ecosystem | Yes | `ctx.repository.dependencies({ ecosystem: "go" })` |
| Configuration resolution | Flags, environment, deployment, proxies, pool sizes, and feature settings may live outside Go source | Cross-domain | Yes | `ctx.repository.configuration({ consumers, keys })` |
| Prepared analysis facts | Deterministic analyzers should support judgment without becoming findings | Universal | Yes, through versioned providers | `ctx.analyses.get("go.resource-lifecycle.v1", request)` |
| Bounded model review | LLM-first reviewers need consistent model access, grounding, budgets, and structured output | Universal | Yes | `ctx.model.review({ domain, rubric, evidence, questions, schema, budget })` |
| Evidence provenance | Every conclusion must be traceable and incomplete context must be visible | Universal | Yes | Evidence IDs, source ranges, origin, truncation, unavailable-capability reasons |

### Capability behavior

Capabilities should be:

- immutable and side-effect free;
- normalized to repository-relative paths;
- explicit about base versus head;
- deterministic in ordering and truncation;
- budgeted by files, symbols, graph depth, bytes, and model tokens;
- provenance-carrying;
- able to report “unavailable” rather than silently approximating;
- versioned independently;
- safe across host, container, and remote execution.

Query depth, scope, and budget arguments in these sketches are reviewer intent, not authority. The runtime applies the actual limits and reports truncation or omitted relationships.

The reviewer should not receive `repoPath`. Filesystem read permission should eventually be unnecessary for an LLM-first reviewer.

## Evidence preparation versus judgment

The desired pipeline has three layers:

1. **Runtime context:** change resolution, repository inventory, safe content, metadata, and relevance budgeting.
2. **Language and analysis services:** syntax, types, references, call graphs, control/data flow, test mapping, and versioned deterministic facts.
3. **Domain reviewer:** a bounded rubric that weighs evidence, asks whether complexity and risk are justified, synthesizes findings, recognizes positive signals, and gives an opinion.

Deterministic analysis should produce facts, not final prose or severity, except for protocol-level validation. Examples:

```ts
{
  kind: "go.waitgroup.registration",
  waitGroup: symbolRef,
  add: evidenceRef,
  launch: evidenceRef,
  wait: evidenceRef,
  relation: "add-occurs-inside-launched-goroutine",
  certainty: "proven"
}
```

```ts
{
  kind: "go.http.middleware-chain",
  route: "POST /deployments",
  middleware: ["request-id", "recovery", "logging", "auth"],
  handler: symbolRef,
  evidence: [...]
}
```

The reviewer then decides:

- whether the fact matters in this change;
- whether nearby code or configuration mitigates it;
- whether several facts share one underlying remediation;
- severity based on operational authority and reachability;
- whether the implementation is clear and maintainable;
- what to fix first;
- whether the change should merge.

## Bounded LLM reviewers

An expert reviewer should be more than a prompt and less than a general-purpose coding agent.

Each adversary should own a structured review profile:

```ts
interface ExpertReviewProfile {
  domain: string;
  questions: ReviewQuestion[];
  severityGuidance: SeverityGuidance[];
  evidencePreferences: EvidencePreference[];
  positiveSignals: PositiveSignalDefinition[];
  findingLimit: number;
  rubricVersion: string;
}
```

The runtime should own:

- model selection;
- context assembly and token budgeting;
- evidence formatting;
- citation enforcement;
- structured output validation;
- retry/failure behavior;
- redaction and privacy policy;
- caching;
- deterministic fallback behavior.

The adversary should own:

- the bounded domain;
- the questions a Staff Go engineer asks;
- domain-specific tradeoffs and counterexamples;
- severity calibration;
- grouping and prioritization expectations;
- review quality fixtures.

This avoids a giant prompt while allowing the reviewer to reason beyond fixed rule matches.

## Per-adversary capability discovery

### Go Concurrency

**Context responsibilities to move**

- Git baseline, changed files, changed lines, reads, directory walking, ignore policy, limits, and snippets.
- Go parsing, import aliases, function/method discovery, symbol identity, and source locations.
- Goroutine, channel, context, WaitGroup, lock, and errgroup relationship extraction.
- Call graph expansion to launchers, workers, shutdown paths, and ownership boundaries.
- Related tests, race-test results, and goroutine-leak tests.

**Deterministic evidence**

- goroutine launch graph;
- channel creation, capacity, sends, receives, and close sites;
- WaitGroup Add/Done/Wait relations;
- context derivation, propagation, cancellation, and escape;
- lock acquisition graph and defer/unlock paths;
- blocking operations and select cancellation alternatives;
- bounded versus unbounded fan-out;
- race detector or goleak results when supplied by CI.

**LLM judgment**

- who conceptually owns a goroutine or channel;
- whether cancellation and shutdown are proportional to the lifecycle;
- whether synchronization is understandable and maintainable;
- whether a worker pool or fan-out design is justified;
- whether deterministic facts combine into one lifecycle problem;
- whether a risk is reachable and operationally important.

**Balance**

Approximately 45% deterministic evidence and 55% model judgment. Definite self-deadlocks and invalid synchronization ordering remain proven facts; ownership, maintainability, proportionality, and synthesis belong to the reviewer.

**Expert-review change**

Replace direct rule-to-finding mapping with questions such as: “Can every launched unit of work stop when its owner stops?” and “Is ownership obvious to a maintainer?” Feed the reviewer lifecycle graphs and concrete paths, not raw repository files.

### Go HTTP

**Context responsibilities to move**

- framework/import detection;
- route and handler discovery;
- middleware registration order and scope;
- server construction and lifecycle;
- handler callees and downstream context use;
- related validation, authentication, tracing, logging, and tests;
- proxy/deployment configuration relevant to trusted client identity.

**Deterministic evidence**

- normalized route table and handler symbols;
- ordered middleware chains per route group;
- `http.Server` timeout and shutdown configuration;
- body-read sites and size-limit wrappers;
- request-context propagation into downstream calls;
- response-write/error paths;
- panic recovery boundaries;
- trusted-proxy configuration and client-IP consumers;
- handler-to-test mapping.

**LLM judgment**

- whether middleware order matches the application’s security and observability needs;
- whether the timeout model is appropriate for streaming versus ordinary requests;
- whether handlers have coherent responsibilities;
- whether lifecycle and graceful shutdown are operationally safe;
- whether request validation and API design are understandable;
- whether observability captures the right boundaries without duplication.

**Balance**

About 40% deterministic evidence and 60% model review.

**Expert-review change**

Review request lifecycle and service design as a whole. A missing timeout fact is evidence; the finding should explain which requests can remain live and why that matters for this server.

### Go Database

**Context responsibilities to move**

- driver/ORM/sqlc detection;
- query and generated-code mapping;
- transaction scopes across functions;
- retry loops and idempotency evidence;
- connection, rows, statement, and batch lifecycles;
- SQL and migration discovery;
- schema relationships and deployment metadata;
- query callers and related tests.

**Deterministic evidence**

- transaction begin/commit/rollback paths;
- database calls with or without context;
- `Rows.Close`, `Rows.Err`, `Scan`, commit, and rollback handling;
- retry boundaries and operations repeated;
- pool configuration and consumers;
- queries issued inside loops and batch alternatives;
- SQL locking statements and lock order;
- migration operations classified by likely lock/rewrite behavior;
- generated sqlc method-to-SQL mapping.

**LLM judgment**

- whether a transaction encloses the actual business invariant;
- whether retries are safe for the operation;
- whether pool choices match process concurrency and deployment scale;
- whether N+1 evidence matters at expected cardinality;
- whether migration sequencing is safe for rolling deployment;
- whether the data layer is maintainable across pgx, `database/sql`, sqlx, Bun, GORM, or sqlc.

**Balance**

About 45% deterministic evidence and 55% model review.

**Expert-review change**

Center reviews on correctness and operational safety, not library-specific calls. The same transaction boundary should receive the same judgment regardless of adapter.

### Go CLI

**Context responsibilities to move**

- command-tree and entrypoint discovery;
- flags, environment, config files, defaults, and precedence;
- signal/context propagation;
- exit-code and error paths;
- help and completion artifacts;
- telemetry/logging initialization;
- command tests and golden output.

**Deterministic evidence**

- normalized command/subcommand tree;
- flag definitions, required/default values, and validation sites;
- configuration sources and assignment order;
- `os.Exit`, returned errors, and exit-code mapping;
- signal registration and context flow into long-running callees;
- stdout/stderr/logging destinations;
- completion/help generation and checked-in artifacts;
- command-to-test mapping.

**LLM judgment**

- whether command organization matches user workflows;
- whether precedence is predictable;
- whether validation happens before side effects;
- whether diagnostics and exit behavior work for humans and automation;
- whether cancellation, telemetry, and logging respect configuration;
- whether the command architecture is testable without needless indirection.

**Balance**

Roughly 50% deterministic evidence and 50% model review.

**Expert-review change**

Frame findings as user and operator consequences: “An explicit flag loses to environment configuration,” not “Viper binding order matched a rule.”

### Go Testing

**Context responsibilities to move**

- changed tests and related production symbols;
- table/subtest structure;
- shared fixtures, globals, environment, ports, clocks, and cleanup;
- parallel execution relationships;
- test results, race results, coverage, and flake history;
- mock generation and mocked interfaces;
- fixture and golden-file relevance.

**Deterministic evidence**

- subtest graph and `t.Parallel` scopes;
- captured or shared mutable symbols;
- cleanup registration and resource acquisition;
- sleeps, real clocks, random seeds, network/process use;
- assertions made in background goroutines;
- changed branches/errors and mapped tests;
- repeated historical failures when supplied;
- mock expectations compared with called boundaries.

**LLM judgment**

- whether tests prove behavior rather than implementation;
- whether table cases are meaningfully distinct;
- whether concurrency and cleanup make failures reproducible;
- whether mocks clarify or obscure the contract;
- whether coverage is proportional to risk;
- whether fixtures are readable and maintainable.

**Balance**

About 50% deterministic evidence and 50% model review.

**Expert-review change**

Judge confidence: “Would this suite catch the plausible regression introduced here?” Avoid scoring table-driven style or mock counts.

### Go Performance

**Context responsibilities to move**

- hot-path and benchmark relevance;
- before/after benchmark results;
- profiles and escape-analysis output when available;
- allocation/copy sites;
- loop and call-frequency context;
- lock contention and buffer growth;
- representative tests/benchmarks.

**Deterministic evidence**

- benchmark deltas with statistical metadata;
- allocation and bytes/op deltas;
- escape-analysis facts;
- profiles and hot call paths;
- repeated conversions/copies inside established loops;
- unbounded collection growth;
- lock acquisition in parallel paths;
- buffer and pool retention facts.

**LLM judgment**

- whether a measured regression is meaningful for the product path;
- whether allocation reductions justify complexity;
- whether buffering and pooling have safe ownership;
- whether the change optimizes the correct bottleneck;
- whether readability should win absent credible hot-path evidence.

**Balance**

Approximately 70% deterministic evidence and 30% model review. Performance claims should be evidence-heavy; the model supplies tradeoff judgment, not invented cost estimates.

**Expert-review change**

Require measured or structurally credible hot-path evidence before reviewing optimization. “One allocation exists” is not a finding.

### Go Modules

**Context responsibilities to move**

- parsing `go.mod`, `go.sum`, `go.work`, vendor metadata, and tool declarations;
- dependency graph and version delta;
- replace, exclude, retract, workspace, and toolchain semantics;
- module boundaries and release topology;
- generated/vendored consistency;
- dependency advisories and provenance when available.

**Deterministic evidence**

- normalized module/workspace graph;
- direct/indirect dependency changes;
- local, filesystem, pseudo-version, or fork replacements;
- module path and semantic-major compatibility;
- toolchain and Go version delta;
- vendor/sum consistency;
- runtime versus tool-only dependency use;
- release modules affected by a change.

**LLM judgment**

- whether module boundaries reflect ownership;
- whether a replace is a deliberate rollout bridge or accidental release blocker;
- whether an upgrade is proportionate and testable;
- whether multi-module complexity pays for itself;
- what release or compatibility risk matters first.

**Balance**

Approximately 70% deterministic evidence and 30% model review.

**Expert-review change**

Use parsers and the module graph for facts, then review reproducibility and ownership. Do not turn every indirect dependency change into advice.

### Go Security

**Context responsibilities to move**

- changed trust-boundary code;
- authentication and authorization call paths;
- crypto/TLS API and configuration facts;
- secret/PII data flow;
- network, filesystem, process, and deserialization sinks;
- framework route and middleware relationships;
- dependency advisories;
- deployment and identity metadata;
- security tests.

The legacy `go-adversary` currently performs repository walk, reads, globbing, regex search, and line extraction for three of these signals. All should move.

**Deterministic evidence**

- resolved assignments to security-sensitive configuration;
- taint paths from untrusted input to process, SQL, path, template, or network sinks;
- authentication versus authorization checks on reachable routes/operations;
- JWT algorithms, key sources, and validated claims;
- randomness sources and security-sensitive consumers;
- TLS versions, verification callbacks, and trust roots;
- secret-like values reaching logs, URLs, errors, or persisted config;
- dependency advisory matches with reachable package evidence when possible.

**LLM judgment**

- the actual trust boundary and attacker capability;
- whether a dangerous-looking primitive is constrained safely;
- whether mitigations are complete;
- exploitability and severity;
- whether remediation fits the architecture;
- how multiple facts combine into one attack path.

**Balance**

Approximately 60% deterministic evidence and 40% model review. Evidence extraction should be strict; threat modeling and severity need expert reasoning.

**Expert-review change**

Retire fixed regex-to-critical mappings. For example, shell execution is evidence; severity depends on whether untrusted input reaches the shell and what authority the process has.

### Go Observability

**Context responsibilities to move**

- telemetry framework/wrapper discovery;
- trace and correlation context propagation;
- metric descriptors, labels, and call sites;
- logging fields and data origins;
- error recording paths;
- exporter/batcher lifecycle;
- request, job, worker, and CLI boundaries;
- privacy configuration and tests.

**Deterministic evidence**

- spans and context links across calls/goroutines;
- metric names, types, labels, and label-value sources;
- potential cardinality classes such as UUID, URL, error, free text, or bounded enum;
- duplicate error recording along one call path;
- log fields sourced from secrets or personal data;
- provider/exporter initialization and shutdown/flush paths;
- instrumented versus uninstrumented major boundaries.

**LLM judgment**

- whether telemetry answers useful operational questions;
- whether context propagation gaps will break investigation;
- whether duplication or cardinality harms reliability;
- whether the right boundaries are instrumented;
- whether wrappers improve consistency or hide meaning;
- whether privacy and operational value are balanced.

**Balance**

About 45% deterministic evidence and 55% model review.

**Expert-review change**

Judge whether an operator could explain a failure, not whether a logging call exists.

### Go Project

**Context responsibilities to move**

- package/module/import graph;
- changed public symbols and API compatibility;
- package moves, additions, and deletions;
- ownership/CODEOWNERS and repository metadata;
- `internal`, `cmd`, optional `pkg`, generated, and platform boundaries;
- callers, tests, and dependency direction;
- historical churn/coupling when available.

**Deterministic evidence**

- package and module topology;
- import cycles and new dependency edges;
- public API surface delta;
- command packages owning reusable domain symbols;
- duplicated symbols or forwarding-only call chains;
- generated/handwritten ownership crossings;
- co-change/churn data supplied as optional repository metadata.

**LLM judgment**

- whether boundaries match responsibilities;
- whether a new abstraction reduces or adds navigation cost;
- whether dependency direction is maintainable;
- whether repository layout helps likely contributors;
- whether a package split or merge is justified;
- whether the change creates long-term ownership friction.

**Balance**

Approximately 25% deterministic evidence and 75% model review. Structural facts are deterministic; project design is highly contextual and should not become layout dogma.

**Expert-review change**

Replace layout rules with architecture review questions. `pkg/` or `internal/` is never intrinsically good or bad.

## Manifest and compatibility implications

The manifest will eventually need capability declarations, not filesystem permissions as a proxy for review needs. Conceptually:

```yaml
review:
  domain: go-concurrency
  capabilities:
    required:
      - change.v1
      - repository.read.v1
      - go.syntax.v1
      - go.symbols.v1
    optional:
      - go.call-graph.v1
      - go.control-flow.v1
      - tests.mapping.v1
      - tests.race-results.v1
      - model.review.v1
```

This is not a proposed final schema. Capability negotiation must answer:

- Is the capability available?
- Which provider and version produced it?
- What scope and budget were applied?
- Was evidence truncated?
- Can the reviewer continue with lower confidence?
- Does enabling it require network, model, or execution authority?

Model access should be explicit. A deterministic fallback may produce an evidence-only report, but it should not impersonate the full Staff Engineer review.

## Recommended migration order

1. Define an expanded, versioned runtime input containing authoritative change context and evidence references.
2. Add immutable repository inventory, revisioned read, search, classification, and related-file capabilities.
3. Add Go syntax, symbols, packages, types, references, and call graph as runtime language services.
4. Add test mapping and optional supplied test/race/coverage evidence.
5. Add versioned analysis facts for control flow, data flow, and resource lifecycles.
6. Add bounded, grounded model review with structured output and evidence citation.
7. Migrate Go Concurrency first:
   - remove Git and directory discovery;
   - remove file reads and bundled parser assets;
   - consume prepared lifecycle facts;
   - replace fixed rule synthesis with the concurrency expert rubric.
8. Fold legacy `go-adversary` evidence into Go Security and retire the generic product.
9. Implement the remaining catalog reviewers against capabilities only; do not create new repository walkers.

## Acceptance criteria for the future architecture

- No Go adversary invokes Git.
- No Go adversary walks a directory.
- No Go adversary reads arbitrary repository paths.
- No Go adversary bundles a language parser.
- Every evidence item is revision-aware and provenance-carrying.
- Context omissions and truncation are visible to the reviewer.
- Deterministic analyzers emit facts, not domain findings.
- LLM conclusions cite prepared evidence.
- Review fixtures test judgment, prioritization, counterexamples, and synthesis—not filesystem discovery.
- The same prepared context can be replayed deterministically across reviewer versions.
