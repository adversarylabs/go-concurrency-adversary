# Go Concurrency adversary

Go Concurrency reviews Go code for concurrency behavior an experienced Go engineer would block: lifecycle races, cancellation ownership mistakes, deadlocks, and unsafe channel or synchronization patterns.

It is built around one review question:

> Can this concurrent work start, stop, fail, and complete predictably?

The adversary parses Go with the official Tree-sitter Go grammar. It does not execute the target repository and does not report findings from raw text matches.

> Architecture note: the current parser and repository discovery are transitional. The target design makes the runtime responsible for context preparation and leaves this adversary responsible for expert concurrency judgment. See [ReviewContext capability discovery](docs/review-context-capabilities.md).

## Initial rules

| Rule | Review question |
| --- | --- |
| `go-concurrency.waitgroup.lifecycle` | Is work registered before goroutine launch so `Wait` cannot race ahead? |
| `go-concurrency.context.cancellation` | Does the owner retain cancellation functions and propagate errgroup cancellation? |
| `go-concurrency.channel.self-deadlock` | Can a newly created local unbuffered channel reach a concurrent peer? |

Related evidence is grouped into one remediation. A deterministic local-channel deadlock or WaitGroup lifecycle race drives the overall risk; finding counts do not.

The intentionally small first rule set leaves broad judgments such as “this goroutine may leak” out until calibration can establish ownership and lifecycle with low false-positive rates.

## Fixtures and calibration

`fixtures/` contains five repository-level examples:

- `excellent`: explicit cancellation ownership and ordered WaitGroup lifecycle
- `good`: bounded waiting with cancellation
- `average`: a contained cancellation ownership defect
- `poor`: a WaitGroup registration race
- `terrible`: cancellation loss, lifecycle race, and deterministic deadlock

Each fixture owns `expected.review.json`, which snapshots the assessment, grouped findings, evidence, recommendations, positives, and ship opinion.

`benchmarks/corpus.json` indexes 61 verified open-source Go repositories. The repositories are calibration inputs only; their source is not copied or shipped.

## Automatic detection

`adversary auto` selects Go Concurrency when Go source changes. The v1 manifest uses the canonical SDK `detection.files` field. A future programmatic detector can narrow selection to concurrency-relevant syntax once the SDK exports the detector runtime types; the adversary does not duplicate that contract locally.

## Development

```sh
npm install
npm test
adversary validate .
adversary pack --check .
```

The release artifact bundles the SDK and parser runtime and ships the Tree-sitter runtime and Go grammar as two WASM assets. It does not require `node_modules` at execution time.

## Issue catalog

What this adversary targets (P0 / P1 / LLM-only priorities, detection notes, and public pattern references) is documented in [docs/issue-catalog.md](docs/issue-catalog.md).
