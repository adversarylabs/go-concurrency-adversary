import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const ruleId = "go-concurrency.async-listener.missing-close";

test("flags the containerd-shaped async listener wrapper without shutdown ownership", async () => {
  const output = await review(await repository(vulnerableProject()));
  const finding = output.findings.find((item) => item.ruleId === ruleId);

  assert.equal(finding?.severity, "high");
  assert.equal(finding?.confidence, "high");
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.location?.file, "plugins/server/debug/plugin.go");
  assert.match(finding?.title ?? "", /async listener/i);
  assert.match(finding?.whyItMatters ?? "", /serv|listener/i);
  assert.match(finding?.recommendation ?? "", /Close or Shutdown/i);
});

test("stays quiet when the owner closes the HTTP server", async () => {
  const files = vulnerableProject();
  files["plugins/server/debug/plugin.go"] += `
func (s server) Close() error {
  return s.handler.Close()
}
`;
  const output = await review(await repository(files));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("accepts an exact field-bound Close method in another owner file", async () => {
  const files = vulnerableProject();
  files["plugins/server/debug/close.go"] = `package debug

func (s server) Close() error { return s.handler.Close() }
`;
  const output = await review(await repository(files));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("does not accept unrelated or uninvoked shutdown-looking calls", async () => {
  const unrelated = vulnerableProject();
  unrelated["plugins/server/debug/plugin.go"] += `
type metricsSink struct{}
func (*metricsSink) Close() error { return nil }
func (s server) CloseMetrics(metrics *metricsSink) error { return metrics.Close() }
`;
  const stored = vulnerableProject();
  stored["plugins/server/debug/plugin.go"] += `
func (s server) CloseLater() error {
  cleanup := func() { _ = s.handler.Close() }
  _ = cleanup
  return nil
}
`;
  for (const files of [unrelated, stored]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
  }
});

test("requires the imported helper to resolve to the proven package", async () => {
  const files = vulnerableProject();
  files["plugins/server/debug/plugin.go"] = files["plugins/server/debug/plugin.go"]!
    .replace('"example.com/project/plugins/server/internal"', 'internal "example.com/project/other/internal"');
  const output = await review(await repository(files));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("accepts an explicit listener stop path and a one-step server alias", async () => {
  const direct = vulnerableProject();
  direct["plugins/server/internal/serve.go"] = direct["plugins/server/internal/serve.go"]!.replace(
    "  _ = ctx",
    "  go func() { <-ctx.Done(); _ = listener.Close() }()",
  );
  const alias = vulnerableProject();
  alias["plugins/server/debug/plugin.go"] += `
func (s server) Shutdown() error {
  owned := s.handler
  return owned.Close()
}
`;
  for (const [label, files] of [["direct", direct], ["alias", alias]] as const) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, label);
  }
});

test("requires a proven asynchronous local helper and a real net/http.Server owner", async () => {
  const synchronous = vulnerableProject();
  synchronous["plugins/server/internal/serve.go"] = synchronous["plugins/server/internal/serve.go"]!
    .replace("  go func() {", "  func() {");

  const fake = vulnerableProject();
  fake["plugins/server/debug/plugin.go"] = fake["plugins/server/debug/plugin.go"]!
    .replace("handler *http.Server", "handler *fakeServer");
  fake["plugins/server/debug/plugin.go"] += `
type fakeServer struct{}
func (*fakeServer) Serve(net.Listener) error { return nil }
`;

  const unrelatedDone = vulnerableProject();
  unrelatedDone["plugins/server/internal/serve.go"] = unrelatedDone["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  <-ctx.Done()");

  for (const files of [synchronous, fake]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
  }
  const stillUnsafe = await review(await repository(unrelatedDone));
  assert.equal(stillUnsafe.findings.some((item) => item.ruleId === ruleId), true);
});

test("stays quiet for a process-lifetime main package server", async () => {
  const files = vulnerableProject();
  files["plugins/server/debug/plugin.go"] = files["plugins/server/debug/plugin.go"]!
    .replace("package debug", "package main");
  const output = await review(await repository(files));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("diff locality follows the semantic relationship and ignores comment-only edits", async () => {
  const safe = vulnerableProject();
  safe["plugins/server/debug/plugin.go"] += `
func (s server) Close() error { return s.handler.Close() }
`;
  const root = await repository(safe, true);
  await writeFile(
    join(root, "plugins/server/debug/plugin.go"),
    safe["plugins/server/debug/plugin.go"]!.replace(
      "func (s server) Close() error { return s.handler.Close() }",
      "func (s server) Close() error { return nil }",
    ),
  );
  const introduced = await changedReview(root, [
    "plugins/server/debug/plugin.go",
    "plugins/server/internal/serve.go",
  ]);
  const finding = introduced.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.location?.file, "plugins/server/debug/plugin.go");
  assert.match(finding?.evidence[0]?.snippet ?? "", /func \(s server\) Close/);

  const commentRoot = await repository(vulnerableProject(), true);
  await writeFile(
    join(commentRoot, "plugins/server/debug/plugin.go"),
    vulnerableProject()["plugins/server/debug/plugin.go"]!
      .replace("type server struct {", "// owner documentation\ntype server struct {")
      .replace("package debug", "package debug\n\nvar unrelated = 1"),
  );
  const commentOnly = await changedReview(commentRoot, [
    "plugins/server/debug/plugin.go",
    "plugins/server/internal/serve.go",
  ]);
  assert.equal(commentOnly.findings.some((item) => item.ruleId === ruleId), false);
});

test("a changed helper that introduces the goroutine is eligible evidence", async () => {
  const safe = vulnerableProject();
  safe["plugins/server/internal/serve.go"] = safe["plugins/server/internal/serve.go"]!
    .replace("  go func() {", "  func() {");
  const root = await repository(safe, true);
  await writeFile(
    join(root, "plugins/server/internal/serve.go"),
    vulnerableProject()["plugins/server/internal/serve.go"]!,
  );
  await writeFile(
    join(root, "plugins/server/debug/plugin.go"),
    safe["plugins/server/debug/plugin.go"]!.replace("package debug", "package debug\n\nvar relationshipChanged = true"),
  );
  const output = await changedReview(root, [
    "plugins/server/internal/serve.go",
    "plugins/server/debug/plugin.go",
  ]);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.location?.file, "plugins/server/internal/serve.go");
  assert.match(finding?.evidence[0]?.snippet ?? "", /go func/);
});

async function review(root: string) {
  return createApp().run({ input: { source: { path: root } } });
}

async function changedReview(root: string, changedFiles: string[]) {
  return createApp().run({
    input: {
      source: { path: root },
      change: {
        type: "diff",
        base_ref: "HEAD",
        head_ref: "WORKTREE",
        scan_mode: "changed",
        changed_files: changedFiles,
      },
    },
  });
}

async function repository(files: Record<string, string>, commit = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-async-listener-"));
  if (commit) {
    await execute("git", ["init", "--quiet"], { cwd: root });
    await execute("git", ["config", "user.email", "tests@example.com"], { cwd: root });
    await execute("git", ["config", "user.name", "Tests"], { cwd: root });
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  if (commit) {
    await execute("git", ["add", "."], { cwd: root });
    await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  }
  return root;
}

function vulnerableProject(): Record<string, string> {
  return {
    "plugins/server/internal/serve.go": `package internal

import (
  "context"
  "net"
)

func Serve(ctx context.Context, listener net.Listener, serve func(net.Listener) error) {
  _ = ctx
  go func() {
    defer listener.Close()
    _ = serve(listener)
  }()
}
`,
    "plugins/server/debug/plugin.go": `package debug

import (
  "context"
  "net"
  "net/http"

  "example.com/project/plugins/server/internal"
)

type server struct {
  handler *http.Server
}

func (s server) Start(ctx context.Context) error {
  listener, err := net.Listen("tcp", ":0")
  if err != nil { return err }
  internal.Serve(ctx, listener, s.handler.Serve)
  return nil
}
`,
  };
}
