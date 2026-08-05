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
    ...(discovery.goVersion === undefined ? {} : { goVersion: discovery.goVersion }),
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
    if (file.path.endsWith("_test.go")) {
      analyzeMissingSerializationTest(file, tree.rootNode, signals);
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
  const syncAlias = aliases.get("sync");
  analyzeCopyLocks(file, fn, syncAlias, signals);
  if (body === null) return;
  if (syncAlias !== undefined) analyzeWaitGroups(file, body, syncAlias, signals, positives);
  analyzeCancellation(file, body, aliases, signals, positives);
  analyzeChannels(file, body, signals);
  analyzeLoopVarCapture(file, body, signals);
  analyzeSelectDefaultBusy(file, body, signals);
  analyzeTickers(file, fn, body, aliases, signals);
  analyzeTimers(file, body, aliases, signals);
}

function analyzeCopyLocks(
  file: SourceRevision,
  fn: Node,
  syncAlias: string | undefined,
  signals: Signal[],
): void {
  if (syncAlias === undefined) return;
  const waitGroupType = `${syncAlias}.WaitGroup`;
  const mutexTypes = new Set([`${syncAlias}.Mutex`, `${syncAlias}.RWMutex`]);

  for (const parameter of parameterDeclarations(fn)) {
    const typeNode = parameter.childForFieldName("type");
    if (typeNode === null) continue;
    const typeText = sourceText(typeNode, file.current);
    if (typeText === waitGroupType) {
      const name = parameter.childForFieldName("name");
      signals.push(signal(file, parameter, "go-concurrency.waitgroup.copied",
        `WaitGroup is passed by value${name === null ? "" : ` as parameter ${sourceText(name, file.current)}`}; copies break Add/Done/Wait counter sharing.`,
        { type: waitGroupType, form: "parameter" }));
    } else if (mutexTypes.has(typeText)) {
      const name = parameter.childForFieldName("name");
      signals.push(signal(file, parameter, "go-concurrency.mutex.copy",
        `${typeText} is passed by value${name === null ? "" : ` as parameter ${sourceText(name, file.current)}`}; mutex copies unlock independently of the original.`,
        { type: typeText, form: "parameter" }));
    }
  }

  const body = fn.childForFieldName("body");
  if (body === null) return;

  const mutexNames = new Set<string>();
  for (const parameter of parameterDeclarations(fn)) {
    const typeNode = parameter.childForFieldName("type");
    const nameNode = parameter.childForFieldName("name");
    if (typeNode === null || nameNode === null) continue;
    if (mutexTypes.has(sourceText(typeNode, file.current))) {
      mutexNames.add(sourceText(nameNode, file.current));
    }
  }
  for (const declaration of descendants(body, "var_spec")) {
    const type = declaration.childForFieldName("type");
    const name = declaration.childForFieldName("name");
    if (type !== null && name !== null && mutexTypes.has(sourceText(type, file.current))) {
      mutexNames.add(sourceText(name, file.current));
    }
  }
  for (const declaration of descendants(body, "short_var_declaration")) {
    const left = declaration.childForFieldName("left");
    const right = declaration.childForFieldName("right");
    const names = left?.namedChildren.map((node) => sourceText(node, file.current)) ?? [];
    const values = right?.namedChildren ?? [];
    if (names.length === 1 && values.length === 1) {
      const valueText = sourceText(values[0]!, file.current);
      if (mutexTypes.has(valueText) || [...mutexTypes].some((type) => valueText.startsWith(`${type}{`))) {
        mutexNames.add(names[0]!);
      }
    }
  }

  for (const declaration of descendants(body, "short_var_declaration")) {
    const left = declaration.childForFieldName("left");
    const right = declaration.childForFieldName("right");
    const names = left?.namedChildren.map((node) => sourceText(node, file.current)) ?? [];
    const values = right?.namedChildren ?? [];
    if (names.length !== 1 || values.length !== 1) continue;
    const value = values[0]!;
    if (value.type !== "identifier") continue;
    const sourceName = sourceText(value, file.current);
    if (!mutexNames.has(sourceName)) continue;
    signals.push(signal(file, declaration, "go-concurrency.mutex.copy",
      `Mutex value ${sourceName} is copied into ${names[0]!}; copies unlock independently of the original.`,
      { form: "assignment", from: sourceName, to: names[0]! }));
    mutexNames.add(names[0]!);
  }

  for (const assignment of descendants(body, "assignment_statement")) {
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    const names = left?.namedChildren.map((node) => sourceText(node, file.current)) ?? [];
    const values = right?.namedChildren ?? [];
    if (names.length !== 1 || values.length !== 1) continue;
    const value = values[0]!;
    if (value.type !== "identifier") continue;
    const sourceName = sourceText(value, file.current);
    if (!mutexNames.has(sourceName)) continue;
    signals.push(signal(file, assignment, "go-concurrency.mutex.copy",
      `Mutex value ${sourceName} is copied into ${names[0]!}; copies unlock independently of the original.`,
      { form: "assignment", from: sourceName, to: names[0]! }));
  }
}

