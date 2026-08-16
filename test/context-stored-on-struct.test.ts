import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const ruleId = "go-concurrency.context.stored-on-struct";

test("flags context.Context stored on Client and Worker", async () => {
  const output = await review(await repository({
    "client.go": `package sample

import "context"

type Client struct {
	ctx context.Context
}

func (c *Client) Fetch() error { return call(c.ctx) }
func call(context.Context) error { return nil }
`,
    "worker.go": `package sample

import "context"

type Worker struct {
	parent context.Context
}
`,
  }));
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.ok(finding);
  assert.equal(finding.severity, "medium");
  assert.match(finding.title ?? "", /stores context\.Context/i);
  assert.ok(finding.evidence.some((item) => item.location?.file === "client.go" && item.location?.line === 6));
  assert.ok(finding.evidence.some((item) => item.location?.file === "worker.go" && item.location?.line === 6));
});

test("flags embedded context.Context and a same-file named alias", async () => {
  const output = await review(await repository({
    "embed.go": `package sample

import "context"

type Holder struct {
	context.Context
	addr string
}
`,
    "alias.go": `package sample

import "context"

type baseCtx = context.Context
type requestCtx = baseCtx

type Manager struct {
	owned requestCtx
}
`,
  }));
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.ok(finding);
  assert.ok(finding.evidence.some((item) => item.location?.file === "embed.go"));
  assert.ok(finding.evidence.some((item) => item.location?.file === "alias.go"));
});

test("flags import-aliased context and pointer fields", async () => {
  const output = await review(await repository({
    "aliasimport.go": `package sample

import ctxpkg "context"

type Server struct {
	root ctxpkg.Context
	ptr  *ctxpkg.Context
}
`,
  }));
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.ok(finding);
  assert.equal(finding.evidence.length, 2);
  assert.ok(finding.evidence.some((item) => item.data && (item.data as { field?: string }).field === "root"));
  assert.ok(finding.evidence.some((item) => item.data && (item.data as { field?: string }).field === "ptr"));
});

test("stays quiet when context is only a function parameter", async () => {
  const output = await review(await repository({
    "dial.go": `package sample

import "context"

type Client struct { addr string }

func Dial(ctx context.Context, addr string) (*Client, error) {
	_ = ctx
	return &Client{addr: addr}, nil
}

func (c *Client) Fetch(ctx context.Context) error { return call(ctx) }
func call(context.Context) error { return nil }
`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("stays quiet on a local request/options bag that is not stored", async () => {
  const output = await review(await repository({
    "request.go": `package sample

import "context"

type request struct {
	ctx context.Context
	path string
}

type options struct {
	ctx context.Context
}

func handle(ctx context.Context, path string) error {
	req := request{ctx: ctx, path: path}
	opts := options{ctx: ctx}
	return call(req.ctx, opts.ctx, req.path)
}

func call(context.Context, context.Context, string) error { return nil }
`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("flags a request-named type that is stored on another struct or as a package var", async () => {
  const output = await review(await repository({
    "stored.go": `package sample

import "context"

type request struct {
	ctx context.Context
}

type Server struct {
	inFlight []request
}

var leftover = request{}
`,
  }));
  const findings = output.findings.filter((item) => item.ruleId === ruleId);
  assert.ok(findings.some((item) => item.evidence[0]?.location?.file === "stored.go"));
});

test("stays quiet on _test.go", async () => {
  const output = await review(await repository({
    "client_test.go": `package sample

import "context"

type harness struct {
	ctx context.Context
}
`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("diff locality reports a newly added field and ignores comments or unrelated edits", async () => {
  const safe = `package sample

import "context"

type Client struct {
	addr string
}

func (c *Client) Fetch(ctx context.Context) error { return nil }
`;
  const bad = `package sample

import "context"

type Client struct {
	addr string
	ctx  context.Context
}

func (c *Client) Fetch() error { return nil }
`;
  const root = await repository({ "client.go": safe }, true);
  await writeFile(join(root, "client.go"), bad);
  const introduced = await changedReview(root);
  assert.equal(introduced.findings.some((item) => item.ruleId === ruleId), true);

  await execute("git", ["restore", "client.go"], { cwd: root });
  await writeFile(join(root, "client.go"), safe
    .replace("package sample", "package sample\n\nvar unrelated = 1")
    .replace("addr string", "addr string // default dial target"));
  const unrelated = await changedReview(root);
  assert.equal(unrelated.findings.some((item) => item.ruleId === ruleId), false);
});

test("diff locality reports an existing field whose alias becomes context.Context", async () => {
  const safe = `package sample

import "time"

type base = time.Time
type stored = base

type Client struct {
	ctx stored
}
`;
  const bad = safe
    .replace('import "time"', 'import "context"')
    .replace("time.Time", "context.Context");
  const root = await repository({ "client.go": safe }, true);
  await writeFile(join(root, "client.go"), bad);
  const output = await changedReview(root);
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.ok(finding, JSON.stringify(output.findings, null, 2));
  assert.equal(finding.evidence[0]?.location?.line, 5);
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
        changed_files: ["client.go"],
      },
    },
  });
}

async function repository(files: Record<string, string>, commit = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-stored-ctx-"));
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
