import { type RuleContext } from "@adversarylabs/sdk";
import { runModelConcurrencyReview, type DiscoveryFile } from "./model-review.js";
import { type Analysis, type Signal } from "./types.js";

export async function reviewConcurrency(
  ctx: RuleContext,
  analysis: Analysis,
  discoveryFiles: DiscoveryFile[] = [],
): Promise<void> {
  const deadlocks = matching(analysis, "go-concurrency.channel.self-deadlock");
  const waitGroups = matching(analysis, "go-concurrency.waitgroup.lifecycle");
  const cancellation = matching(analysis, "go-concurrency.context.cancellation");

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
  emitGroupedFinding(ctx, cancellation, {
    title: "Cancellation ownership is discarded",
    category: "reliability",
    severity: "medium",
    summary: (count) => `${count} concurrency lifecycle${count === 1 ? "" : "s"} discard a cancellation handle or derived errgroup context.`,
    whyItMatters: "Cancellation functions release timer and parent-child context resources; an errgroup's derived context carries peer failure to the remaining work.",
    impact: "Work can outlive its owner, timers and context relationships remain live longer than necessary, and peer failures may not stop dependent operations.",
    recommendation: "Retain the cancellation function and invoke it on every exit path, and pass the errgroup-derived context to work launched by that group.",
  });

  addPositives(ctx, analysis);

  const staticSeverities: Array<"none" | "low" | "medium" | "high" | "critical"> = [];
  if (deadlocks.length > 0) staticSeverities.push("high");
  if (waitGroups.length > 0) staticSeverities.push("high");
  if (cancellation.length > 0) staticSeverities.push("medium");
  const staticPrimaryConcern =
    deadlocks.length > 0 ? "local channel self-deadlocks" :
    waitGroups.length > 0 ? "WaitGroup registration races" :
    cancellation.length > 0 ? "discarded cancellation ownership" :
    undefined;
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
  addAssessment(ctx, { deadlocks, waitGroups, cancellation });
}

function matching(analysis: Analysis, ruleId: Signal["ruleId"]): Signal[] {
  return analysis.signals.filter((signal) => signal.ruleId === ruleId);
}

function emitGroupedFinding(
  ctx: RuleContext,
  signals: Signal[],
  input: {
    title: string;
    category: string;
    severity: "medium" | "high";
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
  groups: { deadlocks: Signal[]; waitGroups: Signal[]; cancellation: Signal[] },
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
  ctx.review.assessment({
    risk: "none",
    summary: "No high-confidence concurrency lifecycle defects were found in the reviewed Go code.",
  });
  ctx.review.opinion({
    ship: true,
    summary: "I would approve the concurrency lifecycle represented by the reviewed code.",
  });
}
