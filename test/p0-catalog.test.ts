import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "../src/index.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function isolatedFixture(fixture: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-concurrency-p0-"));
  await cp(fixture, root, { recursive: true });
  return root;
}

const review = async (rel: string) => {
  const root = await isolatedFixture(join(projectRoot, "fixtures", rel));
  return createApp().run({ input: { source: { path: root } }, includeRawObservations: true });
};

test("P0 catalog concurrency rules detect vulnerable fixtures and stay quiet on clean", async () => {
  const cases = [
    { dir: "p0-waitgroup-lifecycle", id: "go-concurrency.waitgroup.lifecycle" },
    { dir: "p0-waitgroup-copied", id: "go-concurrency.waitgroup.copied" },
    { dir: "p0-mutex-copy", id: "go-concurrency.mutex.copy" },
    { dir: "p0-loopvar-capture", id: "go-concurrency.loopvar.capture" },
    { dir: "p0-context-cancellation", id: "go-concurrency.context.cancellation" },
    { dir: "p0-select-default-busy", id: "go-concurrency.select.default-busy" },
    { dir: "p0-ticker-not-stopped", id: "go-concurrency.ticker.not-stopped" },
    { dir: "p0-timer-not-stopped", id: "go-concurrency.timer.not-stopped" },
  ] as const;

  for (const c of cases) {
    const bad = await review(`${c.dir}/vulnerable`);
    assert.equal(
      bad.findings.some((f) => f.ruleId === c.id),
      true,
      `${c.id} missed; got ${bad.findings.map((f) => f.ruleId).join(",") || "(none)"}`,
    );
    const good = await review(`${c.dir}/clean`);
    assert.equal(
      good.findings.some((f) => f.ruleId === c.id),
      false,
      `${c.id} flagged clean; got ${good.findings.map((f) => f.ruleId).join(",") || "(none)"}`,
    );
  }
});

test("timer.not-stopped is reported on the vulnerable fixture", async () => {
  const legacy = await review("p0-timer-not-stopped/vulnerable");
  const legacyFinding = legacy.findings.find((f) => f.ruleId === "go-concurrency.timer.not-stopped");
  assert.ok(legacyFinding, "expected timer.not-stopped finding");
  assert.ok(
    legacyFinding.severity === "medium" || legacyFinding.severity === "low",
    `unexpected severity ${legacyFinding.severity}`,
  );
});

test("terrible fixture still reports waitgroup.lifecycle and context.cancellation", async () => {
  const output = await review("terrible");
  const ids = new Set(output.findings.map((f) => f.ruleId));
  assert.ok(ids.has("go-concurrency.waitgroup.lifecycle"));
  assert.ok(ids.has("go-concurrency.context.cancellation"));
  assert.ok(ids.has("go-concurrency.channel.self-deadlock"));
});
