import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangeContext, RuleContext } from "@adversarylabs/sdk";
import { type Discovery, type SourceRevision } from "./types.js";

const MAX_FILE_BYTES = 750_000;
const MAX_FILES = 750;
const execute = promisify(execFile);

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
  const files: SourceRevision[] = [];
  for (const source of sources) {
    if (wholeTarget || source.status === "repository") {
      files.push({
        path: source.path,
        current: source.content,
        changedLines: new Set<number>(),
        status: "repository",
      });
      continue;
    }

    const change = await changedSource(ctx.repoPath, ctx.change, source.path);
    files.push({
      path: source.path,
      current: source.content,
      changedLines: change.changedLines,
      status: change.status,
    });
  }

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
  const files: SourceRevision[] = [];
  for (const source of sources) {
    if (wholeTarget || source.status === "repository") {
      files.push({
        path: source.path,
        current: source.content,
        changedLines: new Set<number>(),
        status: "repository",
      });
      continue;
    }

    const sourceChange = await changedSource(repoPath, change, source.path);
    files.push({
      path: source.path,
      current: source.content,
      changedLines: sourceChange.changedLines,
      status: sourceChange.status,
    });
  }
  return {
    mode: wholeTarget ? "repository" : "diff",
    ...(change?.baseRef === undefined ? {} : { base: change.baseRef }),
    files,
  };
}

async function changedSource(
  repoPath: string,
  change: ChangeContext | null,
  path: string,
): Promise<Pick<SourceRevision, "changedLines" | "status">> {
  const base = change?.baseRef;
  if (base === undefined || !(await existsAtRevision(repoPath, base, path))) {
    return { changedLines: new Set<number>(), status: "added" };
  }

  const args = ["diff", "--unified=0", base];
  const head = change?.headRef;
  if (head !== undefined && !change?.worktree) args.push(head);
  args.push("--", path);
  const patch = await gitOutput(repoPath, args);
  return { changedLines: changedLineNumbers(patch), status: "modified" };
}

async function existsAtRevision(repoPath: string, revision: string, path: string): Promise<boolean> {
  try {
    await execute("git", ["-C", repoPath, "cat-file", "-e", `${revision}:${path}`], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  const result = await execute("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

function changedLineNumbers(patch: string): Set<number> {
  const lines = new Set<number>();
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line += 1) lines.add(line);
  }
  return lines;
}
