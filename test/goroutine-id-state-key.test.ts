import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const ruleId = "go-concurrency.goroutine-id-state-key";

test("flags the Cortex runtime.Stack goroutine identity used for sync.Map ownership", async () => {
  const root = await repository({ "tracking.go": cortexShape("getGoroutineID") });
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);

  assert.equal(finding?.severity, "medium");
  assert.equal(finding?.confidence, "high");
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.location?.file, "tracking.go");
  assert.equal(finding?.evidence[0]?.location?.line, 16);
  assert.equal(finding?.evidence[0]?.snippet, "h.trackers.Store(getGoroutineID(), tracker)");
  assert.match(finding?.whyItMatters ?? "", /not a supported application ownership boundary/i);
  assert.match(finding?.recommendation ?? "", /request-scoped state or context/i);
  assert.doesNotMatch(finding?.summary ?? "", /reuse|race/i);
});

test("recognizes native map reads and deletes keyed by parsed goroutine identity", async () => {
  const root = await repository({
    "tracking.go": `package sample

import (
  "runtime"
  "strconv"
  "strings"
)

type holder struct { trackers map[int64]string }

func (h *holder) Get() string { return h.trackers[currentGoroutineID()] }
func (h *holder) Clear() { delete(h.trackers, currentGoroutineID()) }

func currentGoroutineID() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  return id
}
`,
  });
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.location?.line, 11);
});

test("stays quiet for diagnostics, all-stack capture, explicit request handles, and unknown containers", async () => {
  const root = await repository({
    "diagnostics.go": `package sample

import (
  "context"
  "log"
  "runtime"
  "strconv"
  "strings"
  "sync"
)

type holder struct { requests sync.Map }
type cache struct{}
func (*cache) Store(any, any) {}

func stackDiagnostic() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  log.Print(string(buf[:n]))
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  return id
}

func allStacks() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], true)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  return id
}

func (h *holder) explicit(ctx context.Context, requestID string, value any) {
  h.requests.Store(requestID, value)
  _ = ctx
}

func unknown(c *cache, value any) { c.Store(stackDiagnostic(), value) }
`,
  });
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("stays quiet in test files and for debug-only affinity assertions", async () => {
  const root = await repository({
    "tracking_test.go": cortexShape("getGoroutineID"),
    "debug.go": `package sample

import (
  "runtime"
  "strconv"
  "strings"
)

type goroutineLock int64
func currentGoroutineID() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, err := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if err != nil { panic(err) }
  return id
}
func newGoroutineLock() goroutineLock { return goroutineLock(currentGoroutineID()) }
func (g goroutineLock) check() { if int64(g) != currentGoroutineID() { panic("wrong goroutine") } }
`,
  });
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("stays quiet when goroutine identity parsing fails closed", async () => {
  const root = await repository({
    "tracking.go": cortexShape("getGoroutineID").replace(
      "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
      "id, err := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  if err != nil { panic(err) }\n  return id",
    ),
  });
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("requires changed semantic evidence and anchors a changed state-key call", async () => {
  const root = await repository({ "tracking.go": cortexShape("getGoroutineID") }, true);
  await writeFile(join(root, "tracking.go"), cortexShape("getGoroutineID").replace("package sample", "package sample\n\n// unrelated documentation"));
  let output = await changedReview(root);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  await execute("git", ["restore", "tracking.go"], { cwd: root });
  await writeFile(join(root, "tracking.go"), cortexShape("currentGoroutineID"));
  output = await changedReview(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.location?.line, 16);
  assert.equal(finding?.evidence[0]?.snippet, "h.trackers.Store(currentGoroutineID(), tracker)");
});

async function review(root: string) {
  return createApp().run({ input: { source: { path: root } } });
}

async function changedReview(root: string) {
  return createApp().run({
    input: {
      source: { path: root },
      change: {
        type: "diff",
        base_ref: "HEAD",
        head_ref: "WORKTREE",
        scan_mode: "changed",
        changed_files: ["tracking.go"],
      },
    },
  });
}

async function repository(files: Record<string, string>, commit = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-goroutine-id-"));
  if (commit) {
    await execute("git", ["init", "--quiet"], { cwd: root });
    await execute("git", ["config", "user.email", "tests@example.com"], { cwd: root });
    await execute("git", ["config", "user.name", "Tests"], { cwd: root });
  }
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  if (commit) {
    await execute("git", ["add", "."], { cwd: root });
    await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  }
  return root;
}

function cortexShape(helper: string): string {
  return `package sample

import (
  "runtime"
  "strconv"
  "strings"
  "sync"
)

type requestTracker struct{}
type requestTrackerHolder struct {
  trackers sync.Map
}

func (h *requestTrackerHolder) Set(tracker *requestTracker) {
  h.trackers.Store(${helper}(), tracker)
}
func (h *requestTrackerHolder) Get() *requestTracker {
  value, ok := h.trackers.Load(${helper}())
  if !ok { return nil }
  return value.(*requestTracker)
}
func (h *requestTrackerHolder) Clear() { h.trackers.Delete(${helper}()) }

func ${helper}() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  return id
}
`;
}
