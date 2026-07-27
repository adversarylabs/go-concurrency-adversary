# AGENTS.md

## Purpose

This repository contains the Go Concurrency adversary. It reviews Go code for concurrency lifecycle, cancellation, synchronization, and channel-ownership defects that an experienced Go engineer would block.

## Design principles

- Consume prepared runtime evidence; do not add new repository walking, Git, file-reading, or parser responsibilities.
- Treat the current discovery and parser implementation as transitional architecture to be removed when ReviewContext capabilities exist.
- Deterministic analysis should prepare facts; the adversary should apply concurrency judgment.
- Prefer a few high-confidence, operationally meaningful findings over broad advice.
- Group evidence that has one remediation.
- Point every finding to concrete source evidence.
- Account for Go version semantics before codifying language behavior.
- Never execute or modify the scanned repository.
- The benchmark corpus is calibration metadata only; never vendor code from it.

## Testing

- Add a focused regression fixture for every signal.
- Preserve the five graded fixture tiers and their expected review snapshots.
- Include clean counterexamples for every rule.
- Run `npm test`, `adversary validate .`, and `adversary pack --check .`.
