# Checks

| Rule | Severity | Scans for |
| --- | --- | --- |
| `go-concurrency.async-listener.missing-close` | High | A type starts `Serve`/`ListenAndServe` in a direct goroutine, or passes a listener created by unshadowed standard-library `net.Listen` and its owned `*http.Server.Serve` callback at the exact parameter positions of a reachable, module-qualified local async helper, but has no reachable field-bound `Close`/`Shutdown`/`Stop` mechanism; unresolved, dead, shadowed, or reassigned relationships, synchronous helpers, process-lifetime `main`, tests, and helpers with a definitely active initiating listener-stop path stay quiet, while conditional or post-`Serve` cleanup does not count as shutdown ownership |
| `go-concurrency.atomic-capacity-check-update` | High | Capacity is checked and reserved in separate atomic operations |
| `go-concurrency.cancellation-owned` | Medium | Concurrent work lacks cancellation ownership |
| `go-concurrency.channel.self-deadlock` | High | Channel self-deadlock pattern |
| `go-concurrency.concurrent-api.missing-test` | Medium | Concurrent API guarantee lacks test for overlapping calls |
| `go-concurrency.context.background-in-request` | Medium | An operation replaces an available caller context with `context.Background()` or `context.TODO()` |
| `go-concurrency.context.cancellation` | High | Cancel function unused or context not derived |
| `go-concurrency.context.error-classification` | Medium | Context-aware call errors treated as ordinary recoverable/reportable failures |
| `go-concurrency.context.stored-on-struct` | High | A struct field stores `context.Context` (or a same-file named alias of it) |
| `go-concurrency.external-state-marker-before-success` | Medium | A local success/ownership map entry is written after an external mutation whose error path falls through |
| `go-concurrency.goroutine-id-state-key` | Medium | Production mutable state is keyed by a goroutine identifier parsed from `runtime.Stack` text |
| `go-concurrency.loopvar.capture` | Medium | Loop variable captured by goroutine |
| `go-concurrency.mutex.copy` | High | Mutex / RWMutex copied by value |
| `go-concurrency.select.default-busy` | Medium | Busy select with default in a tight loop |
| `go-concurrency.ticker.not-stopped` | Medium | Ticker not stopped |
| `go-concurrency.timer.not-stopped` | Medium | Timer not stopped/drained |
| `go-concurrency.waitgroup.copied` | High | WaitGroup copied by value |
| `go-concurrency.waitgroup.done-not-deferred` | High | A goroutine can return before its bare `WaitGroup.Done` call |
| `go-concurrency.waitgroup.lifecycle` | High | WaitGroup Add/Done/Wait lifecycle race |
