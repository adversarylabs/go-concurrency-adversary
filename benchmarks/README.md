# Calibration corpus

`corpus.json` is a curated index of mature Go repositories with substantial concurrency behavior. It spans standard-library code, orchestration systems, network services, storage systems, CLIs, telemetry, and focused concurrency libraries.

The corpus is metadata only. Source code is not copied into this repository.

Calibration runs should:

1. Pin the upstream revision used for a run.
2. Sample both known concurrency-heavy paths and ordinary Go files.
3. Record true positives, false positives, and noisy-but-correct observations.
4. Require a regression fixture before changing a rule.
5. Prefer reducing false positives over expanding rule coverage.

The initial acceptance target is zero false positives for high-confidence findings in a manually reviewed sample of at least 20 repositories. Network access, cloning, and model use are never part of the adversary runtime.

