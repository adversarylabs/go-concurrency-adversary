# go/concurrency — issue catalog

This document is the **issue catalog** for this adversary: the classes of defects we aim to find, how we detect them (static vs LLM), public pattern references, and staff priority (P0 / P1 / LLM-only / Cut).

It is documentation and roadmap for contributors — not a runtime contract. Implemented detectors live in `src/` with fixtures under `fixtures/`; the **Review verdicts** section records what ships first.

Public examples cited below illustrate bad patterns only. Do not scrape secrets from them or copy copyrighted code into fixtures.

**Catalog id:** `go/concurrency`  
**Status:** public OSS documentation of the issue classes this adversary targets  
**Goal:** trusted, high-precision detections. Prefer missing a weak signal over a false positive.

## Mission
Correct Go concurrency: cancellation, ownership, synchronization, and leak freedom.

## LLM strategy (required for world-class)
**Enhance:** ownership stories across functions; deadlock risk explanations.
**Discover:** lock ordering and multi-channel protocols.

### Division of labor
Static = precise facts. LLM = enhancement + evidence-gated discovery. When unsure, omit.

## Review verdicts (staff pass)

- **P0 implement:** `waitgroup.add-inside`, `waitgroup.copied`, `mutex.copy`, `loopvar.capture`, `context.withcancel-leak`, `select.default-busy`, `ticker.not-stopped`, `timer.not-stopped` (version-gated)
- **P1:** `goroutine.no-ctx`, `channel.close-twice`, `atomic.misuse`, `errgroup.limit-missing`, `signal.notify-stop`, `http.goroutine-per-request-leak`, `context.background-in-request`, `context.withvalue-keys`, `mutex.missing-unlock`
- **LLM-only:** `channel.send-no-receiver`, `channel.owner`, `race.map`, `mutex.rlock-reentry`, `singleflight.missing`
- **Cut:** `errgroup.missing` — "use errgroup" is style advice, not a defect; FP machine. `once.do-panic` — rare and obscure; not worth the noise budget. `cond.misuse` — "prefer channels" is opinion. `pool.forget-put` — sync.Pool Put is optional by design; forgetting it is legal.

## Issue catalog

---
### 1. `go-conc.goroutine.no-ctx` — Goroutine without cancellation

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** go func() with loop and no ctx.Done select.

**Static detection.** Detect go statements with loops missing ctx.

**LLM role.** LLM: is lifecycle bounded another way?

**False-positive guards.** One-shot goroutines.

**Public examples of the bad pattern:**
  - https://go.dev/blog/context
  - https://github.com/golang/go/wiki/CommonMistakes
  - https://github.com/sourcegraph/conc

---
### 2. `go-conc.waitgroup.add-inside` — WaitGroup.Add inside goroutine

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | high |

**What it is.** Racey Add placement.

**Static detection.** AST: Add call inside go lit.

**LLM role.** Classic mistake.

**False-positive guards.** None usually.

**Public examples of the bad pattern:**
  - https://github.com/golang/go/wiki/CommonMistakes
  - https://pkg.go.dev/sync#WaitGroup
  - https://go.dev/blog/race-detector

---
### 3. `go-conc.waitgroup.copied` — WaitGroup passed by value

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | high |

**What it is.** func f(wg sync.WaitGroup) copies counter.

**Static detection.** Detect WaitGroup by value params.

**LLM role.** None — this is `go vet` copylocks territory; implement as vet-parity for zero FP.

**False-positive guards.** None.

**Public examples of the bad pattern:**
  - https://github.com/golang/go/wiki/CommonMistakes
  - https://pkg.go.dev/sync#WaitGroup
  - https://github.com/securego/gosec — G307-ish patterns

---
### 4. `go-conc.mutex.copy` — Mutex copied after first use

| Field | Value |
| --- | --- |
| **Severity** | critical |
| **Target confidence** | high |

**What it is.** Lock value copies.

**Static detection.** vet-like detection of mutex in structs passed by value.

**LLM role.** None — vet copylocks parity; zero-FP static rule.

**False-positive guards.** None.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/sync#Mutex
  - https://github.com/golang/go/wiki/LockOSThread
  - https://go.dev/blog/race-detector

---
### 5. `go-conc.channel.send-no-receiver` — Unbuffered send without receiver path

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | low |

**What it is.** Potential deadlock.

**Static detection.** Hard; LLM+static limited.

**LLM role.** Discovery with callgraph.

**False-positive guards.** Select with default.

