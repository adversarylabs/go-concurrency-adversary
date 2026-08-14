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

test("requires stack-to-prefix-to-strconv provenance and ignores decoy literals and reassignment", async () => {
  const root = await repository({
    "decoys.go": `package sample

import (
  "os"
  "runtime"
  "strconv"
  "strings"
  "sync"
)

type holder struct { trackers sync.Map }
type parser struct{}
func (parser) ParseInt(string, int, int) (int64, error) { return 7, nil }

func unrelatedParse() int64 {
  var buf [64]byte
  _ = runtime.Stack(buf[:], false)
  _ = strings.TrimPrefix("not stack text", "goroutine ")
  id, _ := strconv.ParseInt(os.Getenv("REQUEST_ID"), 10, 64)
  return id
}

func reassignedStackText() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  text = os.Getenv("REQUEST_ID")
  id, _ := strconv.ParseInt(text, 10, 64)
  return id
}

func customParser() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := (parser{}).ParseInt(text, 10, 64)
  return id
}

func nestedReturnOnly() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(text, 10, 64)
  _ = func() int64 { return id }
  return 7
}

func wrongSliceLowerBound() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[n:]), "goroutine ")
  id, _ := strconv.ParseInt(text, 10, 64)
  return id
}

func wrongSliceWindow() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[1:n]), "goroutine ")
  id, _ := strconv.ParseInt(text, 10, 64)
  return id
}

func wrongSliceCapacity() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n:cap(buf)]), "goroutine ")
  id, _ := strconv.ParseInt(text, 10, 64)
  return id
}

func (h *holder) Store(value any) {
  h.trackers.Store(unrelatedParse(), value)
  h.trackers.Store(reassignedStackText(), value)
  h.trackers.Store(customParser(), value)
  h.trackers.Store(nestedReturnOnly(), value)
  h.trackers.Store(wrongSliceLowerBound(), value)
  h.trackers.Store(wrongSliceWindow(), value)
  h.trackers.Store(wrongSliceCapacity(), value)
}
`,
  });
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("requires value-preserving goroutine-prefix transformations", async () => {
  const destructiveSlice = cortexShape("goroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)",
    "text = text[:0]\n  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)",
  );
  let output = await review(await repository({ "destructive-prefix-slice.go": destructiveSlice }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const lengthOnly = cortexShape("goroutineID").replace(
    "strings.Fields(text)[0]",
    "strings.Repeat(\"7\", len(text))",
  );
  output = await review(await repository({ "length-only-prefix-use.go": lengthOnly }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const splitToken = cortexShape("goroutineID").replace(
    "strings.Fields(text)[0]",
    "strings.Split(text, \" \")[0]",
  );
  output = await review(await repository({ "split-prefix.go": splitToken }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  for (const token of ["strings.Fields(text)[0]", "strings.Split(text, \" \")[0]"]) {
    const assignedToken = cortexShape("goroutineID").replace(
      "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)",
      `text = ${token}\n  id, _ := strconv.ParseInt(text, 10, 64)`,
    );
    output = await review(await repository({ "assigned-prefix-token.go": assignedToken }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true, token);
  }

  const indexByteToken = cortexShape("goroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)",
    "if boundary := strings.IndexByte(text, ' '); boundary >= 0 { text = text[:boundary] }\n  id, _ := strconv.ParseInt(text, 10, 64)",
  );
  output = await review(await repository({ "index-byte-prefix.go": indexByteToken }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const siblingBoundaryShadow = indexByteToken.replace(
    "text = text[:boundary]",
    "{ boundary := 0; _ = boundary }; text = text[:boundary]",
  );
  output = await review(await repository({ "sibling-boundary-shadow.go": siblingBoundaryShadow }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const destroyedBoundary = indexByteToken.replace(
    "text = text[:boundary]",
    "boundary = 0; text = text[:boundary]",
  );
  output = await review(await repository({ "destroyed-index-boundary.go": destroyedBoundary }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const staleBoundary = cortexShape("goroutineID")
    .replace(
      "var buf [64]byte",
      `text := ""
  boundary := strings.IndexByte(text, ' ')
  var buf [64]byte`,
    )
    .replace(
      "text := strings.TrimPrefix(string(buf[:n]), \"goroutine \")",
      "text = strings.TrimPrefix(string(buf[:n]), \"goroutine \")",
    )
    .replace(
      "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)",
      "text = text[:boundary]\n  id, _ := strconv.ParseInt(text, 10, 64)",
    );
  output = await review(await repository({ "pre-origin-index-boundary.go": staleBoundary }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const invalidTransformSequence = cortexShape("goroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)",
    `text = strings.Fields(text)[0]
  boundary := strings.IndexByte(text, ' ')
  text = text[:boundary]
  id, _ := strconv.ParseInt(text, 10, 64)`,
  );
  output = await review(await repository({ "invalid-transform-sequence.go": invalidTransformSequence }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("supports aliased standard packages and requires the derived ID in key position", async () => {
  const root = await repository({
    "aliases.go": `package sample

import (
  r "runtime"
  c "strconv"
  s "strings"
  y "sync"
)

type holder struct { trackers y.Map }

func goroutineID() int64 {
  var buf [64]byte
  n := r.Stack(buf[:], false)
  text := s.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := c.ParseInt(s.Fields(text)[0], 10, 64)
  return id
}

func (h *holder) Store(requestID string, value any) {
  h.trackers.Store(requestID, goroutineID())
}
func (h *holder) Load() any { value, _ := h.trackers.Load(goroutineID()); return value }
`,
  });
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence.length, 1);
  assert.match(finding?.evidence[0]?.snippet ?? "", /Load\(goroutineID\(\)\)/);
});

test("stays quiet when package or helper identifiers are shadowed", async () => {
  const root = await repository({
    "shadowed.go": `package sample

import (
  "runtime"
  "strconv"
  "strings"
  "sync"
)

var _ = runtime.NumCPU
type fakeRuntime struct{}
func (fakeRuntime) Stack([]byte, bool) int { return 1 }
type holder struct { trackers sync.Map }

func packageShadow(runtime fakeRuntime) int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(text, 10, 64)
  return id
}

func realGoroutineID() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  return id
}

func (h *holder) Store(value any) {
  realGoroutineID := func() int64 { return 7 }
  h.trackers.Store(realGoroutineID(), value)
  h.trackers.Store(packageShadow(fakeRuntime{}), value)
}
`,
  });
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("binds mutable fields to the exact receiver type despite a same-named custom store", async () => {
  const source = cortexShape("getGoroutineID").replace(
    "type requestTracker struct{}",
    `type requestTracker struct{}
type inertStore struct{}
func (inertStore) Store(any, any) {}
type unrelatedHolder struct { trackers inertStore }
func (h *unrelatedHolder) Record(value any) { h.trackers.Store(getGoroutineID(), value) }`,
  );
  const root = await repository({ "collision.go": source });
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.snippet, "h.trackers.Store(getGoroutineID(), tracker)");
  assert.doesNotMatch(finding?.evidence[0]?.snippet ?? "", /Record/);
});

test("supports var-initialized native maps and pointer sync.Map fields but rejects custom stores", async () => {
  const source = cortexShape("getGoroutineID").replace(
    "type requestTrackerHolder struct {\n  trackers sync.Map\n}",
    `type requestTrackerHolder struct { trackers *sync.Map }
type customStore struct{}
func (*customStore) Store(any, any) {}
type customHolder struct { trackers *customStore }
func nativeState() {
  var state = map[int64]string{}
  state[getGoroutineID()] = "owned"
}
func customState(h *customHolder) { h.trackers.Store(getGoroutineID(), "diagnostic") }`,
  );
  const root = await repository({ "state.go": source });
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence.length, 2);
  assert.deepEqual(finding?.evidence.map((item) => item.snippet), [
    'state[getGoroutineID()] = "owned"',
    "h.trackers.Store(getGoroutineID(), tracker)",
  ]);
});

test("suppresses only ID-specific terminating guards before key use", async () => {
  const root = await repository({
    "guards.go": `package sample

import (
  "runtime"
  "strconv"
  "strings"
  "sync"
)

type holder struct { trackers sync.Map }
func rawID() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  return id
}
func panicID() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 { panic("invalid goroutine id") }
  return id
}
func retryID() int64 {
  for {
    var buf [64]byte
    n := runtime.Stack(buf[:], false)
    text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
    id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
    if id == 0 { continue }
    return id
  }
}
func (h *holder) SafeReturn(value any) {
  id := rawID()
  if id == 0 { return }
  h.trackers.Store(id, value)
}
func (h *holder) SafePanic(value any) {
  id := rawID()
  if 0 == id { panic("invalid goroutine id") }
  h.trackers.Store(id, value)
}
func (h *holder) SafeHelpers(value any) {
  h.trackers.Store(panicID(), value)
  h.trackers.Store(retryID(), value)
}
func (h *holder) Reassigned(value any) {
  id := rawID()
  id = 7
  h.trackers.Store(id, value)
}
func (h *holder) UnrelatedGuard(other int64, value any) {
  id := rawID()
  if other == 0 { return }
  _, _ = h.trackers.Load(id)
}
`,
  });
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.snippet, "_, _ = h.trackers.Load(id)");
});

test("recognizes equivalent terminating zero-failure guards", async () => {
  for (const condition of ["0 >= id", "id < 1"]) {
    const source = cortexShape("goroutineID")
      .replace("h.trackers.Load(goroutineID())", "h.trackers.Load(1)")
      .replace("h.trackers.Delete(goroutineID())", "h.trackers.Delete(1)")
      .replace("h.trackers.Store(goroutineID(), tracker)", `id := goroutineID()
  if ${condition} { return }
  h.trackers.Store(id, tracker)`);
    const output = await review(await repository({ "equivalent-zero-guard.go": source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, condition);
  }
});

test("does not treat a shadowed panic call as terminating", async () => {
  const source = cortexShape("rawID").replace(
    "type requestTracker struct{}",
    `type requestTracker struct{}
func panic(any) {}`,
  ).replace(
    "func (h *requestTrackerHolder) Set(tracker *requestTracker) {\n  h.trackers.Store(rawID(), tracker)\n}",
    `func (h *requestTrackerHolder) Set(tracker *requestTracker) {
  id := rawID()
  if id == 0 { panic("not terminating") }
  h.trackers.Store(id, tracker)
}`,
  );
  const root = await repository({ "panic-shadow.go": source });
  const output = await review(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.snippet, "h.trackers.Store(id, tracker)");
});

test("an inner closure shadow does not hide a real outer package call", async () => {
  const source = cortexShape("getGoroutineID").replace(
    "var buf [64]byte",
    `type fakeRuntime struct{}
  _ = func(runtime fakeRuntime) { _ = runtime }
  var buf [64]byte`,
  );
  const root = await repository({ "nested-shadow.go": source });
  const output = await review(root);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("anchors a changed goroutine-prefix contract instead of an unchanged key call", async () => {
  const before = cortexShape("getGoroutineID").replace('"goroutine "', '"thread "');
  const root = await repository({ "tracking.go": before }, true);
  await writeFile(join(root, "tracking.go"), before.replace('"thread "', '"goroutine "'));

  const output = await changedReview(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.location?.line, 28);
  assert.equal(finding?.evidence[0]?.snippet, 'text := strings.TrimPrefix(string(buf[:n]), "goroutine ")');
});

test("anchors a changed derived-prefix transformation", async () => {
  const before = cortexShape("getGoroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)",
    "text = text\n  id, _ := strconv.ParseInt(text, 10, 64)",
  );
  const root = await repository({ "tracking.go": before }, true);
  await writeFile(join(root, "tracking.go"), before.replace("text = text", "text = strings.Fields(text)[0]"));

  const output = await changedReview(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.location?.line, 29);
  assert.equal(finding?.evidence[0]?.snippet, "text = strings.Fields(text)[0]");
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

test("does not let a later zero guard hide an earlier conditional parsed-ID return", async () => {
  const source = cortexShape("getGoroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
    `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id > 10 { return id }
  if id == 0 { panic("invalid goroutine id") }
  return id`,
  );
  const output = await review(await repository({ "guard-dominance.go": source }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("does not let a conditional post-parse overwrite hide the unmodified path", async () => {
  const source = cortexShape("getGoroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
    `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id < 0 { id = 7 }
  return id`,
  );
  const output = await review(await repository({ "conditional-overwrite.go": source }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("does not let a pre-reassignment zero guard prove a later zero key safe", async () => {
  const source = cortexShape("getGoroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
    `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 { panic("invalid goroutine id") }
  if id > 10 { id = 0 }
  return id`,
  );
  const output = await review(await repository({ "guard-before-reassignment.go": source }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("resolves package mutable state declared after its use", async () => {
  const source = cortexShape("getGoroutineID")
    .replace("h.trackers.Store(getGoroutineID(), tracker)", "globalTrackers.Store(getGoroutineID(), tracker)")
    .replace("func (h *requestTrackerHolder) Get()", "var globalTrackers sync.Map\n\nfunc (h *requestTrackerHolder) Get()");
  const output = await review(await repository({ "late-global.go": source }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("ignores shadows confined to sibling blocks", async () => {
  const source = cortexShape("getGoroutineID")
    .replace(
      "h.trackers.Store(getGoroutineID(), tracker)",
      `if false { getGoroutineID := func() int64 { return 7 }; _ = getGoroutineID }
  h.trackers.Store(getGoroutineID(), tracker)`,
    )
    .replace(
      "var buf [64]byte",
      `if false { runtime := struct{}{}; _ = runtime }
  var buf [64]byte`,
    );
  const output = await review(await repository({ "sibling-shadow.go": source }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("ignores shadows confined to if initializers", async () => {
  const source = cortexShape("getGoroutineID")
    .replace(
      "h.trackers.Store(getGoroutineID(), tracker)",
      `if getGoroutineID := func() int64 { return 7 }; false { _ = getGoroutineID }
  h.trackers.Store(getGoroutineID(), tracker)`,
    )
    .replace(
      "var buf [64]byte",
      `if runtime := struct{}{}; false { _ = runtime }
  var buf [64]byte`,
    );
  const output = await review(await repository({ "if-init-shadow.go": source }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("accepts canonical zero-based stack slices and rejects nonzero and full slices", async () => {
  const canonical = cortexShape("getGoroutineID")
    .replace("runtime.Stack(buf[:], false)", "runtime.Stack(buf[0:], false)")
    .replace("string(buf[:n])", "string(buf[0:n])");
  let output = await review(await repository({ "canonical.go": canonical }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const invalidInput = canonical.replace("buf[0:]", "buf[1:]");
  const invalidWindow = canonical.replace("buf[0:n]", "buf[1:n]");
  const invalidCapacity = canonical.replace("buf[0:n]", "buf[0:n:cap(buf)]");
  for (const [path, source] of Object.entries({ invalidInput, invalidWindow, invalidCapacity })) {
    output = await review(await repository({ [`${path}.go`]: source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, path);
  }
});

test("supports simple same-file native map aliases", async () => {
  const source = cortexShape("getGoroutineID").replace(
    "type requestTracker struct{}",
    `type requestTracker struct{}
type baseTrackerMap map[int64]*requestTracker
type trackerMap = baseTrackerMap
var aliasedTrackers = trackerMap{}`,
  ).replace(
    "h.trackers.Store(getGoroutineID(), tracker)",
    "aliasedTrackers[getGoroutineID()] = tracker",
  );
  const output = await review(await repository({ "map-alias.go": source }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("resolves receiver native-map aliases and anchors their semantic introduction", async () => {
  const direct = cortexShape("goroutineID")
    .replace("trackers sync.Map", "trackers sync.Map\n  native map[int64]*requestTracker")
    .replace("h.trackers.Load(goroutineID())", "h.trackers.Load(1)")
    .replace("h.trackers.Delete(goroutineID())", "h.trackers.Delete(1)")
    .replace("h.trackers.Store(goroutineID(), tracker)", "state := h.native\n  state[goroutineID()] = tracker");
  let output = await review(await repository({ "receiver-map-alias.go": direct }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const chained = direct.replace("state[goroutineID()] = tracker", "alias := state\n  alias[goroutineID()] = tracker");
  output = await review(await repository({ "chained-receiver-map-alias.go": chained }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const reassigned = direct.replace(
    "state[goroutineID()] = tracker",
    "state = nil\n  state[goroutineID()] = tracker",
  );
  output = await review(await repository({ "reassigned-receiver-map-alias.go": reassigned }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const previous = direct.replace("state := h.native", "state := make([]*requestTracker, 1)");
  const root = await repository({ "tracking.go": previous }, true);
  await writeFile(join(root, "tracking.go"), direct);
  output = await changedReview(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.snippet, "state := h.native");
  assert.equal(finding?.evidence[0]?.data?.changeKind, "state-declaration");

  const receiverAlias = direct.replace(
    "state := h.native\n  state[goroutineID()] = tracker",
    "self := h\n  self.native[goroutineID()] = tracker",
  );
  output = await review(await repository({ "receiver-alias.go": receiverAlias }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const receiverReassigned = receiverAlias.replace(
    "self.native[goroutineID()] = tracker",
    "self = &holder{}\n  self.native[goroutineID()] = tracker",
  );
  output = await review(await repository({ "reassigned-receiver-alias.go": receiverReassigned }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const previousReceiverAlias = receiverAlias.replace("self := h", "self := &holder{}");
  const receiverRoot = await repository({ "tracking.go": previousReceiverAlias }, true);
  await writeFile(join(receiverRoot, "tracking.go"), receiverAlias);
  output = await changedReview(receiverRoot);
  const receiverFinding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(receiverFinding?.evidence[0]?.snippet, "self := h");
  assert.equal(receiverFinding?.evidence[0]?.data?.changeKind, "state-declaration");
});

test("only carries nonzero proof through identity-preserving assignments", async () => {
  for (const expression of ["id - id", "id % id", "id ^ id", "id * 0"]) {
    const source = cortexShape("goroutineID").replace("return id", `return ${expression}`);
    const output = await review(await repository({ "destructive-return.go": source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, `return ${expression}`);
  }

  for (const expression of [
    "id", "+id", "int64(id)", "id + 0", "id * 1", "id | 0", "id / 1", "id ^ 0", "id | id", "id & id",
  ]) {
    const source = cortexShape("goroutineID").replace("return id", `return ${expression}`);
    const output = await review(await repository({ "identity-return.go": source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true, `return ${expression}`);
  }

  for (const expression of ["id - id", "id % id"]) {
    const source = cortexShape("goroutineID").replace(
      "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
      `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 { panic("invalid goroutine id") }
  id = ${expression}
  return id`,
    );
    const output = await review(await repository({ "unsafe-transform.go": source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true, expression);
  }

  for (const expression of [
    "id", "+id", "+(id)", "int64(id)", "id + 0", "0 + id", "id - (-0)",
    "id * 1", "1 * id", "id | (+0)", "id / 1", "id ^ 0", "id | id", "id & id",
  ]) {
    const source = cortexShape("goroutineID").replace(
      "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
      `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 { panic("invalid goroutine id") }
  id = ${expression}
  return id`,
    );
    const output = await review(await repository({ "safe-transform.go": source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, expression);
  }

  for (const compound of ["id %= 1", "id ^= id", "id &= 0", "id *= 0"]) {
    const source = cortexShape("goroutineID").replace(
      "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
      `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 { panic("invalid goroutine id") }
  ${compound}
  return id`,
    );
    const output = await review(await repository({ "unsafe-compound-helper.go": source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true, compound);
  }

  for (const compound of [
    "id += 0", "id -= 0", "id *= 1", "id /= 1", "id |= 0", "id ^= 0", "id |= id", "id &= id",
  ]) {
    const source = cortexShape("goroutineID").replace(
      "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
      `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 { panic("invalid goroutine id") }
  ${compound}
  return id`,
    );
    const output = await review(await repository({ "identity-compound-helper.go": source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, compound);
  }
});

test("invalidates caller guards after destructive key assignments and accepts proven identities", async () => {
  const callerShape = (expression: string, prelude = "") => cortexShape("goroutineID")
    .replace("h.trackers.Load(goroutineID())", "h.trackers.Load(1)")
    .replace("h.trackers.Delete(goroutineID())", "h.trackers.Delete(1)")
    .replace("h.trackers.Store(goroutineID(), tracker)", `${prelude}id := goroutineID()
  if id == 0 { return }
  id = ${expression}
  h.trackers.Store(id, tracker)`);

  for (const expression of ["0", "id - id", "id % id", "id ^ id"]) {
    const output = await review(await repository({ "caller-destructive.go": callerShape(expression) }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true, expression);
  }

  for (const expression of [
    "int64(id)", "id + 0", "0 + id", "id - (-0)", "id * 1", "1 * id", "id | (+0)", "id / 1", "id ^ 0",
    "id | id", "id & id",
  ]) {
    const output = await review(await repository({ "caller-identity.go": callerShape(expression) }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, expression);
  }

  const compoundCallerShape = (compound: string) => cortexShape("goroutineID")
    .replace("h.trackers.Load(goroutineID())", "h.trackers.Load(1)")
    .replace("h.trackers.Delete(goroutineID())", "h.trackers.Delete(1)")
    .replace("h.trackers.Store(goroutineID(), tracker)", `id := goroutineID()
  if id == 0 { return }
  ${compound}
  h.trackers.Store(id, tracker)`);
  for (const compound of ["id %= 1", "id ^= id", "id &= 0", "id *= 0"]) {
    const output = await review(await repository({ "caller-destructive-compound.go": compoundCallerShape(compound) }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), true, compound);
  }
  for (const compound of [
    "id += 0", "id -= 0", "id *= 1", "id /= 1", "id |= 0", "id ^= 0", "id |= id", "id &= id",
  ]) {
    const output = await review(await repository({ "caller-identity-compound.go": compoundCallerShape(compound) }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, compound);
  }

  const shadowedConversion = callerShape("int64(id)", "int64 := func(int64) int64 { return 0 }\n  ");
  let output = await review(await repository({ "shadowed-conversion.go": shadowedConversion }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const nestedShadow = callerShape("id").replace(
    "id = id",
    `if true { id := int64(7); id = 0; _ = id }
  id = id`,
  );
  output = await review(await repository({ "nested-shadow-assignment.go": nestedShadow }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const globalShadow = callerShape("int64(id)").replace(
    "type requestTracker struct{}",
    `type requestTracker struct{}
func int64(value int64) int64 { return 0 }`,
  );
  output = await review(await repository({ "global-conversion-shadow.go": globalShadow }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("requires recursive guards and exhaustive switches to terminate every zero path", async () => {
  const safeHelper = cortexShape("goroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
    `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 {
    if len(text) > 1 { panic("invalid goroutine id") } else { panic("empty goroutine id") }
  }
  return id`,
  );
  let output = await review(await repository({ "nested-safe.go": safeHelper }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const switchHelper = cortexShape("goroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
    `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 {
    switch len(text) {
    case 0: panic("empty goroutine id")
    default: panic("invalid goroutine id")
    }
  }
  return id`,
  );
  output = await review(await repository({ "switch-helper-safe.go": switchHelper }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const safeCaller = cortexShape("goroutineID")
    .replace("h.trackers.Load(goroutineID())", "h.trackers.Load(1)")
    .replace("h.trackers.Delete(goroutineID())", "h.trackers.Delete(1)")
    .replace("h.trackers.Store(goroutineID(), tracker)", `id := goroutineID()
  if id == 0 {
    switch tracker {
    case nil: panic("nil tracker")
    default: return
    }
  }
  h.trackers.Store(id, tracker)`);
  output = await review(await repository({ "switch-safe.go": safeCaller }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const nestedCaller = safeCaller.replace(
    `switch tracker {
    case nil: panic("nil tracker")
    default: return
    }`,
    `if tracker == nil { panic("nil tracker") } else { return }`,
  );
  output = await review(await repository({ "nested-caller-safe.go": nestedCaller }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  const unsafe = safeHelper.replace(
    `if len(text) > 1 { panic("invalid goroutine id") } else { panic("empty goroutine id") }`,
    `if len(text) > 1 { panic("invalid goroutine id") }`,
  );
  output = await review(await repository({ "nested-unsafe.go": unsafe }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const unsafeSwitch = safeCaller.replace("default: return", "case &requestTracker{}: return");
  output = await review(await repository({ "switch-unsafe.go": unsafeSwitch }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const unreachableHelperPanic = cortexShape("goroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
    `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 { return 0; panic("unreachable") }
  return id`,
  );
  output = await review(await repository({ "unreachable-helper-panic.go": unreachableHelperPanic }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  const unreachableCallerPanic = safeCaller.replace(
    `switch tracker {
    case nil: panic("nil tracker")
    default: return
    }`,
    `switch tracker {
    case nil: break; panic("unreachable")
    default: return
    }`,
  );
  output = await review(await repository({ "unreachable-caller-panic.go": unreachableCallerPanic }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("handles Go zero literal forms in slices and guards without treating identifiers as constants", async () => {
  for (const zero of ["0", "00", "0_0", "0x0", "0x_0", "0b0", "0b_0", "0o0", "0o_0"]) {
    const source = cortexShape("goroutineID")
      .replace("runtime.Stack(buf[:], false)", `runtime.Stack(buf[${zero}:], false)`)
      .replace("string(buf[:n])", `string(buf[${zero}:n])`)
      .replace("id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
        `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == ${zero} { panic("invalid goroutine id") }
  return id`);
    const output = await review(await repository({ "zero-literal.go": source }));
    assert.equal(output.findings.some((item) => item.ruleId === ruleId), false, zero);
  }

  const identifierGuard = cortexShape("goroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
    `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  const zero = 0
  if id == zero { panic("invalid goroutine id") }
  return id`,
  );
  const output = await review(await repository({ "identifier-zero.go": identifierGuard }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);

  for (const zero of ["+0", "-0", "(0)", "+(0)", "(-0)"]) {
    const guarded = cortexShape("goroutineID").replace(
      "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
      `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == ${zero} { panic("invalid goroutine id") }
  return id`,
    );
    const guardedOutput = await review(await repository({ "signed-zero.go": guarded }));
    assert.equal(guardedOutput.findings.some((item) => item.ruleId === ruleId), false, zero);
  }
});

test("activates and anchors when a mutable state declaration becomes provable", async () => {
  const fieldCurrent = cortexShape("goroutineID");
  const fieldPrevious = fieldCurrent
    .replace("type requestTracker struct{}", `type requestTracker struct{}
type customStore struct{}
func (customStore) Store(any, any) {}
func (customStore) Load(any) (any, bool) { return nil, false }
func (customStore) Delete(any) {}`)
    .replace("trackers sync.Map", "trackers customStore");
  let root = await repository({ "tracking.go": fieldPrevious }, true);
  await writeFile(join(root, "tracking.go"), fieldCurrent);
  let output = await changedReview(root);
  let finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.snippet, "trackers sync.Map");
  assert.equal(finding?.evidence[0]?.data?.changeKind, "state-declaration");

  const mapCurrent = `package sample

import (
  "runtime"
  "strconv"
  "strings"
)

var state map[int64]string
func Store(value string) { state[goroutineID()] = value }
func goroutineID() int64 {
  var buf [64]byte
  n := runtime.Stack(buf[:], false)
  text := strings.TrimPrefix(string(buf[:n]), "goroutine ")
  id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  return id
}
`;
  root = await repository({ "tracking.go": mapCurrent.replace("map[int64]string", "[]any") }, true);
  await writeFile(join(root, "tracking.go"), mapCurrent);
  output = await changedReview(root);
  finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.snippet, "var state map[int64]string");
  assert.equal(finding?.evidence[0]?.data?.changeKind, "state-declaration");

  const aliasCurrent = mapCurrent
    .replace("var state map[int64]string", "type stateMap map[int64]string\nvar state stateMap");
  const aliasPrevious = aliasCurrent.replace("type stateMap map[int64]string", "type stateMap []any");
  root = await repository({ "tracking.go": aliasPrevious }, true);
  await writeFile(join(root, "tracking.go"), aliasCurrent);
  output = await changedReview(root);
  finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence[0]?.snippet, "type stateMap map[int64]string");
  assert.equal(finding?.evidence[0]?.data?.changeKind, "state-declaration");
});

test("activates when the only terminating zero guard is deleted", async () => {
  const guarded = cortexShape("goroutineID").replace(
    "id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)\n  return id",
    `id, _ := strconv.ParseInt(strings.Fields(text)[0], 10, 64)
  if id == 0 { panic("invalid goroutine id") }
  return id`,
  );
  const root = await repository({ "tracking.go": guarded }, true);
  await writeFile(join(root, "tracking.go"), cortexShape("goroutineID"));
  const output = await changedReview(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.snippet, "func goroutineID() int64 {");
  assert.equal(finding?.evidence[0]?.data?.changeKind, "deletion");
  assert.equal(finding?.evidence[0]?.data?.deletedSemantic, "terminating-zero-guard");
  assert.equal(finding?.evidence[0]?.data?.anchorScope, "goroutineID");
  assert.equal(typeof finding?.evidence[0]?.data?.deletedLine, "number");

  const changedRoot = await repository({ "tracking.go": guarded }, true);
  await writeFile(join(changedRoot, "tracking.go"), guarded.replace(
    'panic("invalid goroutine id")',
    'println("invalid goroutine id")',
  ));
  const changedOutput = await changedReview(changedRoot);
  const changedFinding = changedOutput.findings.find((item) => item.ruleId === ruleId);
  assert.match(changedFinding?.evidence[0]?.snippet ?? "", /println/);
  assert.equal(changedFinding?.evidence[0]?.data?.changeKind, "guard-change");

  const callerGuarded = cortexShape("goroutineID")
    .replace("h.trackers.Load(goroutineID())", "h.trackers.Load(1)")
    .replace("h.trackers.Delete(goroutineID())", "h.trackers.Delete(1)")
    .replace("h.trackers.Store(goroutineID(), tracker)", `key := goroutineID()
  if key == 0 { return }
  h.trackers.Store(key, tracker)`);
  const callerRoot = await repository({ "tracking.go": callerGuarded }, true);
  await writeFile(join(callerRoot, "tracking.go"), callerGuarded.replace("  if key == 0 { return }\n", ""));
  const callerOutput = await changedReview(callerRoot);
  const callerFinding = callerOutput.findings.find((item) => item.ruleId === ruleId);
  assert.match(callerFinding?.evidence[0]?.snippet ?? "", /Store\(key/);
  assert.equal(callerFinding?.evidence[0]?.data?.changeKind, "deletion");
  assert.equal(callerFinding?.evidence[0]?.data?.deletedSemantic, "terminating-zero-guard");

  const changedCallerRoot = await repository({ "tracking.go": callerGuarded }, true);
  await writeFile(join(changedCallerRoot, "tracking.go"), callerGuarded.replace(
    "if key == 0 { return }",
    "if key == 0 { println(\"invalid goroutine id\") }",
  ));
  const changedCallerOutput = await changedReview(changedCallerRoot);
  const changedCallerFinding = changedCallerOutput.findings.find((item) => item.ruleId === ruleId);
  assert.match(changedCallerFinding?.evidence[0]?.snippet ?? "", /println/);
  assert.equal(changedCallerFinding?.evidence[0]?.data?.changeKind, "guard-change");

  for (const condition of ["0 >= key", "key < 1"]) {
    const equivalentGuarded = callerGuarded.replace("key == 0", condition);
    const equivalentRoot = await repository({ "tracking.go": equivalentGuarded }, true);
    await writeFile(join(equivalentRoot, "tracking.go"), equivalentGuarded.replace(
      `  if ${condition} { return }\n`,
      "",
    ));
    const equivalentOutput = await changedReview(equivalentRoot);
    const equivalentFinding = equivalentOutput.findings.find((item) => item.ruleId === ruleId);
    assert.equal(equivalentFinding?.evidence[0]?.data?.changeKind, "deletion", condition);
    assert.equal(equivalentFinding?.evidence[0]?.data?.deletedSemantic, "terminating-zero-guard", condition);
  }
});

test("keeps select, range, and type-switch bindings lexical for packages and mutable state", async () => {
  const source = cortexShape("realID")
    .replace("type requestTracker struct{}", `type requestTracker struct{}
type fakeRuntime struct{}
func (fakeRuntime) Stack([]byte, bool) int { return 1 }
type inertStore struct{}
func (inertStore) Store(any, any) {}`)
    .replace(
      "h.trackers.Store(realID(), tracker)",
      `runtimeCh := make(chan fakeRuntime)
  select { case runtime := <-runtimeCh:
    var buf [64]byte
    _ = runtime.Stack(buf[:], false)
  default:
  }
  stores := []inertStore{{}}
  for _, trackers := range stores { trackers.Store(realID(), tracker) }
  var candidate any = inertStore{}
  switch trackers := candidate.(type) { case inertStore: trackers.Store(realID(), tracker) }
  h.trackers.Store(realID(), tracker)`,
    );
  const output = await review(await repository({ "control-bindings.go": source }));
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.equal(finding?.evidence.length, 1);
  assert.equal(finding?.evidence[0]?.snippet, "h.trackers.Store(realID(), tracker)");
});

test("recognizes make of a same-file named native map type", async () => {
  const source = cortexShape("goroutineID")
    .replace("type requestTracker struct{}", `type requestTracker struct{}
type trackerMap map[int64]*requestTracker
var namedTrackers = make(trackerMap)`)
    .replace("h.trackers.Store(goroutineID(), tracker)", "namedTrackers[goroutineID()] = tracker");
  const output = await review(await repository({ "made-map-alias.go": source }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), true);
});

test("ignores comment-only edits on a semantic anchor", async () => {
  const before = cortexShape("getGoroutineID");
  const root = await repository({ "tracking.go": before }, true);
  await writeFile(join(root, "tracking.go"), before.replace(
    "h.trackers.Store(getGoroutineID(), tracker)",
    "h.trackers.Store(getGoroutineID(), tracker) // ownership cache",
  ));
  const output = await changedReview(root);
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);

  await execute("git", ["restore", "tracking.go"], { cwd: root });
  await writeFile(join(root, "tracking.go"), before.replace(
    "trackers sync.Map",
    "trackers sync.Map // request ownership",
  ));
  const stateOutput = await changedReview(root);
  assert.equal(stateOutput.findings.some((item) => item.ruleId === ruleId), false);
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
