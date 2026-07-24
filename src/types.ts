export interface SourceRevision {
  path: string;
  current: string;
  changedLines: Set<number>;
  status: "added" | "modified" | "repository";
}

export interface Discovery {
  mode: "diff" | "repository";
  base?: string;
  files: SourceRevision[];
}

export interface Signal {
  ruleId:
    | "go-concurrency.waitgroup.lifecycle"
    | "go-concurrency.context.cancellation"
    | "go-concurrency.channel.self-deadlock";
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
  signals: Signal[];
  positives: PositiveSignal[];
  parseErrors: Array<{ path: string; message: string }>;
}