**Public examples of the bad pattern:**
  - https://go.dev/blog/deadlock
  - https://github.com/golang/go/wiki/CommonMistakes
  - https://go.dev/blog/pipelines

---
### 6. `go-conc.channel.close-twice` — Close channel twice / close after send race

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** Multiple close paths.

**Static detection.** Control flow hard; LLM.

**LLM role.** Ownership rules.

**False-positive guards.** sync.Once close patterns.

**Public examples of the bad pattern:**
  - https://go.dev/blog/pipelines
  - https://github.com/golang/go/wiki/CommonMistakes
  - https://pkg.go.dev/builtin#close

---
### 7. `go-conc.channel.owner` — Unclear channel ownership (multiple senders close)

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** Ownership discipline.

**Static detection.** LLM primary.

**LLM role.** Recommend single closer.

**False-positive guards.** Documented fan-in with WaitGroup.

**Public examples of the bad pattern:**
  - https://go.dev/blog/pipelines
  - https://github.com/sourcegraph/conc
  - https://go.dev/blog/context

---
### 8. `go-conc.select.default-busy` — Empty default select busy loop

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | high |

**What it is.** for { select { default: } } spins CPU.

**Static detection.** AST detect.

**LLM role.** Suggest block or timer.

**False-positive guards.** Intentional spin with runtime.Gosched rare.

**Public examples of the bad pattern:**
  - https://github.com/golang/go/wiki/CommonMistakes
  - https://pkg.go.dev/runtime#Gosched
  - https://go.dev/blog/pipelines

---
### 9. `go-conc.timer.not-stopped` — time.After in loop leak

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | high |

**What it is.** for { select { case <-time.After: } } allocates a timer per iteration. Go 1.23 made unstopped timers immediately GC-eligible, so on go >= 1.23 this no longer leaks — it is allocation churn only. Gate severity on the module's go directive.

**Static detection.** Detect time.After inside loops; read go.mod: go < 1.23 → medium (leak), go >= 1.23 → low (churn).

**LLM role.** Recommend NewTimer Stop.

**False-positive guards.** Few-iteration loops.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/time#After
  - https://github.com/golang/go/issues/11513
  - https://go.dev/blog/pipelines

---
### 10. `go-conc.context.withcancel-leak` — WithCancel without cancel call

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** ctx, cancel := WithCancel; cancel unused.

**Static detection.** SSA-ish unused cancel.

**LLM role.** defer cancel() required.

**False-positive guards.** Passed ownership documented.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/context
  - https://go.dev/blog/context
  - https://github.com/golang/go/wiki/CommonMistakes

---
### 11. `go-conc.context.withvalue-keys` — WithValue with built-in string keys

| Field | Value |
| --- | --- |
| **Severity** | low |
| **Target confidence** | high |

**What it is.** Collision-prone keys.

