# go/concurrency

**go/concurrency** reviews Go concurrency for lifecycle races, cancellation ownership mistakes, WaitGroup misuse, and unsafe channel or synchronization patterns an experienced Go engineer would block.

It is a **concurrency domain reviewer**, not a general race detector or linter. It prefers silence over speculative warnings. When it reports, the concurrent work cannot start, stop, fail, or complete predictably.

## What it does

1. **Discovers** non-test Go files (`*.go`, excluding `*_test.go`).
2. **Parses** with Tree-sitter Go and runs structural detectors with stable rule ids.
3. **Synthesizes a review** focused on lifecycle ownership.
4. Optionally **enhances** with a model when provided — ranking and explanation only.

It never executes the scanned project as the product under review, never installs dependencies into it, and never needs network access to the target repository.

## What it detects

Every **shipped rule id**, severity, and short description lives in **[CHECKS.md](CHECKS.md)** — the audit surface for “what does this adversary look for?”

Highlights:

| Area | Examples |
| --- | --- |
| Cancellation | Unused cancel functions; context not derived for child work; `context.Context` stored on structs |
| WaitGroup | Add inside goroutine; early return before bare Done; WaitGroup copied by value |
| Channels | Self-deadlock patterns; busy `select` with default |
| Timers | `time.Ticker` / `Timer` not stopped |
| Loops | Loop variable capture in goroutines |
| Mutex | Mutex copied by value |
| State identity | Mutable state keyed by goroutine IDs parsed from stack text |

### Ownership boundaries

Other official adversaries own adjacent classes so findings stay non-duplicative:

| Concern | Owned by |
| --- | --- |
| CLI process/subprocess cancellation at the command boundary | [`go/cli`](https://github.com/adversarylabs/go-cli-adversary) |
| HTTP server/client timeouts and request contexts | [`go/http`](https://github.com/adversarylabs/go-http-adversary) |
| DB rows/transaction lifecycle | [`go/database`](https://github.com/adversarylabs/go-database-adversary) |

## Precision stance

- **High confidence** only for deterministic, evidence-backed patterns.
- Clean fixtures must stay quiet; vulnerable fixtures must fire where graded fixtures exist.
- Prefer missing a weak signal over a false positive on normal production code.
