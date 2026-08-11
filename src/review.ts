import { type RuleContext } from "@adversarylabs/sdk";
import { runModelConcurrencyReview, type DiscoveryFile } from "./model-review.js";
import { attachImportNavigation } from "./navigation.js";
import { type Analysis, type GoVersion, type Signal } from "./types.js";

export async function reviewConcurrency(
  ctx: RuleContext,
  analysis: Analysis,
  discoveryFiles: DiscoveryFile[] = [],
): Promise<void> {
  const deadlocks = matching(analysis, "go-concurrency.channel.self-deadlock");
  const waitGroups = matching(analysis, "go-concurrency.waitgroup.lifecycle");
  const waitGroupCopied = matching(analysis, "go-concurrency.waitgroup.copied");
  const mutexCopy = matching(analysis, "go-concurrency.mutex.copy");
  const loopVars = matching(analysis, "go-concurrency.loopvar.capture");
  const cancellation = matching(analysis, "go-concurrency.context.cancellation");
  const detachedContexts = matching(analysis, "go-concurrency.context.background-in-request");
  const cancellationErrors = matching(analysis, "go-concurrency.context.error-classification");
  const selectBusy = matching(analysis, "go-concurrency.select.default-busy");
  const tickers = matching(analysis, "go-concurrency.ticker.not-stopped");
  const timers = matching(analysis, "go-concurrency.timer.not-stopped");
  const atomicCapacity = matching(analysis, "go-concurrency.atomic-capacity-check-update");
  const concurrentApiMissing = matching(analysis, "go-concurrency.concurrent-api.missing-test");

  emitGroupedFinding(ctx, deadlocks, {
    title: "A local unbuffered channel blocks before a peer can run",
    category: "correctness",
    severity: "high",
    summary: (count) => `${count} synchronous channel operation${count === 1 ? "" : "s"} cannot make progress because no sender or receiver has been started.`,
    whyItMatters: "An unbuffered channel requires a concurrent peer. Using a newly created local channel synchronously stops the goroutine at runtime.",
    impact: "The affected execution path hangs indefinitely or terminates the process with a deadlock when no other goroutine remains runnable.",
    recommendation: "Start the peer before the blocking operation, use direct value flow when concurrency is unnecessary, or introduce buffering only when its ownership and capacity are intentional.",
  });
  emitGroupedFinding(ctx, waitGroups, {
    title: "WaitGroup registration races with the wait lifecycle",
    category: "correctness",
    severity: "high",
    summary: (count) => `${count} worker registration${count === 1 ? "" : "s"} call Add from inside the goroutine being tracked.`,
    whyItMatters: "The parent can reach Wait before the worker increments the counter, allowing Wait to return early or creating invalid Add/Wait reuse.",
    impact: "Shutdown and completion code can run while workers are still active, causing data races, resource teardown, or intermittent test failures.",
    recommendation: "Call Add in the launching goroutine before each go statement, then defer Done as the first operation inside the worker.",
  });
  emitGroupedFinding(ctx, waitGroupCopied, {
    title: "WaitGroup is copied by value",
    category: "correctness",
    severity: "high",
    summary: (count) => `${count} WaitGroup value${count === 1 ? "" : "s"} are passed by value, so Add/Done/Wait no longer share one counter.`,
    whyItMatters: "sync.WaitGroup must not be copied after first use; a by-value parameter is a fresh counter that cannot observe the caller's registrations.",
    impact: "Wait can return while workers are still running, or Done can panic when the copied counter goes negative.",
    recommendation: "Pass *sync.WaitGroup (or embed WaitGroup behind a pointer receiver) so all callers share the same counter.",
  });
  emitGroupedFinding(ctx, mutexCopy, {
    title: "Mutex is copied by value",
    category: "correctness",
    severity: "critical",
    summary: (count) => `${count} mutex value cop${count === 1 ? "y" : "ies"} can unlock a different lock instance than the one that was acquired.`,
    whyItMatters: "sync.Mutex and sync.RWMutex are not safe to copy; copies have independent state and break mutual exclusion.",
    impact: "Concurrent critical sections can run without synchronization, causing data races and corrupted shared state.",
    recommendation: "Pass or store *sync.Mutex/*sync.RWMutex (or embed the mutex in a struct used only via pointer) and never assign mutex values.",
  });
  emitGroupedFinding(ctx, loopVars, {
    title: "Goroutine captures a loop variable without binding",
    category: "correctness",
    severity: "high",
    summary: (count) => `${count} goroutine${count === 1 ? "" : "s"} close over a loop variable without shadowing or parameter binding.`,
    whyItMatters: "Before Go 1.22 loop variables were shared across iterations; the classic unshadowed capture is still a portability hazard and often a real bug on older toolchains.",
    impact: "Workers may all observe the last iteration value, producing wrong results or races that only appear under load.",
    recommendation: "Shadow with `x := x` before the go statement, or pass the value as a goroutine parameter: `go func(x T) { ... }(x)`.",
  });
  emitGroupedFinding(ctx, cancellation, {
    title: "Cancellation ownership is discarded",
    category: "reliability",
    severity: "medium",
    summary: (count) => `${count} concurrency lifecycle${count === 1 ? "" : "s"} discard a cancellation handle or derived errgroup context.`,
    whyItMatters: "Cancellation functions release timer and parent-child context resources; an errgroup's derived context carries peer failure to the remaining work.",
    impact: "Work can outlive its owner, timers and context relationships remain live longer than necessary, and peer failures may not stop dependent operations.",
    recommendation: "Retain the cancellation function and invoke it on every exit path, and pass the errgroup-derived context to work launched by that group.",
  });
  emitGroupedFinding(ctx, detachedContexts, {
    title: "An operation discards its caller's context",
    category: "reliability",
    severity: "medium",
    summary: (count) => `${count} operation${count === 1 ? " replaces" : "s replace"} an available caller context with context.Background or context.TODO.`,
    whyItMatters: "The caller's context carries its cancellation and deadline. Replacing it silently detaches blocking work from request, poll, and shutdown lifecycles.",
    impact: "A slow API call can continue after its owner stops waiting, causing timeout overruns, delayed shutdown, or leaked work.",
    recommendation: "Pass the available context through, including as the parent of WithTimeout/WithCancel. If work must deliberately outlive cancellation, make that explicit with context.WithoutCancel(ctx) and add an appropriate bound.",
  });
  emitGroupedFinding(ctx, cancellationErrors, {
    title: "Context cancellation is handled as an ordinary failure",
    category: "reliability",
    severity: "medium",
    summary: (count) => `${count} context-aware operation${count === 1 ? "" : "s"} log, reject, or skip an error without first distinguishing cancellation.`,
    whyItMatters: "Cancellation is lifecycle control flow. Treating it like an ordinary item failure can swallow shutdown, emit misleading errors, or negatively acknowledge work that should simply stop.",
    impact: "Workers may continue after their owner cancels them, while shutdown produces spurious alerts, retries, or negative acknowledgements.",
    recommendation: "Before ordinary error handling, return ctx.Err() when it is non-nil or classify wrapped context.Canceled/context.DeadlineExceeded with errors.Is; preserve existing handling for errors from a live context.",
  });
  emitGroupedFinding(ctx, selectBusy, {
    title: "Select default inside a loop busy-spins",
    category: "performance",
    severity: "medium",
    summary: (count) => `${count} loop${count === 1 ? "" : "s"} use select with only a default case, spinning the CPU when no case is ready.`,
    whyItMatters: "A select with only default never blocks; nested in a for loop it becomes a tight spin.",
    impact: "A single goroutine can consume a full CPU core and starve other work until the process is stopped.",
    recommendation: "Block on a real case (channel, timer, or ctx.Done), or use a ticker/backoff instead of an empty default.",
  });
  emitGroupedFinding(ctx, tickers, {
    title: "Ticker is never stopped",
    category: "reliability",
    severity: "medium",
    summary: (count) => `${count} ticker${count === 1 ? "" : "s"} are started without Stop (or via time.Tick, which cannot be stopped).`,
    whyItMatters: "Tickers hold runtime resources until Stop; time.Tick never exposes Stop and runs for process lifetime.",
    impact: "Long-lived services accumulate timers and goroutine wakeups, increasing CPU and memory use over time.",
    recommendation: "Prefer time.NewTicker and defer ticker.Stop() when the ticker's owner exits; avoid time.Tick outside of infinite process-lifetime loops in main.",
  });
  emitGroupedFinding(ctx, timers, {
    title: "time.After is used inside a loop",
    category: "reliability",
    severity: timerSeverity(analysis.goVersion),
    summary: (count) => `${count} loop${count === 1 ? "" : "s"} call time.After each iteration, creating short-lived timers that are not explicitly stopped.`,
    whyItMatters: "Before Go 1.23, unstopped After timers could leak until they fired; on newer Go they are GC-eligible but still allocate every iteration.",
    impact: goVersionAtLeast(analysis.goVersion, 1, 23)
      ? "Each iteration allocates a timer, adding allocation and scheduling churn under tight loops."
      : "Timers can accumulate until their duration elapses, increasing memory use and timer-queue pressure.",
    recommendation: "Use time.NewTimer with Reset/Stop in the loop, or restructure to a single timer outside the loop.",
  });

  emitGroupedFinding(ctx, atomicCapacity, {
    title: "Capacity admission is split across atomic operations",
    category: "correctness",
    severity: "high",
    summary: (count) => `${count} capacity admission path${count === 1 ? "" : "s"} check an atomic counter and update it in a separate operation.`,
    whyItMatters: "Atomic loads and increments are individually safe, but another goroutine can pass the same limit check before either increment becomes visible.",
    impact: "Concurrent callers can oversubscribe the protected byte, item, or request budget even though every counter access uses atomics.",
    recommendation: "Make the limit check and reservation one operation with a CAS retry loop, or guard both with the same mutex/semaphore.",
  });

  emitGroupedFinding(ctx, concurrentApiMissing, {
    title: "Concurrent API guarantee lacks test for overlapping calls",
    category: "correctness",
    severity: "medium",
    summary: (count) => `${count} test${count === 1 ? "" : "s"} launch concurrent calls to lifecycle methods (Export/ForceFlush/Shutdown-style) without an active-call / max-concurrency assertion.`,
    whyItMatters: "Tests for APIs that must not be invoked concurrently should include a harness (active counter, blocking callback, etc.) that would fail on overlap.",
    impact: "Without an assertion that exercises the single-active guarantee, a regression removing the production guard can ship undetected.",
    recommendation: "Instrument the test double (or wrapper) with an atomic active-call counter inside the call body and assert max concurrency of one while launching the methods concurrently from the test.",
  });

  addPositives(ctx, analysis);

  const staticSeverities: Array<"none" | "low" | "medium" | "high" | "critical"> = [];
  if (deadlocks.length > 0) staticSeverities.push("high");
  if (waitGroups.length > 0) staticSeverities.push("high");
  if (waitGroupCopied.length > 0) staticSeverities.push("high");
  if (mutexCopy.length > 0) staticSeverities.push("critical");
  if (loopVars.length > 0) staticSeverities.push("high");
  if (cancellation.length > 0) staticSeverities.push("medium");
  if (detachedContexts.length > 0) staticSeverities.push("medium");
  if (cancellationErrors.length > 0) staticSeverities.push("medium");
  if (selectBusy.length > 0) staticSeverities.push("medium");
  if (tickers.length > 0) staticSeverities.push("medium");
  if (timers.length > 0) staticSeverities.push(timerSeverity(analysis.goVersion));
  if (atomicCapacity.length > 0) staticSeverities.push("high");
  if (concurrentApiMissing.length > 0) staticSeverities.push("medium");
  const staticPrimaryConcern =
    deadlocks.length > 0 ? "local channel self-deadlocks" :
    mutexCopy.length > 0 ? "copied mutex values" :
    waitGroups.length > 0 ? "WaitGroup registration races" :
    waitGroupCopied.length > 0 ? "WaitGroup value copies" :
    loopVars.length > 0 ? "loop variable captures in goroutines" :
    atomicCapacity.length > 0 ? "non-atomic capacity admission" :
    cancellation.length > 0 ? "discarded cancellation ownership" :
    detachedContexts.length > 0 ? "operations detached from caller cancellation" :
    cancellationErrors.length > 0 ? "context cancellation handled as an ordinary failure" :
    selectBusy.length > 0 ? "busy-spinning select defaults" :
    tickers.length > 0 ? "tickers without Stop" :
    timers.length > 0 ? "time.After inside loops" :
    concurrentApiMissing.length > 0 ? "missing tests for concurrent API serialization" :
    undefined;
  await attachImportNavigation(ctx, analysis);

  const modelStatus = await runModelConcurrencyReview(
    ctx,
    analysis,
    discoveryFiles,
    staticSeverities,
    staticPrimaryConcern,
  );
  if (modelStatus === "applied") {
    return;
  }
  addAssessment(ctx, {
    deadlocks,
    waitGroups,
    waitGroupCopied,
    mutexCopy,
    loopVars,
    cancellation,
    detachedContexts,
    cancellationErrors,
    selectBusy,
    tickers,
    timers,
    atomicCapacity,
    concurrentApiMissing,
    ...(analysis.goVersion === undefined ? {} : { goVersion: analysis.goVersion }),
  });
}

