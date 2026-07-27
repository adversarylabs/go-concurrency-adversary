import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModelUnavailableError,
  type ModelReviewRequest,
  type ReviewModel,
} from "@adversarylabs/sdk";
import { createApp } from "../src/index.ts";
import {
  GO_CONCURRENCY_MODEL_PROMPT,
  GO_CONCURRENCY_MODEL_SCHEMA,
} from "../src/model-review.ts";

function unavailableModel(): ReviewModel {
  return {
    async review() {
      throw new ModelUnavailableError("no broker");
    },
  };
}

function capturingModel(output: unknown): ReviewModel & { requests: ModelReviewRequest[] } {
  const requests: ModelReviewRequest[] = [];
  return {
    requests,
    async review<T>(request: ModelReviewRequest) {
      requests.push(request);
      const schema = request.schema as { required?: string[] };
      if (Array.isArray(schema.required) && schema.required.includes("concern")) {
        return { output: { concern: "WaitGroup registration races" } as T, provider: "f", model: "c" };
      }
      return { output: output as T, provider: "f", model: "t" };
    },
  };
}

async function writeRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-model-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

const badWaitGroup = `package main
import "sync"
func f() {
  var wg sync.WaitGroup
  go func() {
    wg.Add(1)
    defer wg.Done()
  }()
  wg.Wait()
}
`;

test("static findings remain when model unavailable", async () => {
  const root = await writeRoot({ "main.go": badWaitGroup });
  const result = await createApp().run({ model: unavailableModel(), input: { source: { path: root } } });
  assert.ok(result.findings.some((f) => (f.ruleId ?? "").includes("waitgroup") || result.assessment?.risk !== "none"));
  assert.equal(result.opinion?.ship, false);
});

test("injected model path is invoked with catalog", async () => {
  const root = await writeRoot({ "main.go": badWaitGroup });
  const model = capturingModel({
    assessment: { risk: "high", summary: "WaitGroup lifecycle is unsafe." },
    ship: true,
    primaryConcern: "WaitGroup registration races",
    observations: [],
  });
  const result = await createApp().run({ model, input: { source: { path: root } } });
  assert.ok(model.requests.length >= 1);
  const req = model.requests.find((r) => {
    const schema = r.schema as { required?: string[] };
    return !(Array.isArray(schema.required) && schema.required.includes("concern"));
  })!;
  assert.equal(req.prompt, GO_CONCURRENCY_MODEL_PROMPT);
  assert.deepEqual(req.schema, GO_CONCURRENCY_MODEL_SCHEMA);
  assert.equal((req.input as { domain: string }).domain, "go-concurrency");
  assert.equal(result.opinion?.ship, false);
});
