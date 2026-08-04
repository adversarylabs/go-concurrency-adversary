export interface SourceRevision {
  path: string;
  current: string;
  changedLines: Set<number>;
  status: "added" | "modified" | "repository";
}

export interface GoVersion {
  major: number;
  minor: number;
}

export interface Discovery {
  mode: "diff" | "repository";
  base?: string;
  files: SourceRevision[];
  goVersion?: GoVersion;
}

export interface Signal {
  ruleId:
    | "go-concurrency.waitgroup.lifecycle"
    | "go-concurrency.waitgroup.copied"
    | "go-concurrency.mutex.copy"
    | "go-concurrency.loopvar.capture"
    | "go-concurrency.context.cancellation"
    | "go-concurrency.select.default-busy"
    | "go-concurrency.ticker.not-stopped"
    | "go-concurrency.timer.not-stopped"
    | "go-concurrency.channel.self-deadlock"
    | "go-concurrency.concurrent-api.missing-test";
  path: string;
  line: number;
  endLine?: number;
  message: string;
  snippet: string;
  data: Record<string, unknown>;
}

export interface PositiveSignal {
  key: "go-concurrency.cancellation-owned" | "go-concurrency.waitgroup-ordered";
  path: string;
  line: number;
  summary: string;
}

export interface Analysis {
  mode: Discovery["mode"];
  base?: string;
  filesScanned: number;
  goVersion?: GoVersion;
  signals: Signal[];
  positives: PositiveSignal[];
  parseErrors: Array<{ path: string; message: string }>;
}