function matching(analysis: Analysis, ruleId: Signal["ruleId"]): Signal[] {
  return analysis.signals.filter((signal) => signal.ruleId === ruleId);
}

function timerSeverity(goVersion: GoVersion | undefined): "low" | "medium" {
  return goVersionAtLeast(goVersion, 1, 23) ? "low" : "medium";
}

function goVersionAtLeast(goVersion: GoVersion | undefined, major: number, minor: number): boolean {
  if (goVersion === undefined) return false;
  return goVersion.major > major || (goVersion.major === major && goVersion.minor >= minor);
}

function emitGroupedFinding(
  ctx: RuleContext,
  signals: Signal[],
  input: {
    title: string;
    category: string;
    severity: "low" | "medium" | "high" | "critical";
    summary: (count: number) => string;
    whyItMatters: string;
    impact: string;
    recommendation: string;
  },
): void {
  if (signals.length === 0) return;
  ctx.finding({
    ruleId: signals[0]!.ruleId,
    title: input.title,
    category: input.category,
    severity: input.severity,
    confidence: "high",
    summary: input.summary(signals.length),
    whyItMatters: input.whyItMatters,
    impact: input.impact,
    evidence: signals.slice(0, 12).map((signal) => ({
      location: {
        file: signal.path,
        line: signal.line,
        ...(signal.endLine === undefined ? {} : { endLine: signal.endLine }),
      },
      message: signal.message,
      snippet: signal.snippet,
      data: signal.data,
    })),
    recommendation: input.recommendation,
    remediation: { complexity: "small" },
  });
}

