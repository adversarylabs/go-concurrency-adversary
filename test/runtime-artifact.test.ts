import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the published runtime executes without node_modules", async () => {
  const artifact = await mkdtemp(join(tmpdir(), "go-concurrency-artifact-"));
  const repository = await mkdtemp(join(tmpdir(), "go-concurrency-target-"));
  const entrypoint = join(artifact, "dist", "index.js");
  const input = join(artifact, "input.json");
  const output = join(artifact, "output.json");
  const archive = join(artifact, "package.tar");

  const ignored = (await readFile(join(projectRoot, ".adversaryignore"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(ignored.includes(".git"));
  assert.ok(ignored.includes("node_modules/"));
  assert.ok(ignored.includes("docs/train-drafts/"));

  const runtimeFiles = [
    "adversary.yaml",
    "dist/index.js",
    "dist/web-tree-sitter.wasm",
    "dist/tree-sitter-go.wasm",
    "schemas/adversary.review.v1.schema.json",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
  ];
  for (const path of runtimeFiles) {
    await execute("git", ["ls-files", "--error-unmatch", path], { cwd: projectRoot });
  }
  await execute("git", [
    "archive",
    "--format=tar",
    `--output=${archive}`,
    "HEAD",
    ...runtimeFiles,
  ], { cwd: projectRoot });
  const { stdout: archiveListing } = await execute("tar", ["-tf", archive]);
  const archivePaths = archiveListing.split(/\r?\n/).filter(Boolean);
  assert.ok(archivePaths.length >= runtimeFiles.length);
  for (const path of archivePaths) {
    assert.equal(path.split("/").includes("node_modules"), false, `${path} must not ship`);
    assert.equal(path.split("/").includes(".git"), false, `${path} must not ship`);
  }
  await execute("tar", ["-xf", archive, "-C", artifact]);
  await writeFile(join(repository, "main.go"), "package sample\n\nfunc ready() bool { return true }\n");
  await writeFile(join(repository, "go.mod"), "module example.com/project\n\ngo 1.24\n");
  await writeFile(input, `${JSON.stringify({ source: { path: repository } })}\n`);

  const bundle = await readFile(entrypoint, "utf8");
  assert.doesNotMatch(bundle, /from\s+["'](?:@adversarylabs\/sdk|web-tree-sitter)["']/);
  for (const path of runtimeFiles.filter((path) => !path.endsWith(".wasm"))) {
    const content = await readFile(join(artifact, path), "utf8");
    assert.doesNotMatch(content, /\/Users\/[^/\s]+|\/private\/tmp\/|[A-Za-z]:\\Users\\/);
  }
  const notices = await readFile(join(artifact, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.deepEqual([...notices.matchAll(/^## (.+?) \(/gm)].map((match) => match[1]), [
    "@adversarylabs/sdk",
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "tree-sitter-go",
    "web-tree-sitter",
    "yaml",
  ]);
  assert.match(notices, /Permission is hereby granted/);
  assert.match(notices, /Redistribution and use in source and binary forms/);
  assert.match(notices, /Copyright \(c\) 2014 Max Brunsfeld/);

  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: input,
      ADVERSARY_OUTPUT: output,
      ADVERSARY_REPO: repository,
    },
  });

  const envelope = JSON.parse(await readFile(output, "utf8"));
  assert.equal(envelope.protocolVersion, 1);
  assert.equal(envelope.result.adversary.name, "go-concurrency");
  assert.equal(envelope.result.adversary.version, "0.0.26");
  assert.deepEqual(envelope.result.findings, []);

  await mkdir(join(repository, "plugins/server/internal"), { recursive: true });
  await mkdir(join(repository, "plugins/server/debug"), { recursive: true });
  await writeFile(join(repository, "plugins/server/internal/serve.go"), `package internal

import "net"

func Serve(listener net.Listener, serve func(net.Listener) error) {
  go func() {
    defer listener.Close()
    _ = serve(listener)
  }()
}
`);
  await writeFile(join(repository, "plugins/server/debug/plugin.go"), `package debug

import (
  "context"
  "net"
  "net/http"
  "example.com/project/plugins/server/internal"
)

type server struct { handler *http.Server }

func (s server) Start(ctx context.Context) error {
  listener, err := net.Listen("tcp", ":0")
  if err != nil { return err }
  internal.Serve(listener, s.handler.Serve)
  return nil
}
`);

  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: input,
      ADVERSARY_OUTPUT: output,
      ADVERSARY_REPO: repository,
    },
  });
  const detectorEnvelope = JSON.parse(await readFile(output, "utf8"));
  assert.equal(detectorEnvelope.result.adversary.version, "0.0.26");
  assert.equal(
    detectorEnvelope.result.findings.filter(
      (finding: { ruleId?: string }) => finding.ruleId === "go-concurrency.async-listener.missing-close",
    ).length,
    1,
  );
});
