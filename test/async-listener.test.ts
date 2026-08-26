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

test("binds the owned listener and Serve callback to the helper's exact parameter positions", async () => {
  const files = vulnerableProject();
files["plugins/server/internal/serve.go"] = `package internal

import "net"

func Serve(actual net.Listener, actualServe func(net.Listener) error, decoy net.Listener, decoyServe func(net.Listener) error) {
  go func() {
    defer actual.Close()
    _ = actualServe(actual)
  }()
}
`;
  files["plugins/server/debug/plugin.go"] = files["plugins/server/debug/plugin.go"]!
    .replace(
      "listener, err := net.Listen(\"tcp\", \":0\")",
      `actual, err := net.Listen("tcp", ":0")
  if err != nil { return err }
  listener, err := net.Listen("tcp", ":0")`,
    )
    .replace(
      "internal.Serve(ctx, listener, s.handler.Serve)",
      "internal.Serve(actual, func(net.Listener) error { return nil }, listener, s.handler.Serve)",
    );
  const output = await review(await repository(files));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("requires an unshadowed standard net.Listen creation", async () => {
  const typedNil = vulnerableProject();
  typedNil["plugins/server/debug/plugin.go"] = typedNil["plugins/server/debug/plugin.go"]!
    .replace(
      `listener, err := net.Listen("tcp", ":0")
  if err != nil { return err }`,
      "var listener net.Listener",
    );
  const shadowed = vulnerableProject();
  shadowed["plugins/server/debug/plugin.go"] = shadowed["plugins/server/debug/plugin.go"]!
    .replace(
      "listener, err := net.Listen(\"tcp\", \":0\")",
      "net := fakeNet{}\n  listener, err := net.Listen(\"tcp\", \":0\")",
    ) + `
type fakeNet struct{}
func (fakeNet) Listen(string, string) (net.Listener, error) { return nil, nil }
`;
  for (const files of [typedNil, shadowed]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
  }
});

test("requires reachable callback, cleanup, and exact owner bindings", async () => {
  const deadCallback = vulnerableProject();
  deadCallback["plugins/server/internal/serve.go"] = deadCallback["plugins/server/internal/serve.go"]!
    .replace("    _ = serve(listener)", "    if false { _ = serve(listener) }");
  const deadHelperStop = vulnerableProject();
  deadHelperStop["plugins/server/internal/serve.go"] = deadHelperStop["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  if false { _ = listener.Close() }");
  const reassignedAlias = vulnerableProject();
  reassignedAlias["plugins/server/debug/plugin.go"] += `
func (s server) Close(other *http.Server) error {
  owned := s.handler
  owned = other
  return owned.Close()
}
`;
  const shadowedReceiver = vulnerableProject();
  shadowedReceiver["plugins/server/debug/plugin.go"] = shadowedReceiver["plugins/server/debug/plugin.go"]!
    .replace(
      "listener, err := net.Listen(\"tcp\", \":0\")",
      "s := server{handler: &http.Server{}}\n  listener, err := net.Listen(\"tcp\", \":0\")",
    );

  assert.equal((await review(await repository(deadCallback))).findings.some((item) => item.ruleId === ruleId), false);
  for (const files of [deadHelperStop, reassignedAlias]) {
    assert.equal((await review(await repository(files))).findings.some((item) => item.ruleId === ruleId), true);
  }
  assert.equal((await review(await repository(shadowedReceiver))).findings.some((item) => item.ruleId === ruleId), false);
});

test("rejects helper parameters reassigned before the asynchronous call", async () => {
  const listenerReassigned = vulnerableProject();
  listenerReassigned["plugins/server/internal/serve.go"] = listenerReassigned["plugins/server/internal/serve.go"]!
    .replace("  go func() {", "  listener = nil\n  go func() {");
  const callbackReassigned = vulnerableProject();
  callbackReassigned["plugins/server/internal/serve.go"] = callbackReassigned["plugins/server/internal/serve.go"]!
    .replace("  go func() {", "  serve = func(net.Listener) error { return nil }\n  go func() {");

  for (const files of [listenerReassigned, callbackReassigned]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
  }
});

test("requires reachable calls and unshadowed helper bindings", async () => {
  const deadHelperCall = vulnerableProject();
  deadHelperCall["plugins/server/debug/plugin.go"] = deadHelperCall["plugins/server/debug/plugin.go"]!
    .replace(
      "internal.Serve(ctx, listener, s.handler.Serve)",
      "if false { internal.Serve(ctx, listener, s.handler.Serve) }",
    );
  const reassignedListener = vulnerableProject();
  reassignedListener["plugins/server/debug/plugin.go"] = reassignedListener["plugins/server/debug/plugin.go"]!
    .replace(
      "internal.Serve(ctx, listener, s.handler.Serve)",
      "listener = nil\n  internal.Serve(ctx, listener, s.handler.Serve)",
    );
  const shadowedHelper = vulnerableProject();
  shadowedHelper["plugins/server/debug/plugin.go"] = shadowedHelper["plugins/server/debug/plugin.go"]!
    .replace(
      "internal.Serve(ctx, listener, s.handler.Serve)",
      "internal := fakeInternal{}\n  internal.Serve(ctx, listener, s.handler.Serve)",
    ) + `
type fakeInternal struct{}
func (fakeInternal) Serve(context.Context, net.Listener, func(net.Listener) error) {}
`;

  for (const files of [deadHelperCall, reassignedListener, shadowedHelper]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
  }
});

test("fails closed for a cross-package helper when module identity is unavailable", async () => {
  const files = vulnerableProject();
  delete files["go.mod"];
  const output = await review(await repository(files));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("keeps listener, receiver, callback, range, and goroutine bindings lexical", async () => {
  const innerListener = vulnerableProject();
  innerListener["plugins/server/debug/plugin.go"] = innerListener["plugins/server/debug/plugin.go"]!
    .replace(
      `listener, err := net.Listen("tcp", ":0")
  if err != nil { return err }`,
      `var listener net.Listener
  if enabled() {
    listener, err := net.Listen("tcp", ":0")
    if err != nil { return err }
    _ = listener
  }`,
    );
  const reassignedReceiver = vulnerableProject();
  reassignedReceiver["plugins/server/debug/plugin.go"] = reassignedReceiver["plugins/server/debug/plugin.go"]!
    .replace("  listener, err :=", "  s = other\n  listener, err :=") + "\nvar other server\n";
  const conditionallyReassignedReceiver = vulnerableProject();
  conditionallyReassignedReceiver["plugins/server/debug/plugin.go"] =
    conditionallyReassignedReceiver["plugins/server/debug/plugin.go"]!
      .replace("  listener, err :=", "  if enabled() { s = other }\n  listener, err :=") + "\nvar other server\n";
  const literalParameters = vulnerableProject();
  literalParameters["plugins/server/internal/serve.go"] = `package internal

import (
  "context"
  "net"
)

func Serve(ctx context.Context, listener net.Listener, serve func(net.Listener) error) {
  _ = ctx
  go func(listener net.Listener, serve func(net.Listener) error) {
    defer listener.Close()
    _ = serve(listener)
  }(nil, func(net.Listener) error { return nil })
}
`;
  const reassignedCallback = vulnerableProject();
  reassignedCallback["plugins/server/internal/serve.go"] = reassignedCallback["plugins/server/internal/serve.go"]!
    .replace("    defer listener.Close()", "    serve = func(net.Listener) error { return nil }\n    defer listener.Close()");
  const conditionallyReassignedCallback = vulnerableProject();
  conditionallyReassignedCallback["plugins/server/internal/serve.go"] =
    conditionallyReassignedCallback["plugins/server/internal/serve.go"]!
      .replace("    defer listener.Close()",
        "    if enabled() { serve = func(net.Listener) error { return nil } }\n    defer listener.Close()");
  const panicBeforeLaunch = vulnerableProject();
  panicBeforeLaunch["plugins/server/internal/serve.go"] = panicBeforeLaunch["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  panic(\"stop\")");
  const rangeShadow = vulnerableProject();
  rangeShadow["plugins/server/debug/plugin.go"] = rangeShadow["plugins/server/debug/plugin.go"]!
    .replace(
      "internal.Serve(ctx, listener, s.handler.Serve)",
      "for _, listener := range []net.Listener{nil} {\n    internal.Serve(ctx, listener, s.handler.Serve)\n  }",
    );

  for (const files of [innerListener, reassignedReceiver, conditionallyReassignedReceiver, literalParameters,
    reassignedCallback, conditionallyReassignedCallback, panicBeforeLaunch, rangeShadow]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
  }
});

test("does not confuse conditional or post-Serve cleanup with an initiating shutdown path", async () => {
  const reassignedCloseReceiver = vulnerableProject();
  reassignedCloseReceiver["plugins/server/debug/plugin.go"] += `
func (s server) Close(other server) error {
  s = other
  return s.handler.Close()
}
`;
  const conditionalClose = vulnerableProject();
  conditionalClose["plugins/server/internal/serve.go"] = conditionalClose["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  if shouldClose() { _ = listener.Close() }");
  const shadowedClose = vulnerableProject();
  shadowedClose["plugins/server/internal/serve.go"] = shadowedClose["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", `  go func(listener net.Listener) {
    _ = listener.Close()
  }(nil)`);
  const postServeClose = vulnerableProject();
  postServeClose["plugins/server/internal/serve.go"] = postServeClose["plugins/server/internal/serve.go"]!
    .replace("    defer listener.Close()\n", "")
    .replace("    _ = serve(listener)", "    _ = serve(listener)\n    _ = listener.Close()");
  const gotoLaunch = vulnerableProject();
  gotoLaunch["plugins/server/internal/serve.go"] = gotoLaunch["plugins/server/internal/serve.go"]!
    .replace("  go func() {", "  goto launch\nlaunch:\n  go func() {");
  const shadowedPanic = vulnerableProject();
  shadowedPanic["plugins/server/internal/serve.go"] = shadowedPanic["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  panic(\"observe\")")
    .replace(")\n\nfunc Serve", ")\n\nvar panic = func(any) {}\n\nfunc Serve");

  for (const files of [reassignedCloseReceiver, conditionalClose, shadowedClose, postServeClose, gotoLaunch,
    shadowedPanic]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
  }
});

test("keeps unreachable binding changes separate and requires a definite IIFE stop", async () => {
  const unreachableListener = vulnerableProject();
  unreachableListener["plugins/server/debug/plugin.go"] = unreachableListener["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "if false { listener = nil }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const unreachableReceiver = vulnerableProject();
  unreachableReceiver["plugins/server/debug/plugin.go"] = unreachableReceiver["plugins/server/debug/plugin.go"]!
    .replace("type server struct", "var other server\n\ntype server struct")
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "if false { s = other }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const conditionalIIFE = vulnerableProject();
  conditionalIIFE["plugins/server/internal/serve.go"] = conditionalIIFE["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  if shouldClose() { func() { _ = listener.Close() }() }");
  for (const files of [unreachableListener, unreachableReceiver, conditionalIIFE]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
  }

  const unconditionalIIFE = vulnerableProject();
  unconditionalIIFE["plugins/server/internal/serve.go"] = unconditionalIIFE["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  func() { _ = listener.Close() }()");
  const parenthesizedIIFE = vulnerableProject();
  parenthesizedIIFE["plugins/server/internal/serve.go"] = parenthesizedIIFE["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  (func() { _ = listener.Close() })()");
  for (const files of [unconditionalIIFE, parenthesizedIIFE]) {
    const safe = await review(await repository(files));
    assert.equal(safe.findings.some((item) => item.ruleId === ruleId), false);
  }
});

test("tracks captured IIFE mutations and all-path cleanup execution", async () => {
  const receiverMutation = vulnerableProject();
  receiverMutation["plugins/server/debug/plugin.go"] = receiverMutation["plugins/server/debug/plugin.go"]!
    .replace("type server struct", "var other server\n\ntype server struct")
    .replace("  listener, err := net.Listen", "  func() { s = other }()\n  listener, err := net.Listen");
  const listenerMutation = vulnerableProject();
  listenerMutation["plugins/server/debug/plugin.go"] = listenerMutation["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "func() { listener = nil }()\n  internal.Serve(ctx, listener, s.handler.Serve)");
  for (const files of [receiverMutation, listenerMutation]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
  }

  const conditionalIIFE = vulnerableProject();
  conditionalIIFE["plugins/server/internal/serve.go"] = conditionalIIFE["plugins/server/internal/serve.go"]!
    .replace("  go func() {",
      "  func() { if skip() { return }; _ = listener.Close() }()\n  go func() {");
  const conditionalGoroutine = vulnerableProject();
  conditionalGoroutine["plugins/server/internal/serve.go"] = conditionalGoroutine["plugins/server/internal/serve.go"]!
    .replace("  go func() {",
      "  go func() { if skip() { return }; _ = listener.Close() }()\n  go func() {");
  const staticallyFalse = vulnerableProject();
  staticallyFalse["plugins/server/internal/serve.go"] = staticallyFalse["plugins/server/internal/serve.go"]!
    .replace("  go func() {",
      "  if false { func() { _ = listener.Close() }() }\n  go func() {");
  for (const files of [conditionalIIFE, conditionalGoroutine, staticallyFalse]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
  }

  const staticallyTrue = vulnerableProject();
  staticallyTrue["plugins/server/internal/serve.go"] = staticallyTrue["plugins/server/internal/serve.go"]!
    .replace("  go func() {",
      "  if true { func() { _ = listener.Close() }() }\n  go func() {");
  const safe = await review(await repository(staticallyTrue));
  assert.equal(safe.findings.some((item) => item.ruleId === ruleId), false);
});

test("applies exhaustive control-flow reachability to launches, callbacks, and stops", async () => {
  const unreachableLaunch = vulnerableProject();
  unreachableLaunch["plugins/server/internal/serve.go"] = unreachableLaunch["plugins/server/internal/serve.go"]!
    .replace("  go func() {", "  if enabled() { return } else { return }\n  go func() {");
  const unreachableStartCall = vulnerableProject();
  unreachableStartCall["plugins/server/debug/plugin.go"] = unreachableStartCall["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "switch mode() { case 1: return nil; default: return nil }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const unreachableCallback = vulnerableProject();
  unreachableCallback["plugins/server/internal/serve.go"] = unreachableCallback["plugins/server/internal/serve.go"]!
    .replace("    _ = serve(listener)",
      "    if enabled() { return } else { return }\n    _ = serve(listener)");
  const infiniteLoop = vulnerableProject();
  infiniteLoop["plugins/server/debug/plugin.go"] = infiniteLoop["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "for {}\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const exhaustiveSelect = vulnerableProject();
  exhaustiveSelect["plugins/server/debug/plugin.go"] = exhaustiveSelect["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "select { case <-ctx.Done(): return nil; default: return nil }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const deadBreakLoop = vulnerableProject();
  deadBreakLoop["plugins/server/debug/plugin.go"] = deadBreakLoop["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "for { if false { break } }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const nestedSwitchBreak = vulnerableProject();
  nestedSwitchBreak["plugins/server/debug/plugin.go"] = nestedSwitchBreak["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "for { switch mode() { default: break } }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const terminatingFallthrough = vulnerableProject();
  terminatingFallthrough["plugins/server/debug/plugin.go"] = terminatingFallthrough["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "switch mode() { case 1: fallthrough; default: return nil }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  for (const files of [unreachableLaunch, unreachableStartCall, unreachableCallback, infiniteLoop,
    exhaustiveSelect, deadBreakLoop, nestedSwitchBreak, terminatingFallthrough]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
  }

  const unreachableStop = vulnerableProject();
  unreachableStop["plugins/server/debug/plugin.go"] += `
func (s server) Stop() {
  if enabled() { return } else { return }
  _ = s.handler.Close()
}
`;
  const falseStop = vulnerableProject();
  falseStop["plugins/server/debug/plugin.go"] += `
func (s server) Stop() { if false { _ = s.handler.Close() } }
`;
  const shadowedStop = vulnerableProject();
  shadowedStop["plugins/server/debug/plugin.go"] = shadowedStop["plugins/server/debug/plugin.go"]!
    .replace("type server struct", "var other server\n\ntype server struct") + `
func (s server) Stop() { if true { s := other; _ = s.handler.Close() } }
`;
  const partialIf = vulnerableProject();
  partialIf["plugins/server/debug/plugin.go"] = partialIf["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "if enabled() { return nil }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const partialSwitch = vulnerableProject();
  partialSwitch["plugins/server/debug/plugin.go"] = partialSwitch["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "switch mode() { case 1: return nil }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  const breakableLoop = vulnerableProject();
  breakableLoop["plugins/server/debug/plugin.go"] = breakableLoop["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "for { if enabled() { break } }\n  internal.Serve(ctx, listener, s.handler.Serve)");
  for (const files of [unreachableStop, falseStop, shadowedStop, partialIf, partialSwitch, breakableLoop]) {
    const output = await review(await repository(files));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
  }

  const trueStop = vulnerableProject();
  trueStop["plugins/server/debug/plugin.go"] += `
func (s server) Stop() { if true { _ = s.handler.Close() } }
`;
  const safe = await review(await repository(trueStop));
  assert.equal(safe.findings.some((item) => item.ruleId === ruleId), false);
});

test("anchors helper callback and weakened-stop activation guards", async () => {
  const callbackGuard = vulnerableProject();
  callbackGuard["plugins/server/internal/serve.go"] = callbackGuard["plugins/server/internal/serve.go"]!
    .replace("    _ = serve(listener)", "    if false { _ = serve(listener) }");
  const callbackRoot = await repository(callbackGuard, true);
  await writeFile(
    join(callbackRoot, "plugins/server/internal/serve.go"),
    callbackGuard["plugins/server/internal/serve.go"]!.replace("if false {", "if enabled() {"),
  );
  const callbackOutput = await changedReview(callbackRoot, [
    "plugins/server/debug/plugin.go",
    "plugins/server/internal/serve.go",
  ]);
  const callbackFinding = callbackOutput.findings.find((item) => item.ruleId === ruleId);
  assert.match(callbackFinding?.evidence[0]?.snippet ?? "", /enabled/);

  const weakenedStop = vulnerableProject();
  weakenedStop["plugins/server/internal/serve.go"] = weakenedStop["plugins/server/internal/serve.go"]!
    .replace("  _ = ctx", "  _ = listener.Close()");
  const stopRoot = await repository(weakenedStop, true);
  await writeFile(
    join(stopRoot, "plugins/server/internal/serve.go"),
    weakenedStop["plugins/server/internal/serve.go"]!
      .replace("_ = listener.Close()", "if enabled() { _ = listener.Close() }"),
  );
  const stopOutput = await changedReview(stopRoot, [
    "plugins/server/debug/plugin.go",
    "plugins/server/internal/serve.go",
  ]);
  const stopFinding = stopOutput.findings.find((item) => item.ruleId === ruleId);
  assert.match(stopFinding?.evidence[0]?.snippet ?? "", /enabled/);
});

test("anchors the changed guard that activates a previously dead helper call", async () => {
  const files = vulnerableProject();
  files["plugins/server/debug/plugin.go"] = files["plugins/server/debug/plugin.go"]!
    .replace("internal.Serve(ctx, listener, s.handler.Serve)",
      "if false { internal.Serve(ctx, listener, s.handler.Serve) }");
  const root = await repository(files, true);
  await writeFile(
    join(root, "plugins/server/debug/plugin.go"),
    files["plugins/server/debug/plugin.go"]!.replace("if false {", "if enabled() {"),
  );
  const output = await changedReview(root, [
    "plugins/server/debug/plugin.go",
    "plugins/server/internal/serve.go",
  ]);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.match(finding?.evidence[0]?.snippet ?? "", /enabled/);
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

test("an unrelated context-argument edit does not resurface an existing lifecycle", async () => {
  const files = vulnerableProject();
  const root = await repository(files, true);
  await writeFile(
    join(root, "plugins/server/debug/plugin.go"),
    files["plugins/server/debug/plugin.go"]!.replace(
      "internal.Serve(ctx, listener, s.handler.Serve)",
      "internal.Serve(context.WithoutCancel(ctx), listener, s.handler.Serve)",
    ),
  );
  const output = await changedReview(root, [
    "plugins/server/debug/plugin.go",
    "plugins/server/internal/serve.go",
  ]);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
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
    "go.mod": "module example.com/project\n\ngo 1.24\n",
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