function addPositives(ctx: RuleContext, analysis: Analysis): void {
  const byKey = new Map<string, typeof analysis.positives>();
  for (const positive of analysis.positives) {
    const existing = byKey.get(positive.key) ?? [];
    existing.push(positive);
    byKey.set(positive.key, existing);
  }
  for (const [key, positives] of [...byKey].sort(([left], [right]) => left.localeCompare(right))) {
    const summary = key === "go-concurrency.waitgroup-ordered"
      ? positives.length === 1
        ? "1 WaitGroup lifecycle registers work before launch and defers completion in the worker."
        : `${positives.length} WaitGroup lifecycles register work before launch and defer completion in the worker.`
      : positives.length === 1
        ? "1 derived context lifecycle retains and invokes its cancellation function."
        : `${positives.length} derived context lifecycles retain and invoke their cancellation functions.`;
    ctx.review.positive({
      key,
      summary,
      evidence: positives.slice(0, 8).map((positive) => ({
        location: { file: positive.path, line: positive.line },
        message: positive.summary,
      })),
    });
  }
}

function addAssessment(
  ctx: RuleContext,
  groups: {
    deadlocks: Signal[];
    waitGroups: Signal[];
    waitGroupCopied: Signal[];
    mutexCopy: Signal[];
    loopVars: Signal[];
    cancellation: Signal[];
    detachedContexts: Signal[];
    cancellationErrors: Signal[];
    selectBusy: Signal[];
    tickers: Signal[];
    timers: Signal[];
    atomicCapacity: Signal[];
    concurrentApiMissing: Signal[];
    goVersion?: GoVersion;
  },
): void {
  if (groups.deadlocks.length > 0) {
    ctx.review.assessment({
      risk: "high",
      summary: "The concurrency lifecycle is not safe to approve: a locally owned unbuffered channel blocks before any peer can run.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would fix the deterministic channel deadlock before merging.",
    });
    return;
  }
  if (groups.mutexCopy.length > 0) {
    ctx.review.assessment({
      risk: "critical",
      summary: "Mutual exclusion is not reliable because a mutex value is copied, so locks no longer protect a single shared instance.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would eliminate mutex value copies before merging.",
    });
    return;
  }
  if (groups.waitGroups.length > 0) {
    ctx.review.assessment({
      risk: "high",
      summary: "Worker completion is not reliable because WaitGroup registration occurs after goroutine launch and can race with Wait.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would move worker registration into the launching goroutine before merging.",
    });
    return;
  }
  if (groups.waitGroupCopied.length > 0) {
    ctx.review.assessment({
      risk: "high",
      summary: "WaitGroup coordination is broken because the counter is copied by value instead of shared through a pointer.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would pass WaitGroup by pointer before merging.",
    });
    return;
  }
  if (groups.loopVars.length > 0) {
    ctx.review.assessment({
      risk: "high",
      summary: "Goroutines capture loop variables without per-iteration binding, which is incorrect on pre-1.22 toolchains and a portability hazard.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would bind loop variables before launching goroutines before merging.",
    });
    return;
  }
  if (groups.atomicCapacity.length > 0) {
    ctx.review.assessment({
      risk: "high",
      summary: "The capacity guard is a check-then-update sequence, so concurrent callers can both pass the limit and oversubscribe the shared budget.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would make capacity admission atomic before merging.",
    });
    return;
  }
  if (groups.cancellation.length > 0) {
    ctx.review.assessment({
      risk: "medium",
      summary: "The control flow is understandable, but cancellation ownership is incomplete and can let work or context resources outlive their intended scope.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would make cancellation ownership explicit before merging.",
    });
    return;
  }
  if (groups.detachedContexts.length > 0) {
    ctx.review.assessment({
      risk: "medium",
      summary: "An operation replaces its caller context, so it can outlive the request, poll, or shutdown lifecycle that started it.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would propagate the caller context or make deliberate detachment explicit and bounded before merging.",
    });
    return;
  }
  if (groups.cancellationErrors.length > 0) {
    ctx.review.assessment({
      risk: "medium",
      summary: "A context-aware operation handles cancellation as an ordinary failure, which can obscure or delay shutdown.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would classify and propagate context cancellation before logging, retrying, or skipping the error.",
    });
    return;
  }
  if (groups.selectBusy.length > 0) {
    ctx.review.assessment({
      risk: "medium",
      summary: "A select with only default inside a loop busy-spins and will burn CPU under load.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would replace the busy-spin select with a blocking wait before merging.",
    });
    return;
  }
  if (groups.tickers.length > 0) {
    ctx.review.assessment({
      risk: "medium",
      summary: "Tickers are started without Stop (or via time.Tick), which leaks timer resources for the process lifetime of the owner.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would stop tickers on exit paths before merging.",
    });
    return;
  }
  if (groups.timers.length > 0) {
    const severity = timerSeverity(groups.goVersion);
    ctx.review.assessment({
      risk: severity,
      summary: severity === "low"
        ? "time.After is used inside a loop; on Go 1.23+ this is mainly allocation churn rather than a hard leak."
        : "time.After is used inside a loop, which can accumulate unstopped timers until each fires.",
    });
    ctx.review.opinion({
      ship: severity === "low",
      summary: severity === "low"
        ? "I would prefer NewTimer/Reset, but this is not a merge blocker on Go 1.23+."
        : "I would replace in-loop time.After with a reusable timer before merging.",
    });
    return;
  }
  if (groups.concurrentApiMissing && groups.concurrentApiMissing.length > 0) {
    ctx.review.assessment({
      risk: "medium",
      summary: "Tests for concurrent API guarantees (Export/ForceFlush/Shutdown-style) launch overlapping calls but lack an assertion proving single-active execution.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would add active-call counter or max-concurrency assertion inside the test harness before merging.",
    });
    return;
  }
  ctx.review.assessment({
    risk: "none",
    summary: "No high-confidence concurrency lifecycle defects were found in the reviewed Go code.",
    });
  ctx.review.opinion({
    ship: true,
    summary: "I would approve the concurrency lifecycle represented by the reviewed code.",
  });
}
