# Checks — what go/concurrency detects

This file is the **public audit list** of detectors. If a rule id appears here, it is part of the product surface: it should fire on a vulnerable pattern, stay quiet on the documented clean case, and produce file:line evidence where applicable.

Runtime source of truth: analysis under `src/`.
Regression entry: graded fixtures and corpus under `test/`.

**Scope:** non-test `*.go` files; Tree-sitter structural analysis.

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

## Medium

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