function parameterDeclarations(fn: Node): Node[] {
  const list = fn.childForFieldName("parameters");
  if (list === null) return [];
  return list.namedChildren.filter((node) => node.type === "parameter_declaration");
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
    } else if (helper.kind === "cancel" && !identifierUsedOutsideBinding(body, file.current, lifecycleName, left)) {
      signals.push(signal(file, assignment, "go-concurrency.context.cancellation",
        `${sourceText(functionNode, file.current)} retains ${lifecycleName} but never uses it; the cancel function is never invoked.`,
        { helper: helper.helper, discarded: "cancel-function-unused" }));
    }
  }
}

function identifierUsedOutsideBinding(
  body: Node,
  source: string,
  name: string,
  bindingLeft: Node | null,
): boolean {
  let used = false;
  walk(body, (candidate) => {
    if (used || candidate.type !== "identifier") return;
    if (sourceText(candidate, source) !== name) return;
    if (bindingLeft !== null && isDescendantOf(candidate, bindingLeft)) return;
    used = true;
  });
  return used;
}

function isDescendantOf(node: Node, ancestor: Node): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (current.id === ancestor.id) return true;
    current = current.parent;
  }
  return false;
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

function analyzeLoopVarCapture(file: SourceRevision, body: Node, signals: Signal[]): void {
  for (const forStatement of descendants(body, "for_statement")) {
    const loopVars = loopVariableNames(forStatement, file.current);
    if (loopVars.size === 0) continue;
    const forBody = forStatement.childForFieldName("body") ?? forStatement.namedChildren.find((node) => node.type === "block");
    if (forBody === undefined || forBody === null) continue;
    const statements = forBody.namedChildren.find((node) => node.type === "statement_list")?.namedChildren
      ?? forBody.namedChildren;

    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]!;
      if (statement.type !== "go_statement") continue;
      const call = statement.namedChildren.find((node) => node.type === "call_expression");
      const literal = call?.childForFieldName("function");
      if (literal === undefined || literal === null || literal.type !== "func_literal") continue;

      const paramNames = new Set(
        descendants(literal.childForFieldName("parameters") ?? literal, "parameter_declaration")
          .flatMap((parameter) => parameter.namedChildren
            .filter((node) => node.type === "identifier")
            .map((node) => sourceText(node, file.current))),
      );

      const previous = index > 0 ? statements[index - 1] : undefined;
      const shadowed = previous === undefined ? new Set<string>() : shadowingNames(previous, file.current, loopVars);

      for (const loopVar of loopVars) {
        if (paramNames.has(loopVar) || shadowed.has(loopVar)) continue;
        if (!containsIdentifier(literal, file.current, loopVar)) continue;
        signals.push(signal(file, statement, "go-concurrency.loopvar.capture",
          `Goroutine closes over loop variable ${loopVar} without shadowing or binding it as a parameter.`,
          { variable: loopVar, form: "go-func" }));
        break;
      }
    }
  }
}

function loopVariableNames(forStatement: Node, source: string): Set<string> {
  const names = new Set<string>();
  const rangeClause = forStatement.namedChildren.find((node) => node.type === "range_clause");
  if (rangeClause !== undefined) {
    const left = rangeClause.childForFieldName("left") ?? rangeClause.namedChildren.find((node) => node.type === "expression_list");
    for (const child of left?.namedChildren ?? []) {
      if (child.type === "identifier") {
        const name = sourceText(child, source);
        if (name !== "_") names.add(name);
      }
    }
    return names;
  }
  const forClause = forStatement.namedChildren.find((node) => node.type === "for_clause");
  if (forClause !== undefined) {
    const init = forClause.childForFieldName("initializer") ?? forClause.namedChildren[0];
    if (init?.type === "short_var_declaration") {
      const left = init.childForFieldName("left");
      for (const child of left?.namedChildren ?? []) {
        if (child.type === "identifier") {
          const name = sourceText(child, source);
          if (name !== "_") names.add(name);
        }
      }
    }
  }
  return names;
}

