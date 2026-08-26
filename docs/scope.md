# go/concurrency — mission and scope

Source of truth for what this adversary is *for*.

- **Package:** `go-concurrency`
- **Factory routing:** human PR comments are attributed to this adversary only when they match **In scope**.
- **Languages / surfaces:** Go (`*.go`)

## Mission

Review Go concurrency: lifecycle, cancellation, synchronization, races, and channel ownership.

## In scope (fair miss if humans raised it and we did not)

- Data races and shared mutable state without synchronization
- Goroutine leaks; missing WaitGroup/errgroup joins
- A type starts `Serve` / `ListenAndServe` in an explicit goroutine, or through a locally resolved helper whose signature and body prove the listener-backed callback runs in a goroutine, but exposes no field-bound `Close`/`Shutdown`/`Stop` mechanism. Unproven helper names, synchronous helpers, tests, and process-lifetime `main` packages are excluded.
- WaitGroup completion paths that an early goroutine return can skip
- Cancellation / context not propagated or ignored
- `context.Context` stored on long-lived structs instead of passed as a parameter
- Channel ownership and close races; select starvation
- Deadlocks, lock ordering, incorrect mutex use
- Production mutable state keyed by goroutine identifiers parsed from runtime stack text
- Local success/ownership markers written after a failed external mutation that later skips retries
- Concurrent API guarantees not tested (overlapping Export/Flush/Shutdown, etc.)

## Out of scope (not a miss for this adversary)

- Pure docs/style
- CI/workflow configuration (github-actions)
- General non-concurrency correctness (route to go or engineering-review)
- Non-Go languages

## Factory grading rule

- **In scope + human raised it + this adversary did not surface it** → real miss → suggested issue for **this** package
- **Out of scope** → do not grade as a miss for this adversary
- **Better fit for another adversary** → route there; do not double-count as a miss here
- **Unclear** → prefer out-of-scope for grading
