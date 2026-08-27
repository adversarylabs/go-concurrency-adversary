import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const ruleId = "go-concurrency.rwmutex.read-lock-write";

test("reports the CoreDNS-shaped map write under an embedded RWMutex read lock", async () => {
  const output = await review(await repository({ "list.go": coreDNSReadLockSource() }));
  const finding = output.findings.find((item) => item.ruleId === ruleId);

  assert.equal(finding?.severity, "high");
  assert.equal(finding?.confidence, "high");
  assert.equal(finding?.evidence[0]?.location?.file, "list.go");
  assert.equal(finding?.evidence[0]?.location?.line, 20);
  assert.match(finding?.title ?? "", /read lock/i);
  assert.match(finding?.whyItMatters ?? "", /multiple read-lock holders/i);
  assert.match(finding?.recommendation ?? "", /Lock\/Unlock/);
});

test("stays quiet for the accepted write lock and read-only critical section", async () => {
  const output = await review(await repository({
    "accepted.go": coreDNSReadLockSource()
      .replace("l.RLock()", "l.Lock()")
      .replace("l.RUnlock()", "l.Unlock()"),
    "read.go": coreDNSReadLockSource().replace("l.rs[name] = nil", "_ = l.rs[name]"),
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("requires an exact receiver-owned map and the matching receiver lock", async () => {
  const output = await review(await repository({
    "local.go": coreDNSReadLockSource().replace(
      "l.rs[name] = nil",
      "local := map[string]Readiness{}\n\tlocal[name] = nil",
    ),
    "other.go": `package ready

import "sync"

type list struct { mu sync.RWMutex; other sync.RWMutex; rs map[string]int }
func (l *list) Ready(name string) {
  l.other.RLock()
  defer l.other.RUnlock()
  l.rs[name] = 1
}
`,
    "dead.go": coreDNSReadLockSource().replace(
      "l.rs[name] = nil",
      "if false { l.rs[name] = nil }",
    ),
    "conditional.go": coreDNSReadLockSource().replace(
      "l.RLock()",
      "if enabled() { l.RLock() }",
    ).replace("type Readiness interface", "func enabled() bool { return false }\n\ntype Readiness interface"),
    "unreachable.go": coreDNSReadLockSource().replace(
      "l.rs[name] = nil",
      "return false, \"stopped\"\n\t\tl.rs[name] = nil",
    ),
    "shadow_delete.go": `package ready

import "sync"

type shadow struct { sync.RWMutex; values map[string]int }
func (s *shadow) Remove(key string) {
  s.RLock()
  defer s.RUnlock()
  delete := func(map[string]int, string) {}
  delete(s.values, key)
}
`,
    "shadow_lock.go": `package ready

import "sync"

type customLock struct { sync.RWMutex; values map[string]int }
func (*customLock) RLock() {}
func (*customLock) RUnlock() {}
func (s *customLock) Update(key string) {
  s.RLock()
  defer s.RUnlock()
  s.values[key] = 1
}
`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("covers named RWMutex fields and delete while ignoring writes after RUnlock", async () => {
  const output = await review(await repository({
    "delete.go": `package cache

import "sync"

type cache struct { mu sync.RWMutex; values map[string]int }
func (c *cache) Remove(key string) {
  c.mu.RLock()
  defer c.mu.RUnlock()
  delete(c.values, key)
}
`,
    "after.go": `package cache

import "sync"

type after struct { mu sync.RWMutex; values map[string]int }
func (c *after) Remove(key string) {
  c.mu.RLock()
  c.mu.RUnlock()
  delete(c.values, key)
}
`,
  }));
  const findings = output.findings.filter((item) => item.ruleId === ruleId);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence[0]?.location?.file, "delete.go");
});

test("diff locality reports the changed unsafe relationship and ignores legacy or comment-only writes", async () => {
  const root = await repository({ "list.go": coreDNSSliceSource() }, true);
  await writeFile(join(root, "list.go"), coreDNSReadLockSource());
  const introduced = await changedReview(root);
  const finding = introduced.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.location?.line, 20);

  await execute("git", ["add", "list.go"], { cwd: root });
  await execute("git", ["commit", "--quiet", "-m", "introduce fixture"], { cwd: root });
  await writeFile(join(root, "list.go"), coreDNSReadLockSource()
    .replace("package ready", "package ready\n\nvar unrelated = 1")
    .replace("l.rs[name] = nil", "l.rs[name] /* readiness is consumed */ = nil"));
  const unrelated = await changedReview(root);
  assert.equal(unrelated.findings.some((item) => item.ruleId === ruleId), false);
});

test("test files stay quiet", async () => {
  const output = await review(await repository({ "list_test.go": coreDNSReadLockSource() }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
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
        changed_files: ["list.go"],
      },
    },
  });
}

async function repository(files: Record<string, string>, commit = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-rlock-write-"));
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

function coreDNSReadLockSource(): string {
  return `package ready

import "sync"

type Readiness interface { Ready() bool }
type list struct {
  sync.RWMutex
  rs map[string]Readiness
  keepReadiness bool
}

func (l *list) Ready() (bool, string) {
  l.RLock()
  defer l.RUnlock()
  ok := true
  for name, r := range l.rs {
    if r == nil { continue }
    if r.Ready() {
      if !l.keepReadiness {
        l.rs[name] = nil
      }
      continue
    }
    ok = false
  }
  if ok { return true, "" }
  return false, "not ready"
}
`;
}

function coreDNSSliceSource(): string {
  return coreDNSReadLockSource()
    .replace("rs map[string]Readiness", "rs []Readiness")
    .replace("for name, r := range l.rs", "for i, r := range l.rs")
    .replace("l.rs[name] = nil", "l.rs[i] = nil");
}