function shadowingNames(statement: Node, source: string, loopVars: Set<string>): Set<string> {
  const shadowed = new Set<string>();
  if (statement.type !== "short_var_declaration") return shadowed;
  const left = statement.childForFieldName("left");
  const right = statement.childForFieldName("right");
  const names = left?.namedChildren.map((node) => sourceText(node, source)) ?? [];
  const values = right?.namedChildren.map((node) => sourceText(node, source)) ?? [];
  if (names.length !== values.length) return shadowed;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    if (loopVars.has(name) && values[index] === name) shadowed.add(name);
  }
  return shadowed;
}

function analyzeSelectDefaultBusy(file: SourceRevision, body: Node, signals: Signal[]): void {
  for (const forStatement of descendants(body, "for_statement")) {
    const forBody = forStatement.namedChildren.find((node) => node.type === "block");
    if (forBody === undefined) continue;
    const statements = forBody.namedChildren.find((node) => node.type === "statement_list")?.namedChildren ?? [];
    // High precision: loop body is a single select with only default (no communication cases).
    if (statements.length !== 1 || statements[0]?.type !== "select_statement") continue;
    const selectNode = statements[0]!;
    const cases = selectNode.namedChildren.filter((node) =>
      node.type === "default_case" || node.type === "communication_case");
    if (cases.length === 0) continue;
    if (cases.some((node) => node.type === "communication_case")) continue;
    if (!cases.every((node) => node.type === "default_case")) continue;
    signals.push(signal(file, selectNode, "go-concurrency.select.default-busy",
      "Loop body is a select with only a default case, which busy-spins the CPU.",
      { form: "for-select-default" }));
  }
}

function analyzeTickers(
  file: SourceRevision,
  fn: Node,
  body: Node,
  aliases: Map<string, string>,
  signals: Signal[],
): void {
  const timeAlias = aliases.get("time");
  if (timeAlias === undefined) return;
  const functionName = functionNameOf(fn, file.current);

  for (const call of descendants(body, "call_expression")) {
    const functionNode = call.childForFieldName("function");
    if (functionNode === null) continue;
    const callee = sourceText(functionNode, file.current);
    if (callee === `${timeAlias}.Tick`) {
      signals.push(signal(file, call, "go-concurrency.ticker.not-stopped",
        `${callee} cannot be stopped and leaks a ticker for the process lifetime.`,
        { helper: "Tick" }));
    }
  }

  // Process-lifetime tickers in main are an accepted FP class.
  if (functionName === "main") return;

  const tickerNames = new Map<string, Node>();
  for (const declaration of [
    ...descendants(body, "short_var_declaration"),
    ...descendants(body, "assignment_statement"),
  ]) {
    const left = declaration.childForFieldName("left");
    const right = declaration.childForFieldName("right");
    const names = left?.namedChildren.map((node) => sourceText(node, file.current)) ?? [];
    const values = right?.namedChildren ?? [];
    if (names.length !== 1 || values.length !== 1) continue;
    const value = values[0]!;
    if (value.type !== "call_expression") continue;
    const functionNode = value.childForFieldName("function");
    if (functionNode === null) continue;
    if (sourceText(functionNode, file.current) !== `${timeAlias}.NewTicker`) continue;
    tickerNames.set(names[0]!, value);
  }

  for (const [name, node] of tickerNames) {
    if (selectorCalls(body, file.current, name, "Stop").length > 0) continue;
    signals.push(signal(file, node, "go-concurrency.ticker.not-stopped",
      `${timeAlias}.NewTicker result ${name} is never Stopped in this function.`,
      { helper: "NewTicker", ticker: name }));
  }
}

function analyzeTimers(
  file: SourceRevision,
  body: Node,
  aliases: Map<string, string>,
  signals: Signal[],
): void {
  const timeAlias = aliases.get("time");
  if (timeAlias === undefined) return;

  for (const forStatement of descendants(body, "for_statement")) {
    for (const call of descendants(forStatement, "call_expression")) {
      const functionNode = call.childForFieldName("function");
      if (functionNode === null) continue;
      if (sourceText(functionNode, file.current) !== `${timeAlias}.After`) continue;
      // Ignore After inside nested function literals launched from the loop.
      if (hasNestedFunctionAncestor(call, forStatement)) continue;
      signals.push(signal(file, call, "go-concurrency.timer.not-stopped",
        `${timeAlias}.After inside a loop allocates a timer each iteration; prefer NewTimer with Stop/Reset.`,
        { helper: "After", form: "in-loop" }));
    }
  }
}

