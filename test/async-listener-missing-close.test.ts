import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/index.ts";

const ruleId = "go-concurrency.async-listener.missing-close";

test("stays quiet for an unproven helper merely named Serve", async () => {
  const output = await review(await repository({
    "plugin.go": `package sample

import (
	"context"
	"net"
	"net/http"
)

type server struct {
	handler *http.Server
}

func (s server) Start(ctx context.Context) error {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	internal.Serve(ctx, l, s.handler.Serve)
	return nil
}

var internal = struct {
	Serve func(context.Context, net.Listener, func(net.Listener) error)
}{}
`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("flags go ListenAndServe without Close", async () => {
  const output = await review(await repository({
    "http.go": `package sample

import "net/http"

type debug struct{}

func (d *debug) Start() {
	go http.ListenAndServe(":0", nil)
}
`,
  }));
  const finding = output.findings.find((item) => item.ruleId === ruleId);
  assert.ok(finding);
  assert.ok(finding.evidence.some((item) => item.location?.file === "http.go"));
});

test("stays quiet when a direct goroutine owner implements Close", async () => {
  const output = await review(await repository({
    "plugin.go": `package sample

import "net/http"

type server struct {
	handler *http.Server
}

func (s server) Start() {
	go s.handler.ListenAndServe()
}

func (s server) Close() error {
	return s.handler.Close()
}

`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("stays quiet when Serve error is returned (blocking)", async () => {
  const output = await review(await repository({
    "block.go": `package sample

import "net/http"

type server struct {
	srv *http.Server
}

func (s *server) Run() error {
	return s.srv.ListenAndServe()
}
`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

test("stays quiet in test files", async () => {
  const output = await review(await repository({
    "plugin_test.go": `package sample

import "net/http"

type server struct{}

func (s server) Start() {
	go http.ListenAndServe(":0", nil)
}
`,
  }));
  assert.equal(output.findings.some((item) => item.ruleId === ruleId), false);
});

async function review(root: string) {
  return createApp().run({ input: { source: { path: root } } });
}

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-async-listener-"));
  for (const [path, contents] of Object.entries(files)) {
    await writeFile(join(root, path), contents);
  }
  return root;
}
