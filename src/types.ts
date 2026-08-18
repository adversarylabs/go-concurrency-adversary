export interface SourceRevision {
  path: string;
  current: string;
  previous?: string;
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
    | "go-concurrency.context.background-in-request"
    | "go-concurrency.context.error-classification"
    | "go-concurrency.context.stored-on-struct"
    | "go-concurrency.select.default-busy"
    | "go-concurrency.ticker.not-stopped"
    | "go-concurrency.timer.not-stopped"
    | "go-concurrency.channel.self-deadlock"
    | "go-concurrency.waitgroup.done-not-deferred"
    | "go-concurrency.atomic-capacity-check-update"
    | "go-concurrency.goroutine-id-state-key"
    | "go-concurrency.async-listener.missing-shutdown"
    | "go-concurrency.external-state-marker-before-success"
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