function functionNameOf(fn: Node, source: string): string | undefined {
  if (fn.type === "function_declaration") {
    const name = fn.childForFieldName("name");
    return name === null ? undefined : sourceText(name, source);
  }
  if (fn.type === "method_declaration") {
    const name = fn.childForFieldName("name");
    return name === null ? undefined : sourceText(name, source);
  }
  return undefined;
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

function findEnclosingFunction(node: Node | null): Node | null {
  let cur: Node | null = node;
  while (cur !== null) {
    if (cur.type === "function_declaration" || cur.type === "method_declaration") {
      return cur;
    }
    cur = cur.parent ?? null;
  }
  return null;
}

function hasSerializationProofInFunc(fn: Node, source: string): boolean {
  const body = fn.childForFieldName("body");
  if (body === null) return false;

  const bodyText = sourceText(body, source);
  const lower = bodyText.toLowerCase().replace(/\s+/g, "");

  // Require a real active concurrency counter: atomic add on an "active" variable
  // *plus* a max-concurrency check on the Add result (>1).
  const hasActiveAdd = /atomic\.(AddInt32|AddInt64)\s*\([^)]*active/.test(bodyText);
  // Match common patterns: Add...active...) > 1   or  Add... > 1
  const hasMaxCheck = /Add(Int32|Int64)?\s*\([^)]*active[^)]*\)\s*[>]=?\s*1/.test(bodyText) ||
                      />\s*1/.test(bodyText) && /Add.*active/.test(bodyText) ||
                      lower.includes("active>1") || lower.includes("active>=2");

  if (hasActiveAdd && hasMaxCheck) return true;

  // Or an explicit failure inside the test that asserts no overlap/serialization violation.
  // To avoid over-acceptance, only accept assert-style proof if there is also evidence
  // of an active counter in the same Test func.
  const hasAssertWithKeyword = (() => {
    const calls = descendants(body, "call_expression");
    for (const call of calls) {
      const fnNode = call.childForFieldName("function");
      if (fnNode === null) continue;
      const callText = sourceText(call, source).toLowerCase();
      const fnText = sourceText(fnNode, source).toLowerCase();
      if ((fnText.includes("error") || fnText.includes("fatal") || fnText.includes("assert")) &&
          (callText.includes("concurrent") || callText.includes("overlap") || callText.includes("serial"))) {
        return true;
      }
    }
    return false;
  })();

  if (hasActiveAdd && hasAssertWithKeyword) return true;

  return false;
}

function analyzeMissingSerializationTest(file: SourceRevision, root: Node, signals: Signal[]): void {
  const source = file.current;
  const LIFECYCLE = new Set(["Export", "ForceFlush", "Shutdown", "OnEmit"]);

  // Look for go statements that invoke lifecycle methods concurrently.
  // Group by enclosing Test* function so that independent tests do not interfere.
  const goStmts = descendants(root, "go_statement");
  const launchesByTest = new Map<string, {fn: Node, launches: Node[]}>();

  for (const goStmt of goStmts) {
    for (const call of descendants(goStmt, "call_expression")) {
      const fnNode = call.childForFieldName("function");
      if (fnNode?.type === "selector_expression") {
        const selected = fnNode.childForFieldName("field");
        if (selected && LIFECYCLE.has(sourceText(selected, source))) {
          const testFn = findEnclosingFunction(goStmt);
          if (testFn !== null) {
            const nameNode = testFn.childForFieldName("name");
            const testName = nameNode ? sourceText(nameNode, source) : "";
            if (testName.startsWith("Test")) {
              if (!launchesByTest.has(testName)) {
                launchesByTest.set(testName, {fn: testFn, launches: []});
              }
              launchesByTest.get(testName)!.launches.push(goStmt);
              break;
            }
          }
        }
      }
    }
  }

  for (const entry of launchesByTest.values()) {
    const {fn: testFn, launches} = entry;
    if (launches.length < 2) continue;
    if (hasSerializationProofInFunc(testFn, source)) continue;

    // Emit one finding per failing Test, using the first launch site in that test as evidence
    const evidenceNode = launches[0]!;
    signals.push(signal(file, evidenceNode, "go-concurrency.concurrent-api.missing-test",
      "Test races concurrent calls to lifecycle API (Export/ForceFlush/Shutdown-style) but lacks active-call counter or max-concurrency assertion proving the serialization guarantee.",
      { form: "missing-serialization-test" }));
  }
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