**Static detection.** Detect WithValue(ctx, "key".

**LLM role.** Typed keys.

**False-positive guards.** Internal tiny packages.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/context#WithValue
  - https://go.dev/blog/context
  - https://github.com/golang/go/wiki/CodeReviewComments

---
### 12. `go-conc.race.map` — Concurrent map write without sync

| Field | Value |
| --- | --- |
| **Severity** | critical |
| **Target confidence** | medium |

**What it is.** map write in multiple goroutines.

**Static detection.** go vet race patterns static approx; recommend race detector in CI.

**LLM role.** LLM multi-goroutine map access.

**False-positive guards.** Maps confined to one goroutine.

**Public examples of the bad pattern:**
  - https://go.dev/blog/race-detector
  - https://github.com/golang/go/wiki/CommonMistakes
  - https://pkg.go.dev/sync#Map

---
### 13. `go-conc.atomic.misuse` — Non-atomic composite read/write

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** i++ shared without atomic/mutex.

**Static detection.** Heuristic shared globals.

**LLM role.** LLM.

**False-positive guards.** Proven single-threaded.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/sync/atomic
  - https://go.dev/blog/race-detector
  - https://github.com/golang/go/wiki/CommonMistakes

---
### 14. `go-conc.mutex.rlock-reentry` — Lock order inversion risk

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | low |

**What it is.** Multiple mutexes different orders.

**Static detection.** LLM discovery primarily.

**LLM role.** Document lock order.

**False-positive guards.** Single mutex.

**Public examples of the bad pattern:**
  - https://github.com/golang/go/wiki/MutexOrChannel
  - https://go.dev/blog/race-detector
  - https://pkg.go.dev/sync

---
### 15. `go-conc.errgroup.limit-missing` — Unlimited errgroup parallelism

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | medium |

**What it is.** errgroup without SetLimit on large slices.

**Static detection.** Detect Go in loop without limit.

**LLM role.** Suggest SetLimit.

**False-positive guards.** Small fixed N.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/golang.org/x/sync/errgroup
  - https://github.com/sourcegraph/conc
  - https://go.dev/blog/pipelines

---
### 16. `go-conc.signal.notify-stop` — signal.Notify without NotifyContext/Stop

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | high |

**What it is.** Leak signal chans.

**Static detection.** Detect Notify without Stop.

**LLM role.** Recommend signal.NotifyContext.

**False-positive guards.** main process lifetime OK.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/os/signal#NotifyContext
  - https://pkg.go.dev/os/signal
  - https://github.com/golang/go/wiki/CommonMistakes

---
### 17. `go-conc.http.goroutine-per-request-leak` — Handler spawns goroutine without request ctx

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** go process(data) ignoring r.Context().

**Static detection.** Detect go in handlers.

**LLM role.** Cancel on request end.

**False-positive guards.** Detached audit logs intentional.

**Public examples of the bad pattern:**
  - https://go.dev/blog/context
  - https://pkg.go.dev/net/http
  - https://github.com/sourcegraph/conc

---
### 18. `go-conc.singleflight.missing` — Thundering herd without singleflight

| Field | Value |
| --- | --- |
| **Severity** | low |
| **Target confidence** | low |

**What it is.** Perf pattern.

**Static detection.** LLM discovery on cache fills.

**LLM role.** Suggest singleflight.

**False-positive guards.** Low QPS.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/golang.org/x/sync/singleflight
  - https://github.com/golang/groupcache
  - https://go.dev/blog/context

---
### 19. `go-conc.ticker.not-stopped` — Ticker not stopped

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | high |

**What it is.** time.NewTicker without Stop.

**Static detection.** Detect missing Stop.

**LLM role.** defer Stop.

**False-positive guards.** Process lifetime tickers in main.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/time#Ticker
  - https://github.com/golang/go/wiki/CommonMistakes
  - https://go.dev/blog/pipelines

---
### 20. `go-conc.context.background-in-request` — context.Background in request path

| Field | Value |
| --- | --- |
| **Severity** | medium |
| **Target confidence** | high |

**What it is.** Detaches from cancel/deadlines.

**Static detection.** Detect Background in HTTP/gRPC handlers.

**LLM role.** Use r.Context().

**False-positive guards.** Detached async after response with care.

**Public examples of the bad pattern:**
  - https://go.dev/blog/context
  - https://pkg.go.dev/context
  - https://github.com/golang/go/wiki/CommonMistakes

---
### 21. `go-conc.loopvar.capture` — Goroutine captures loop variable (Go < 1.22)

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | high |

**What it is.** `for _, v := range xs { go func() { use(v) }() }` shared one variable across iterations before Go 1.22, so goroutines observe the last value. Go 1.22 made loop variables per-iteration — gate strictly on the module's go directive.

**Static detection.** go/defer statement whose closure references a loop variable without shadowing or parameter passing, AND go.mod go directive < 1.22.

**LLM role.** None — the version gate is the FP guard.

**False-positive guards.** go >= 1.22 modules (never report); `v := v` shadowing; value passed as closure parameter.

**Public examples of the bad pattern:**
  - https://go.dev/blog/loopvar-preview
  - https://go.dev/doc/go1.22
  - https://github.com/golang/go/wiki/CommonMistakes

---
### 22. `go-conc.mutex.missing-unlock` — Lock without Unlock on some return path

| Field | Value |
| --- | --- |
| **Severity** | high |
| **Target confidence** | medium |

**What it is.** mu.Lock() followed by an early return or panic path with no defer mu.Unlock() deadlocks every later caller.

**Static detection.** CFG check: Lock not immediately followed by defer Unlock in a function with multiple return paths; report the specific unguarded path.

**LLM role.** Verify there is no intentional lock handoff to another function.

**False-positive guards.** Documented lock-handoff patterns; TryLock flows; all branches verifiably unlock.

**Public examples of the bad pattern:**
  - https://pkg.go.dev/sync#Mutex
  - https://go.dev/blog/race-detector
  - https://github.com/golang/go/wiki/CommonMistakes

---

## Implementation roadmap (after approval)
P0 static rules + fixtures → LLM enhancement → discovery → precision bake-off on public repos.

**P0 priorities:** WaitGroup.Add inside goroutine, lock copies (vet parity), loop-variable capture (go<1.22), missing cancel, busy select, unstopped ticker/timer (version-gated).
