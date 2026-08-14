# Checks — what go/concurrency detects

This file is the **public audit list** of detectors. If a rule id appears here, it is part of the product surface: it should fire on a vulnerable pattern, stay quiet on the documented clean case, and produce file:line evidence where applicable.

Runtime source of truth: analysis under `src/`.
Regression entry: graded fixtures and corpus under `test/`.

**Scope:** `*.go` files (Tree-sitter structural analysis). Most rules target non-test code. `go-concurrency.concurrent-api.missing-test` is deliberately `_test.go`-only (it detects missing test coverage for concurrent APIs).

---

## High

### `go-concurrency.waitgroup.lifecycle`

| | |
| --- | --- |
| **What** | WaitGroup Add/Done/Wait lifecycle race |
| **Why** | Add after Wait or Add inside goroutine loses accounting |
| **Looks for** | WaitGroup Add inside goroutine or after Wait |
| **Stays quiet when** | Add before go; Done in defer; single Wait owner |
| **Remediation** | Own WaitGroup in the starter; Add before launching |

### `go-concurrency.waitgroup.done-not-deferred`

| | |
| --- | --- |
| **What** | A goroutine can return before its bare `WaitGroup.Done` call |
| **Why** | Completion bookkeeping at the bottom of a goroutine is skipped by earlier exits, leaving the counter positive after the worker is gone |
| **Looks for** | A locally known `sync.WaitGroup` whose goroutine closure has a return before a non-deferred `Done` |
| **Stays quiet when** | `Done` is deferred at goroutine entry (directly or through a deferred closure); a direct loop body owns per-iteration accounting; the receiver is not the known WaitGroup; or no exit precedes the bare call |
| **Public examples** | GitHub’s merged [`wgdonenotdeferred` analyzer](https://github.com/github/gh-aw/pull/40837) and its [approved closure-scope correction](https://github.com/github/gh-aw/pull/41026) |
| **Remediation** | Register before launch and make `defer wg.Done()` the first operation inside the goroutine |

### `go-concurrency.waitgroup.copied`

| | |
| --- | --- |
| **What** | WaitGroup copied by value |
| **Why** | Copies break Done/Wait pairing |
| **Looks for** | WaitGroup passed/assigned by value |
| **Stays quiet when** | Pass `*sync.WaitGroup` |
| **Remediation** | Always share WaitGroup by pointer |

### `go-concurrency.mutex.copy`

| | |
| --- | --- |
| **What** | Mutex / RWMutex copied by value |
| **Why** | Unlock on a different instance |
| **Looks for** | Mutex in structs passed by value |
| **Stays quiet when** | Share mutex by pointer or embed carefully |
| **Remediation** | Never copy a locked or shared mutex |

### `go-concurrency.channel.self-deadlock`

| | |
| --- | --- |
| **What** | Channel self-deadlock pattern |
| **Why** | Same goroutine send/receive without buffer or select |
| **Looks for** | Structural self-deadlock shapes |
| **Stays quiet when** | Buffered channels, separate owners, or select |
| **Remediation** | Separate producers and consumers |

### `go-concurrency.context.cancellation`

| | |
| --- | --- |
| **What** | Cancel function unused or context not derived |
| **Why** | Leak of work after parent cancel |
| **Looks for** | `context.WithCancel` cancel ignored; children use Background |
| **Stays quiet when** | defer cancel(); derive child contexts |
| **Remediation** | Always defer cancel and pass derived ctx |

### `go-concurrency.atomic-capacity-check-update`

| | |
| --- | --- |
| **What** | Capacity is checked and reserved in separate atomic operations |
| **Why** | Two callers can both observe room under the limit before either increments the counter |
| **Looks for** | Add/Reserve/Acquire-style methods that compare an atomic load (or a thin load accessor) with a max/limit and later call Add/Store/Swap on the same state |
| **Stays quiet when** | One mutex covers the check and update; a CAS retry loop performs admission; reservation happens before the limit decision |
| **Remediation** | Combine the check and reservation with CAS, or use a mutex/weighted semaphore |

## Medium

### `go-concurrency.goroutine-id-state-key`

| | |
| --- | --- |
| **What** | Production mutable state is keyed by a goroutine identifier parsed from `runtime.Stack` text |
| **Why** | Goroutine IDs are not a supported application ownership boundary; stack text is diagnostic output, and ignored parse failures can collapse independent operations onto key zero |
| **Looks for** | A semantically changed non-test Go path where one helper parses and returns the exact `goroutine <id>` prefix from `runtime.Stack(..., false)`, discards the conversion error, and supplies that helper result directly or through one local assignment to an exactly resolved `sync.Map`, native map, or simple same-file native-map defined type/alias key operation. Evidence may be the changed key/helper, a state declaration or same-file map type that makes mutability newly provable, or a deleted terminating zero guard that makes an existing key path unsafe. |
| **Stays quiet when** | Stack output is only logged or diagnosed; `all=true`; parsing fails closed; an ID-specific guard provably terminates before key use; pprof/trace/debug affinity checks; tests; context, request IDs, or explicit handles own the state; the parsed value is not used as a mutable state key |
| **Public grounding** | Go FAQ, “Why is there no goroutine ID?”; Cortex store-gateway review #7271 |
| **Remediation** | Pass request-scoped state/context through the interface and use an explicit request handle; isolate a temporary compatibility shim and fail closed on parse errors |

Map-type resolution is intentionally limited to simple, non-generic defined types and aliases declared in the reviewed file. Imported, generic, and cross-file type graphs stay out of deterministic scope unless their mutable map type can be proven locally.

### `go-concurrency.context.error-classification`

| | |
| --- | --- |
| **What** | Context-aware call errors treated as ordinary recoverable/reportable failures |
| **Why** | Cancellation can be swallowed, logged as a failure, or retried during shutdown |
| **Looks for** | An error from a call passed `context.Context`, followed by logging/rejection/continue without cancellation classification |
| **Stays quiet when** | The error is returned directly, the call does not receive context, or `ctx.Err()` / `errors.Is` handles cancellation first |
| **Remediation** | Classify and propagate cancellation before ordinary error handling |

### `go-concurrency.context.background-in-request`

| | |
| --- | --- |
| **What** | An operation replaces an available caller context with `context.Background()` or `context.TODO()` |
| **Why** | Blocking work no longer observes the caller's deadline or cancellation |
| **Looks for** | Direct-scope `Background` / `TODO` calls in functions and callbacks that receive `context.Context` |
| **Stays quiet when** | The caller context is propagated, no caller context exists, or deliberate detachment uses `context.WithoutCancel(ctx)` |
| **Remediation** | Pass the caller context through; make intentional detachment explicit and bounded |

### `go-concurrency.loopvar.capture`

| | |
| --- | --- |
| **What** | Loop variable captured by goroutine |
| **Why** | All goroutines see final loop value (pre-Go 1.22 patterns / explicit capture bugs) |
| **Looks for** | Goroutine closes over loop variable unsafely |
| **Stays quiet when** | Per-iteration binding |
| **Remediation** | Pass loop vars as goroutine args |

### `go-concurrency.ticker.not-stopped`

| | |
| --- | --- |
| **What** | Ticker not stopped |
| **Why** | Timer goroutine leak |
| **Looks for** | `time.NewTicker` without Stop |
| **Stays quiet when** | defer ticker.Stop() |
| **Remediation** | Stop tickers when done |

### `go-concurrency.timer.not-stopped`

| | |
| --- | --- |
| **What** | Timer not stopped/drained |
| **Why** | Spurious wakeups / leaks |
| **Looks for** | `time.NewTimer` without Stop/drain |
| **Stays quiet when** | Stop and drain correctly |
| **Remediation** | Follow timer cleanup rules |

### `go-concurrency.select.default-busy`

| | |
| --- | --- |
| **What** | Busy select with default in a tight loop |
| **Why** | CPU spin |
| **Looks for** | `for { select { default: } }` |
| **Stays quiet when** | Block on channel or use ticker |
| **Remediation** | Avoid default-busy loops |

### `go-concurrency.cancellation-owned`

| | |
| --- | --- |
| **What** | Concurrent work lacks cancellation ownership |
| **Why** | Cannot stop cleanly |
| **Looks for** | Goroutines without ctx/stop channel |
| **Stays quiet when** | Propagate cancel or stop signals |
| **Remediation** | Every long-lived goroutine must be stoppable |

### `go-concurrency.concurrent-api.missing-test`

| | |
| --- | --- |
| **What** | Concurrent API guarantee lacks test for overlapping calls |
| **Why** | Tests for serialized Export/ForceFlush/Shutdown-style APIs must prove single-active execution under overlap |
| **Looks for** | Test files with 2+ concurrent `go` launches of lifecycle selectors (Export/ForceFlush/Shutdown/OnEmit) whose enclosing Test func lacks structural proof (atomic.Add* >1 check + error, etc.) |
| **Stays quiet when** | The same Test func containing the concurrent launches has an active counter (atomic inside call body) or equivalent max-concurrency assertion |
| **Remediation** | Add instrumentation and assertion in the test double for the serialization invariant |
