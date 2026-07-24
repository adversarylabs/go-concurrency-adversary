import { type Node } from "web-tree-sitter";
import { descendants, parseGo, sourceText, walk } from "./parser.js";
import { type Analysis, type Discovery, type PositiveSignal, type Signal, type SourceRevision } from "./types.js";

export async function analyzeDiscovery(discovery: Discovery): Promise<Analysis> {
  const signals: Signal[] = [];
  const positives: PositiveSignal[] = [];
  const parseErrors: Analysis["parseErrors"] = [];

  for (const file of discovery.files) {
    try {
      const result = await analyzeFile(file);
      signals.push(...result.signals);
      positives.push(...result.positives);
    } catch (error) {
      parseErrors.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    mode: discovery.mode,
    ...(discovery.base === undefined ? {} : { base: discovery.base }),
    filesScanned: discovery.files.length,
    signals: stableSignals(signals),
    positives: stablePositives(positives),
    parseErrors,
  };
}

async function analyzeFile(file: SourceRevision): Promise<{ signals: Signal[]; positives: PositiveSignal[] }> {
  const tree = await parseGo(file.current);
  try {
    if (tree.rootNode.hasError) throw new Error("Go source contains syntax errors");
    const aliases = importAliases(tree.rootNode, file.current);
    const signals: Signal[] = [];
    const positives: PositiveSignal[] = [];
    for (const fn of [
      ...descendants(tree.rootNode, "function_declaration"),
      ...descendants(tree.rootNode, "method_declaration"),
    ]) {
      analyzeFunction(file, fn, aliases, signals, positives);
    }
    return {
      signals: signals.filter((item) => isChangedEvidence(file, item.line, item.endLine)),
      positives: positives.filter((item) => isChangedEvidence(file, item.line)),
    };
  } finally {
    tree.delete();
  }
}

function isChangedEvidence(file: SourceRevision, line: number, endLine = line): boolean {
  if (file.status === "repository" || file.status === "added") return true;
  for (let candidate = line; candidate <= endLine; candidate += 1) {
    if (file.changedLines.has(candidate)) return true;
  }
  return false;
}

function analyzeFunction(
  file: SourceRevision,
  fn: Node,
  aliases: Map<string, string>,
  signals: Signal[],
  positives: PositiveSignal[],
): void {
  const body = fn.childForFieldName("body");
  if (body === null) return;
  const syncAlias = aliases.get("sync");
  if (syncAlias !== undefined) analyzeWaitGroups(file, body, syncAlias, signals, positives);
  analyzeCancellation(file, body, aliases, signals, positives);
  analyzeChannels(file, body, signals);
}

function analyzeWaitGroups(
  file: SourceRevision,
  body: Node,
  syncAlias: string,
  signals: Signal[],
  positives: PositiveSignal[],
): void {
  const waitGroups = new Set<string>();
  for (const declaration of descendants(body, "var_spec")) {
    const type = declaration.childForFieldName("type");
    const name = declaration.childForFieldName("name");
    if (type !== null && name !== null && sourceText(type, file.current) === `${syncAlias}.WaitGroup`) {
      waitGroups.add(sourceText(name, file.current));
    }
  }
  for (const declaration of descendants(body, "short_var_declaration")) {
    const left = declaration.childForFieldName("left");
    const right = declaration.childForFieldName("right");
    const names = left?.namedChildren.map((node) => sourceText(node, file.current)) ?? [];
    const values = right?.namedChildren ?? [];
    if (names.length === 1 && values.length === 1 && sourceText(values[0]!, file.current).startsWith(`${syncAlias}.WaitGroup{`)) {
      waitGroups.add(names[0]!);
    }
  }

  for (const name of waitGroups) {
    let unsafeAdd: Node | undefined;
    for (const statement of descendants(body, "go_statement")) {
      const add = selectorCalls(statement, file.current, name, "Add")[0];
      if (add !== undefined) {
        unsafeAdd = add;
        signals.push(signal(file, add, "go-concurrency.waitgroup.lifecycle",
          `${name}.Add runs inside the goroutine it is intended to register.`,
          { waitGroup: name, operation: "Add", placement: "inside-goroutine" }));
      }
    }
    if (unsafeAdd === undefined && hasOrderedWaitGroupLifecycle(body, file.current, name)) {
      const add = selectorCalls(body, file.current, name, "Add")[0];
      if (add !== undefined) {
        positives.push({
          key: "go-concurrency.waitgroup-ordered",
          path: file.path,
          line: add.startPosition.row + 1,
          summary: `The ${name} WaitGroup registers work before launch, defers Done in the worker, and waits after launch.`,
        });
      }
    }
  }
}

function hasOrderedWaitGroupLifecycle(body: Node, source: string, name: string): boolean {
  const add = selectorCalls(body, source, name, "Add")[0];
  const wait = selectorCalls(body, source, name, "Wait")[0];
  const go = descendants(body, "go_statement").find((statement) => selectorCalls(statement, source, name, "Done").length > 0);
  return add !== undefined && go !== undefined && wait !== undefined &&
    add.startIndex < go.startIndex && go.startIndex < wait.startIndex;
}

function analyzeCancellation(
  file: SourceRevision,
  body: Node,
  aliases: Map<string, string>,
  signals: Signal[],
  positives: PositiveSignal[],
): void {
  const contextAlias = aliases.get("context");
  const errgroupAlias = aliases.get("golang.org/x/sync/errgroup");
  const helpers = new Map<string, { kind: "cancel" | "errgroup"; helper: string }>();
  for (const helper of ["WithCancel", "WithCancelCause", "WithDeadline", "WithDeadlineCause", "WithTimeout", "WithTimeoutCause"]) {
    if (contextAlias !== undefined) helpers.set(`${contextAlias}.${helper}`, { kind: "cancel", helper });
  }
  if (errgroupAlias !== undefined) helpers.set(`${errgroupAlias}.WithContext`, { kind: "errgroup", helper: "WithContext" });

  for (const assignment of [
    ...descendants(body, "short_var_declaration"),
    ...descendants(body, "assignment_statement"),
  ]) {
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    const names = left?.namedChildren.map((node) => sourceText(node, file.current)) ?? [];
    const values = right?.namedChildren ?? [];
    if (names.length < 2 || values.length !== 1) continue;
    const call = values[0]!;
    if (call.type !== "call_expression") continue;
    const functionNode = call.childForFieldName("function");
    if (functionNode === null) continue;
    const helper = helpers.get(sourceText(functionNode, file.current));
    if (helper === undefined) continue;

    const lifecycleName = names[1]!;
    if (lifecycleName === "_") {
      const message = helper.kind === "cancel"
        ? `${sourceText(functionNode, file.current)} discards its cancellation function.`
        : `${sourceText(functionNode, file.current)} discards the derived context used to propagate peer failure.`;
      signals.push(signal(file, assignment, "go-concurrency.context.cancellation", message, {
        helper: helper.helper,
        discarded: helper.kind === "cancel" ? "cancel-function" : "derived-context",
      }));
    } else if (helper.kind === "cancel" && callsIdentifier(body, file.current, lifecycleName)) {
      positives.push({
        key: "go-concurrency.cancellation-owned",
        path: file.path,
        line: assignment.startPosition.row + 1,
        summary: `${sourceText(functionNode, file.current)} retains and invokes ${lifecycleName}.`,
      });
    }
  }
}

function analyzeChannels(file: SourceRevision, body: Node, signals: Signal[]): void {
  const statementLists = descendants(body, "statement_list");
  for (const list of statementLists) {
    const statements = list.namedChildren;
    for (let index = 0; index < statements.length; index += 1) {
      const declaration = unbufferedChannelDeclaration(statements[index]!, file.current);
      if (declaration === undefined) continue;
      for (let cursor = index + 1; cursor < statements.length; cursor += 1) {
        const statement = statements[cursor]!;
        if (!containsIdentifier(statement, file.current, declaration.name)) continue;
        const operation = directBlockingOperation(statement, file.current, declaration.name);
        if (operation !== undefined) {
          signals.push(signal(file, operation.node, "go-concurrency.channel.self-deadlock",
            `The locally owned unbuffered channel ${declaration.name} is used synchronously before any peer can run.`,
            { channel: declaration.name, operation: operation.kind, capacity: 0 }));
        }
        break;
      }
    }
  }
}

function unbufferedChannelDeclaration(statement: Node, source: string): { name: string } | undefined {
  if (statement.type !== "short_var_declaration") return undefined;
  const left = statement.childForFieldName("left");
  const right = statement.childForFieldName("right");
  const names = left?.namedChildren ?? [];
  const values = right?.namedChildren ?? [];
  if (names.length !== 1 || values.length !== 1 || values[0]?.type !== "call_expression") return undefined;
  const call = values[0]!;
  if (sourceText(call.childForFieldName("function") ?? call, source) !== "make") return undefined;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (args[0]?.type !== "channel_type") return undefined;
  if (args.length > 2 || (args.length === 2 && sourceText(args[1]!, source) !== "0")) return undefined;
  return { name: sourceText(names[0]!, source) };
}

function directBlockingOperation(
  statement: Node,
  source: string,
  channel: string,
): { node: Node; kind: "send" | "receive" } | undefined {
  if (statement.type === "send_statement") {
    const target = statement.childForFieldName("channel");
    if (target !== null && sourceText(target, source) === channel) return { node: statement, kind: "send" };
  }
  if (!["expression_statement", "short_var_declaration", "assignment_statement", "return_statement"].includes(statement.type)) {
    return undefined;
  }
  const receive = descendants(statement, "unary_expression").find((node) => {
    const operand = node.childForFieldName("operand");
    return operand !== null &&
      sourceText(operand, source) === channel &&
      sourceText(node, source).startsWith("<-") &&
      !hasNestedFunctionAncestor(node, statement);
  });
  return receive === undefined ? undefined : { node: receive, kind: "receive" };
}

function hasNestedFunctionAncestor(node: Node, boundary: Node): boolean {
  let current = node.parent;
  while (current !== null && current.id !== boundary.id) {
    if (current.type === "func_literal" || current.type === "go_statement") return true;
    current = current.parent;
  }
  return false;
}

function selectorCalls(node: Node, source: string, receiver: string, field: string): Node[] {
  return descendants(node, "call_expression").filter((call) => {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return false;
    const operand = fn.childForFieldName("operand");
    const selected = fn.childForFieldName("field");
    return operand !== null && selected !== null &&
      sourceText(operand, source) === receiver && sourceText(selected, source) === field;
  });
}

function callsIdentifier(node: Node, source: string, name: string): boolean {
  return descendants(node, "call_expression").some((call) => {
    const fn = call.childForFieldName("function");
    return fn?.type === "identifier" && sourceText(fn, source) === name;
  });
}

function containsIdentifier(node: Node, source: string, name: string): boolean {
  let found = false;
  walk(node, (candidate) => {
    if (candidate.type === "identifier" && sourceText(candidate, source) === name) found = true;
  });
  return found;
}

function importAliases(root: Node, source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const spec of descendants(root, "import_spec")) {
    const text = sourceText(spec, source).trim();
    const match = /^(?:(\.|_|[A-Za-z_]\w*)\s+)?["`]([^"`]+)["`]$/.exec(text);
    if (match === null || match[1] === "_" || match[1] === ".") continue;
    const path = match[2]!;
    result.set(path, match[1] ?? path.split("/").at(-1)!);
  }
  return result;
}

function signal(
  file: SourceRevision,
  node: Node,
  ruleId: Signal["ruleId"],
  message: string,
  data: Record<string, unknown>,
): Signal {
  const line = node.startPosition.row + 1;
  return {
    ruleId,
    path: file.path,
    line,
    ...(node.endPosition.row > node.startPosition.row ? { endLine: node.endPosition.row + 1 } : {}),
    message,
    snippet: file.current.split("\n")[line - 1]?.trim() ?? "",
    data,
  };
}

function stableSignals(signals: Signal[]): Signal[] {
  return signals.sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.ruleId.localeCompare(right.ruleId));
}

function stablePositives(positives: PositiveSignal[]): PositiveSignal[] {
  const seen = new Set<string>();
  return positives
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.key.localeCompare(right.key))
    .filter((positive) => {
      const key = `${positive.key}:${positive.path}:${positive.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
