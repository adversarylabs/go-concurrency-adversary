import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { type ReviewResult } from "@adversarylabs/sdk";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function review(root: string): Promise<ReviewResult> {
  return createApp().run({ input: { source: { path: root } }, includeRawObservations: true });
}

function snapshot(output: ReviewResult) {
  return {
    assessment: output.assessment,
    findings: output.findings.map((finding) => ({
      ruleId: finding.ruleId,
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence,
      evidence: finding.evidence.map((evidence) => ({
        file: evidence.location?.file,
        line: evidence.location?.line,
        message: evidence.message,
      })),
      recommendation: finding.recommendation,
    })),
    positives: output.positives,
    opinion: output.opinion,
  };
}

for (const grade of ["excellent", "good", "average", "poor", "terrible"]) {
  test(`${grade} fixture matches its expected review snapshot`, async () => {
    const fixture = join(projectRoot, "fixtures", grade);
    const root = await isolatedFixture(fixture);
    const expected = JSON.parse(await readFile(join(fixture, "expected.review.json"), "utf8"));
    assert.deepEqual(snapshot(await review(root)), expected);
  });
}

test("groups multiple WaitGroup lifecycle violations into one remediation", async () => {
  const root = await repository(`package sample
import "sync"
func run() {
  var first sync.WaitGroup
  go func() { first.Add(1); defer first.Done() }()
  first.Wait()
  var second sync.WaitGroup
  go func() { second.Add(1); defer second.Done() }()
  second.Wait()
}
`);
  const output = await review(root);
  const findings = output.findings.filter((finding) => finding.ruleId === "go-concurrency.waitgroup.lifecycle");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence.length, 2);
  assert.match(findings[0]?.recommendation ?? "", /before each go statement/i);
});

test("supports aliased standard-library imports", async () => {
  const root = await repository(`package sample
import cx "context"
func run(parent cx.Context) cx.Context {
  ctx, _ := cx.WithCancel(parent)
  return ctx
}
`);
  const output = await review(root);
  assert.ok(output.findings.some((finding) => finding.ruleId === "go-concurrency.context.cancellation"));
});

test("flags replacing an available context with Background or TODO", async () => {
  const root = await repository(`package sample
import (
  cx "context"
  "time"
)
func request(ctx cx.Context) {
  detached, cancel := cx.WithTimeout(cx.Background(), time.Second)
  defer cancel()
  fetch(detached)
}
func poll(fn func(func(cx.Context) error)) {
  fn(func(iteration cx.Context) error {
    return fetch(cx.TODO())
  })
}
func fetch(cx.Context) error { return nil }
`);
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === "go-concurrency.context.background-in-request");
  assert.equal(finding?.evidence.length, 2);
  assert.match(finding?.recommendation ?? "", /WithoutCancel/);
});

test("allows propagation and explicit context detachment", async () => {
  const root = await repository(`package sample
import (
  "context"
  "time"
)
func propagated(ctx context.Context) error {
  return fetch(ctx)
}
func deliberate(ctx context.Context) error {
  detached := context.WithoutCancel(ctx)
  bounded, cancel := context.WithTimeout(detached, time.Second)
  defer cancel()
  return fetch(bounded)
}
func root() error { return fetch(context.Background()) }
func fetch(context.Context) error { return nil }
`);
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === "go-concurrency.context.background-in-request"), false);
});

test("flags ordinary error handling that can swallow context cancellation", async () => {
  const root = await repository(`package sample
import (
  "context"
  "log"
)
func consume(ctx context.Context, items []string) error {
  for _, item := range items {
    value, err := fetch(ctx, item)
    if err != nil {
      log.Printf("fetch failed: %v", err)
      continue
    }
    _ = value
  }
  return nil
}
func fetch(context.Context, string) (string, error) { return "", nil }
`);
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === "go-concurrency.context.error-classification");
  assert.equal(finding?.evidence.length, 1);
  assert.match(finding?.evidence[0]?.message ?? "", /without distinguishing context cancellation/i);
  assert.match(finding?.recommendation ?? "", /ctx\.Err\(\)|errors\.Is/i);
});

test("does not flag context-aware errors after cancellation is classified", async () => {
  const root = await repository(`package sample
import (
  "context"
  "errors"
  "log"
)
func byContextState(ctx context.Context) error {
  err := handle(ctx)
  if err != nil {
    if ctxErr := ctx.Err(); ctxErr != nil {
      return ctxErr
    }
    log.Printf("handler failed: %v", err)
  }
  return nil
}
func byWrappedError(ctx context.Context) error {
  err := handle(ctx)
  if err != nil {
    if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
      return err
    }
    log.Printf("handler failed: %v", err)
  }
  return nil
}
func handle(context.Context) error { return nil }
`);
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === "go-concurrency.context.error-classification"), false);
});

test("does not flag direct propagation or errors from calls without context", async () => {
  const root = await repository(`package sample
import (
  "context"
  "log"
)
func direct(ctx context.Context) error {
  err := handle(ctx)
  if err != nil {
    return err
  }
  return nil
}
func unrelated(ctx context.Context) error {
  err := handleWithoutContext()
  if err != nil {
    log.Printf("handler failed: %v", err)
  }
  return ctx.Err()
}
func handle(context.Context) error { return nil }
func handleWithoutContext() error { return nil }
`);
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === "go-concurrency.context.error-classification"), false);
});

test("does not mistake a buffered channel or a started peer for a self-deadlock", async () => {
  const root = await repository(`package sample
func buffered() int {
  values := make(chan int, 1)
  values <- 1
  return <-values
}
func peer() int {
  values := make(chan int)
  go func() { values <- 1 }()
  return <-values
}
`);
  const output = await review(root);
  assert.equal(output.findings.some((finding) => finding.ruleId === "go-concurrency.channel.self-deadlock"), false);
});

test("does not treat a receive inside a callback as synchronous local use", async () => {
  const root = await repository(`package sample
type server struct { serve func() error }
func configured() server {
  stopped := make(chan struct{})
  return server{serve: func() error { <-stopped; return nil }}
}
`);
  const output = await review(root);
  assert.equal(output.findings.some((finding) => finding.ruleId === "go-concurrency.channel.self-deadlock"), false);
});

test("only reviews CLI-scoped changed files in diff mode", async () => {
  const root = await repository(`package sample
import "context"
func old(parent context.Context) context.Context {
  ctx, _ := context.WithCancel(parent)
  return ctx
}
`);
  await writeFile(join(root, "new.go"), "package sample\n\nconst Added = true\n");
  // Platform owns scope: when the CLI only lists new.go, baseline issues stay out of review.
  const output = await createApp().run({
    input: {
      source: { path: root },
      change: {
        type: "diff",
        base_ref: "HEAD",
        head_ref: "WORKTREE",
        scan_mode: "changed",
        changed_files: ["new.go"],
      },
    },
    includeRawObservations: true,
  });
  assert.deepEqual(output.findings, []);
});

test("review output is deterministic", async () => {
  const root = await isolatedFixture(join(projectRoot, "fixtures", "terrible"));
  assert.deepEqual(await review(root), await review(root));
});

async function repository(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "main.go"), source);
  return root;
}

async function isolatedFixture(fixture: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-fixture-"));
  await cp(fixture, root, { recursive: true });
  return root;
}
