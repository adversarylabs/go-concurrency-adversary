import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const ruleId = "go-concurrency.external-state-marker-before-success";

test("flags the OVN failure-fallthrough state marker that suppresses retries", async () => {
  const output = await review(await repository({ "manager.go": vulnerableSource() }));
  const finding = output.findings.find((item) => item.ruleId === ruleId);

  assert.equal(finding?.severity, "high");
  assert.equal(finding?.confidence, "high");
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.location?.file, "manager.go");
  assert.equal(finding?.evidence[0]?.location?.line, 23);
  assert.match(finding?.title ?? "", /failed external work/i);
  assert.match(finding?.whyItMatters ?? "", /already-done check/i);
  assert.match(finding?.recommendation ?? "", /only after success/i);
});

test("stays quiet when failure returns before the marker or the marker is success-only", async () => {
  const output = await review(await repository({
    "return.go": vulnerableSource().replace(
      "retErr = fmt.Errorf(\"failed: %w\", err)",
      "return fmt.Errorf(\"failed: %w\", err)",
    ),
    "success.go": `package sample

type client struct{}
func (*client) Create(string) error { return nil }
type controller struct { created map[string]bool; cloud *client }
func (c *controller) Ensure(name string) error {
  if _, ok := c.created[name]; !ok {
    if err := c.cloud.Create(name); err != nil { return err }
    c.created[name] = true
  }
  return nil
}
`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("requires the exact lookup/write relationship and an external-looking mutation", async () => {
  const output = await review(await repository({
    "different.go": vulnerableSource().replace(
      "rm.rules[rule] = ruleState{metadata: metadata, delete: false}",
      "rm.attempts[rule]++",
    ),
    "local.go": vulnerableSource().replace("netlink.RuleAdd(rule)", "rm.lookup(rule)"),
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("diff locality reports a changed failure fallthrough and ignores comments or unrelated edits", async () => {
  const safe = vulnerableSource().replace(
    "retErr = fmt.Errorf(\"failed: %w\", err)",
    "return fmt.Errorf(\"failed: %w\", err)",
  );
  const root = await repository({ "manager.go": safe }, true);
  await writeFile(join(root, "manager.go"), vulnerableSource());
  const introduced = await changedReview(root);
  const finding = introduced.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.location?.line, 20);

  await execute("git", ["restore", "manager.go"], { cwd: root });
  await writeFile(join(root, "manager.go"), safe
    .replace("package sample", "package sample\n\nvar unrelated = 1")
    .replace("rm.rules[rule] =", "rm.rules[rule] /* managed state */ ="));
  const unrelated = await changedReview(root);
  assert.equal(unrelated.findings.some((item) => item.ruleId === ruleId), false);
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
        changed_files: ["manager.go"],
      },
    },
  });
}

async function repository(files: Record<string, string>, commit = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-state-marker-"));
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

function vulnerableSource(): string {
  return `package sample

import "fmt"

var netlink = struct{ RuleAdd func(string) error }{
  RuleAdd: func(string) error { return nil },
}

type ruleState struct { metadata string; delete bool }
type controller struct {
  rules map[string]ruleState
  attempts map[string]int
}
func (*controller) lookup(string) error { return nil }

func (rm *controller) AddWithMetadata(rule, metadata string) error {
  var retErr error
  if _, ok := rm.rules[rule]; !ok {
    if err := netlink.RuleAdd(rule); err != nil {
      retErr = fmt.Errorf("failed: %w", err)
    }
  }
  rm.rules[rule] = ruleState{metadata: metadata, delete: false}
  return retErr
}
`;
}
