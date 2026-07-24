import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
    const root = join(projectRoot, "fixtures", grade);
    const expected = JSON.parse(await readFile(join(root, "expected.review.json"), "utf8"));
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

test("only reports evidence on changed lines in diff mode", async () => {
  const root = await repository(`package sample
import "context"
func old(parent context.Context) context.Context {
  ctx, _ := context.WithCancel(parent)
  return ctx
}
`);
  await execute("git", ["init", "-q"], { cwd: root });
  await execute("git", ["config", "user.email", "concurrency@example.test"], { cwd: root });
  await execute("git", ["config", "user.name", "Concurrency Tests"], { cwd: root });
  await execute("git", ["add", "."], { cwd: root });
  await execute("git", ["commit", "-qm", "baseline"], { cwd: root });
  await writeFile(join(root, "new.go"), "package sample\n\nconst Added = true\n");
  await execute("git", ["add", "new.go"], { cwd: root });
  const output = await review(root);
  assert.deepEqual(output.findings, []);
});

test("review output is deterministic", async () => {
  const root = join(projectRoot, "fixtures", "terrible");
  assert.deepEqual(await review(root), await review(root));
});

async function repository(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "main.go"), source);
  return root;
}
