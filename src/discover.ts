import type { ChangeContext, RuleContext } from "@adversarylabs/sdk";
import { type Discovery, type SourceRevision } from "./types.js";

const MAX_FILE_BYTES = 750_000;
const MAX_FILES = 750;

function includePath(path: string): boolean {
  return path.endsWith(".go");
}

export async function discoverSources(ctx: RuleContext): Promise<Discovery> {
  const sources = await ctx.loadInScopeSources({
    include: includePath,
    limit: MAX_FILES,
    maxBytes: MAX_FILE_BYTES,
  });

  const wholeTarget = ctx.change === null || ctx.change.scanMode === "all";
  const files: SourceRevision[] = sources.map((source) => ({
    path: source.path,
    current: source.content,
    changedLines: new Set<number>(),
    status: source.status === "repository" ? "repository" : "added",
  }));

  return {
    mode: wholeTarget ? "repository" : "diff",
    ...(ctx.change?.baseRef === undefined ? {} : { base: ctx.change.baseRef }),
    files,
  };
}

/** @deprecated use discoverSources(ctx) */
export async function discoverGoSources(
  repoPath: string,
  change: ChangeContext | null,
): Promise<Discovery> {
  // Fallback adapter for old call sites — prefer RuleContext form.
  const { loadInScopeSources } = await import("@adversarylabs/sdk");
  const sources = await loadInScopeSources(repoPath, change, {
    include: includePath,
    limit: MAX_FILES,
    maxBytes: MAX_FILE_BYTES,
  });
  const wholeTarget = change === null || change.scanMode === "all";
  return {
    mode: wholeTarget ? "repository" : "diff",
    ...(change?.baseRef === undefined ? {} : { base: change.baseRef }),
    files: sources.map((source) => ({
      path: source.path,
      current: source.content,
      changedLines: new Set<number>(),
      status: source.status === "repository" ? "repository" : "added",
    })),
  };
}
