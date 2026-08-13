#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Adversary } from "@adversarylabs/sdk";
import { analyzeDiscovery } from "./analyze.js";
import { discoverSources } from "./discover.js";
import { reviewConcurrency } from "./review.js";

export function createApp(): Adversary {
  const app = new Adversary({
    name: "go-concurrency",
    version: "0.0.17",
    review: { maximumFindings: 5, minimumConfidence: "medium" },
  });

  app.rule("go-concurrency.review", async (ctx) => {
    const discovery = await discoverSources(ctx);
    const analysis = await analyzeDiscovery(discovery);
    ctx.summary.files_scanned = analysis.filesScanned;
    ctx.review.observe({
      key: "go-concurrency.analysis",
      summary: analysis.mode === "diff"
        ? `Parsed ${analysis.filesScanned} changed Go files against ${analysis.base}.`
        : `Parsed ${analysis.filesScanned} Go files in repository review mode.`,
      metadata: {
        parser: "tree-sitter-go",
        mode: analysis.mode,
        parseErrors: analysis.parseErrors,
      },
    });
    await reviewConcurrency(
      ctx,
      analysis,
      discovery.files.map((file) => ({
        path: file.path,
        current: file.current,
        status: file.status,
      })),
    );
  });

  return app;
}

async function runIfDirect(): Promise<void> {
  if (
    process.argv[1] !== undefined &&
    (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
  ) {
    await createApp().runFromEnvironment();
  }
}

void runIfDirect();
