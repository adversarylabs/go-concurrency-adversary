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
    const atomicAccessors = atomicAccessorMethods(tree.rootNode, file.current, aliases);
    const signals: Signal[] = [];
    const positives: PositiveSignal[] = [];
    analyzeContextDetachment(file, tree.rootNode, aliases, signals);
    analyzeGoroutineIDStateKeys(file, tree.rootNode, aliases, signals);
    for (const fn of [
      ...descendants(tree.rootNode, "function_declaration"),
      ...descendants(tree.rootNode, "method_declaration"),
    ]) {
      analyzeFunction(file, fn, aliases, atomicAccessors, signals, positives);
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

function analyzeGoroutineIDStateKeys(
  file: SourceRevision,
  root: Node,
  aliases: Map<string, string>,
  signals: Signal[],
): void {
  if (file.path.endsWith("_test.go")) return;
  const runtimeAlias = aliases.get("runtime");
  const strconvAlias = aliases.get("strconv");
  const stringsAlias = aliases.get("strings");
  if (runtimeAlias === undefined || strconvAlias === undefined || stringsAlias === undefined) return;

  const idHelpers = goroutineIDHelpers(root, file.current, runtimeAlias, strconvAlias, stringsAlias);
  if (idHelpers.size === 0) return;

  const stateReceivers = mutableStateReceivers(root, file.current, aliases.get("sync"));
  const seen = new Set<string>();
  for (const call of descendants(root, "call_expression")) {
    const selected = selectedCall(call, file.current);
    if (selected === undefined || !["Store", "Load", "Delete"].includes(selected.field)) continue;
    if (!stateReceivers.has(receiverName(selected.operand))) continue;

    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    const key = args[0];
    if (key === undefined) continue;
    const helperCall = directHelperCall(key, file.current, idHelpers);
    if (helperCall === undefined) continue;

    const evidence = isChangedEvidence(file, key.startPosition.row + 1, key.endPosition.row + 1)
      ? key
      : changedHelperAnchor(file, helperCall.anchors);
    if (evidence === undefined) continue;
    const dedupe = `${selected.operand}:${helperCall.helper}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    signals.push(signal(file, evidence, "go-concurrency.goroutine-id-state-key",
      `${selected.operand}.${selected.field} keys mutable state with a goroutine identifier parsed from runtime.Stack text.`, {
        state: selected.operand,
        operation: selected.field,
        helper: helperCall.helper,
        parseFailure: "shared-zero-key-if-unchecked",
        form: "runtime-stack-goroutine-id-state-key",
      }));
  }

  for (const index of descendants(root, "index_expression")) {
    const operand = index.childForFieldName("operand");
    const key = index.childForFieldName("index");
    if (operand === null || key === null) continue;
    const state = sourceText(operand, file.current);
    if (!stateReceivers.has(receiverName(state))) continue;
    const helperCall = directHelperCall(key, file.current, idHelpers);
    if (helperCall === undefined) continue;
    const evidence = isChangedEvidence(file, key.startPosition.row + 1, key.endPosition.row + 1)
      ? key
      : changedHelperAnchor(file, helperCall.anchors);
    if (evidence === undefined) continue;
    const dedupe = `${state}:${helperCall.helper}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    signals.push(signal(file, evidence, "go-concurrency.goroutine-id-state-key",
      `${state} indexes mutable state with a goroutine identifier parsed from runtime.Stack text.`, {
        state,
        operation: index.parent?.type === "assignment_statement" ? "write" : "read",
        helper: helperCall.helper,
        parseFailure: "shared-zero-key-if-unchecked",
        form: "runtime-stack-goroutine-id-state-key",
      }));
  }

  for (const call of descendants(root, "call_expression")) {
    const functionNode = call.childForFieldName("function");
    if (functionNode?.type !== "identifier" || sourceText(functionNode, file.current) !== "delete") continue;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    const state = args[0];
    const key = args[1];
    if (state === undefined || key === undefined) continue;
    const stateText = sourceText(state, file.current);
    if (!stateReceivers.has(receiverName(stateText))) continue;
    const helperCall = directHelperCall(key, file.current, idHelpers);
    if (helperCall === undefined) continue;
    const evidence = isChangedEvidence(file, key.startPosition.row + 1, key.endPosition.row + 1)
      ? key
      : changedHelperAnchor(file, helperCall.anchors);
    if (evidence === undefined) continue;
    const dedupe = `${stateText}:${helperCall.helper}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    signals.push(signal(file, evidence, "go-concurrency.goroutine-id-state-key",
      `${stateText} deletes mutable state with a goroutine identifier parsed from runtime.Stack text.`, {
        state: stateText,
        operation: "delete",
        helper: helperCall.helper,
        parseFailure: "shared-zero-key-if-unchecked",
        form: "runtime-stack-goroutine-id-state-key",
      }));
  }
}

function receiverName(expression: string): string {
  return expression.split(".").at(-1) ?? expression;
}

function goroutineIDHelpers(
  root: Node,
  source: string,
  runtimeAlias: string,
  strconvAlias: string,
  stringsAlias: string,
): Map<string, Node[]> {
  const helpers = new Map<string, Node[]>();
  for (const fn of descendants(root, "function_declaration")) {
    const name = fn.childForFieldName("name");
    const body = fn.childForFieldName("body");
    if (name === null || body === null) continue;
    if ([runtimeAlias, strconvAlias, stringsAlias].some((alias) => declaresLocalIdentifier(fn, source, alias))) continue;

    const stackCalls = functionDescendants(fn, body, "call_expression").filter((call) => {
      const functionNode = call.childForFieldName("function");
      if (functionNode === null || sourceText(functionNode, source) !== `${runtimeAlias}.Stack`) return false;
      const args = call.childForFieldName("arguments")?.namedChildren ?? [];
      return args.length >= 2 && sourceText(args[1]!, source) === "false";
    });
    if (stackCalls.length !== 1) continue;
    const stackCall = stackCalls[0]!;
    const stackArgs = stackCall.childForFieldName("arguments")?.namedChildren ?? [];
    const stackBuffer = stackArgs[0] === undefined ? undefined : sliceOperandIdentifier(stackArgs[0], source);
    const stackLength = assignedResult(stackCall, source);
    if (stackBuffer === undefined || stackLength === undefined) continue;

    const prefixCalls = functionDescendants(fn, body, "call_expression").filter((call) => {
      const functionNode = call.childForFieldName("function");
      if (functionNode === null || sourceText(functionNode, source) !== `${stringsAlias}.TrimPrefix`) return false;
      const args = call.childForFieldName("arguments")?.namedChildren ?? [];
      return args.length === 2 &&
        isStackString(args[0]!, source, stackBuffer, stackLength) &&
        isGoroutinePrefixLiteral(args[1]!, source);
    });
    if (prefixCalls.length !== 1) continue;
    const prefixCall = prefixCalls[0]!;
    const prefixValue = assignedResult(prefixCall, source);
    if (prefixValue === undefined) continue;
    const prefixReassignments = relatedReassignments(fn, body, prefixCall, source, prefixValue);
    if (prefixReassignments === undefined) continue;

    const integerParses = functionDescendants(fn, body, "call_expression").filter((call) => {
      const functionNode = call.childForFieldName("function");
      if (functionNode === null) return false;
      if (!new RegExp(`^${escapeRegExp(strconvAlias)}\\.(?:Atoi|ParseInt|ParseUint)$`).test(sourceText(functionNode, source))) return false;
      const firstArgument = call.childForFieldName("arguments")?.namedChildren[0];
      return firstArgument !== undefined && containsIdentifier(firstArgument, source, prefixValue);
    });
    if (integerParses.length !== 1) continue;
    const parsedID = discardedParseResult(integerParses[0]!, source);
    if (parsedID === undefined || !functionDescendants(fn, body, "return_statement")
      .some((node) => containsIdentifier(node, source, parsedID))) continue;
    helpers.set(sourceText(name, source), [stackCall, prefixCall, ...prefixReassignments, integerParses[0]!]);
  }
  return helpers;
}

function assignedResult(call: Node, source: string): string | undefined {
  const assignment = call.parent?.parent;
  if (assignment === null || assignment === undefined ||
      (assignment.type !== "short_var_declaration" && assignment.type !== "assignment_statement")) return undefined;
  const right = assignment.childForFieldName("right")?.namedChildren ?? [];
  const left = assignment.childForFieldName("left")?.namedChildren ?? [];
  if (right.length !== 1 || right[0]?.id !== call.id || left.length !== 1 || left[0]?.type !== "identifier") return undefined;
  return sourceText(left[0], source);
}

function sliceOperandIdentifier(node: Node, source: string): string | undefined {
  if (node.type !== "slice_expression") return undefined;
  const operand = node.childForFieldName("operand");
  return operand?.type === "identifier" ? sourceText(operand, source) : undefined;
}

function isStackString(node: Node, source: string, buffer: string, length: string): boolean {
  if (node.type !== "call_expression") return false;
  const fn = node.childForFieldName("function");
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  if (fn?.type !== "identifier" || sourceText(fn, source) !== "string" || args.length !== 1) return false;
  const slice = args[0]!;
  return sliceOperandIdentifier(slice, source) === buffer && containsIdentifier(slice, source, length);
}

function isGoroutinePrefixLiteral(node: Node, source: string): boolean {
  if (node.type !== "interpreted_string_literal" && node.type !== "raw_string_literal") return false;
  const text = sourceText(node, source);
  return text === '"goroutine "' || text === "`goroutine `";
}

function functionDescendants(fn: Node, body: Node, type: string): Node[] {
  return descendants(body, type).filter((node) => {
    let current = node.parent;
    while (current !== null && current.id !== fn.id) {
      if (current.type === "func_literal") return false;
      current = current.parent;
    }
    return current?.id === fn.id;
  });
}

function relatedReassignments(fn: Node, body: Node, origin: Node, source: string, name: string): Node[] | undefined {
  const related: Node[] = [];
  for (const assignment of [
    ...functionDescendants(fn, body, "short_var_declaration"),
    ...functionDescendants(fn, body, "assignment_statement"),
  ]) {
    if (assignment.id === origin.parent?.parent?.id) continue;
    const left = assignment.childForFieldName("left")?.namedChildren ?? [];
    const indexes = left.flatMap((node, index) =>
      node.type === "identifier" && sourceText(node, source) === name ? [index] : []);
    if (indexes.length === 0) continue;
    const right = assignment.childForFieldName("right")?.namedChildren ?? [];
    const unrelated = indexes.some((index) => {
      const value = right.length === left.length ? right[index] : right[0];
      return value === undefined || !containsIdentifier(value, source, name);
    });
    if (unrelated) return undefined;
    related.push(assignment);
  }
  return related;
}

function declaresLocalIdentifier(fn: Node, source: string, name: string): boolean {
  for (const declaration of [
    ...descendants(fn, "parameter_declaration"),
    ...descendants(fn, "short_var_declaration"),
    ...descendants(fn, "var_spec"),
    ...descendants(fn, "range_clause"),
  ]) {
    const left = declaration.childForFieldName("left")?.namedChildren ?? [];
    const named = left.length > 0 ? left : declaration.namedChildren;
    if (named.some((node) => node.type === "identifier" && sourceText(node, source) === name)) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function changedHelperAnchor(file: SourceRevision, anchors: Node[]): Node | undefined {
  return anchors.find((node) => isChangedEvidence(file, node.startPosition.row + 1, node.endPosition.row + 1));
}

function discardedParseResult(call: Node, source: string): string | undefined {
  let current = call.parent;
  while (current !== null && current.type !== "short_var_declaration" && current.type !== "assignment_statement") {
    if (current.type === "statement_list" || current.type === "block") return undefined;
    current = current.parent;
  }
  if (current === null) return undefined;
  const left = current.childForFieldName("left")?.namedChildren ?? [];
  const right = current.childForFieldName("right")?.namedChildren ?? [];
  if (right.length !== 1 || right[0]?.id !== call.id || left.length < 2 || sourceText(left[1]!, source) !== "_") {
    return undefined;
  }
  return sourceText(left[0]!, source);
}

function mutableStateReceivers(root: Node, source: string, syncAlias: string | undefined): Set<string> {
  const receivers = new Set<string>();
  const conflicts = new Set<string>();
  for (const field of descendants(root, "field_declaration")) {
    const type = field.childForFieldName("type");
    const names = field.namedChildren.filter((node) => node.type === "field_identifier" || node.type === "identifier");
    const mutable = type !== null && isMutableStateType(sourceText(type, source), syncAlias);
    for (const name of names) (mutable ? receivers : conflicts).add(sourceText(name, source));
  }
  for (const spec of descendants(root, "var_spec")) {
    const type = spec.childForFieldName("type");
    const mutable = type !== null && isMutableStateType(sourceText(type, source), syncAlias);
    for (const name of spec.namedChildren.filter((node) => node.type === "identifier")) {
      (mutable ? receivers : conflicts).add(sourceText(name, source));
    }
  }
  for (const declaration of descendants(root, "short_var_declaration")) {
    const left = declaration.childForFieldName("left")?.namedChildren ?? [];
    const right = declaration.childForFieldName("right")?.namedChildren ?? [];
    if (left.length !== right.length) continue;
    right.forEach((value, index) => {
      const name = left[index];
      if (name === undefined || name.type !== "identifier") return;
      if (isMutableStateInitializer(sourceText(value, source), syncAlias)) {
        receivers.add(sourceText(name, source));
      } else {
        conflicts.add(sourceText(name, source));
      }
    });
  }
  for (const parameter of descendants(root, "parameter_declaration")) {
    const type = parameter.childForFieldName("type");
    if (type !== null && isMutableStateType(sourceText(type, source), syncAlias)) continue;
    for (const name of parameter.namedChildren.filter((node) =>
      node.type === "identifier" && (type === null || node.endIndex <= type.startIndex))) {
      conflicts.add(sourceText(name, source));
    }
  }
  for (const conflict of conflicts) receivers.delete(conflict);
  return receivers;
}

function isMutableStateType(type: string, syncAlias: string | undefined): boolean {
  return /^map\s*\[/.test(type) || (syncAlias !== undefined && type === `${syncAlias}.Map`);
}

function isMutableStateInitializer(value: string, syncAlias: string | undefined): boolean {
  return /^make\s*\(\s*map\s*\[/.test(value) ||
    /^map\s*\[.*\]\s*.*\{/.test(value) ||
    (syncAlias !== undefined && new RegExp(`^&?${syncAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.Map\\s*\\{`).test(value));
}

function directHelperCall(
  key: Node,
  source: string,
  helpers: Map<string, Node[]>,
): { helper: string; anchors: Node[] } | undefined {
  if (key.type !== "call_expression") return undefined;
  const functionNode = key.childForFieldName("function");
  if (functionNode?.type !== "identifier") return undefined;
  const helper = sourceText(functionNode, source);
  const anchors = helpers.get(helper);
  if (anchors === undefined) return undefined;
  const enclosing = findEnclosingFunction(key);
  if (enclosing !== null && declaresLocalIdentifier(enclosing, source, helper)) return undefined;
  return { helper, anchors };
}

function analyzeContextDetachment(
  file: SourceRevision,
  root: Node,
  aliases: Map<string, string>,
  signals: Signal[],
): void {
  const contextAlias = aliases.get("context");
  if (contextAlias === undefined) return;

  const callables = [
    ...descendants(root, "function_declaration"),
    ...descendants(root, "method_declaration"),
    ...descendants(root, "func_literal"),
  ];
  for (const fn of callables) {
    const body = fn.childForFieldName("body");
    if (body === null) continue;
    const parentContexts = parameterDeclarations(fn)
      .filter((parameter) => {
        const type = parameter.childForFieldName("type");
        return type !== null && sourceText(type, file.current) === `${contextAlias}.Context`;
      })
      .map((parameter) => parameter.childForFieldName("name"))
      .filter((name): name is Node => name !== null)
      .map((name) => sourceText(name, file.current))
      .filter((name) => name !== "_");
    if (parentContexts.length === 0) continue;

    for (const call of directScopeDescendants(body, "call_expression")) {
      const functionNode = call.childForFieldName("function");
      if (functionNode === null) continue;
      const called = sourceText(functionNode, file.current);
      if (called !== `${contextAlias}.Background` && called !== `${contextAlias}.TODO`) continue;
      const helper = called.slice(called.lastIndexOf(".") + 1);
      signals.push(signal(file, call, "go-concurrency.context.background-in-request",
        `${called} detaches this operation from ${parentContexts[0]}'s cancellation and deadline.`, {
          parentContext: parentContexts[0],
          detachedWith: helper,
          form: "context-replacement",
        }));
    }
  }
}

function directScopeDescendants(node: Node, type: string): Node[] {
  const result: Node[] = [];
  const pending = [...node.namedChildren].reverse();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || current.type === "func_literal") continue;
    if (current.type === type) result.push(current);
    for (let index = current.namedChildCount - 1; index >= 0; index -= 1) {
      const child = current.namedChild(index);
      if (child !== null) pending.push(child);
    }
  }
  return result;
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
  atomicAccessors: Map<string, string>,
  signals: Signal[],
  positives: PositiveSignal[],
): void {
  const body = fn.childForFieldName("body");
  const syncAlias = aliases.get("sync");
  analyzeCopyLocks(file, fn, syncAlias, signals);
  if (body === null) return;
  if (syncAlias !== undefined) analyzeWaitGroups(file, body, syncAlias, signals, positives);
  analyzeCancellation(file, body, aliases, signals, positives);
  analyzeContextErrorClassification(file, fn, body, aliases, signals);
  analyzeAtomicCapacityAdmission(file, fn, body, aliases, atomicAccessors, signals);
  analyzeChannels(file, body, signals);
  analyzeLoopVarCapture(file, body, signals);
  analyzeSelectDefaultBusy(file, body, signals);
  analyzeTickers(file, fn, body, aliases, signals);
  analyzeTimers(file, body, aliases, signals);
}

function atomicAccessorMethods(
  root: Node,
  source: string,
  aliases: Map<string, string>,
): Map<string, string> {
  const hasAtomicImport = aliases.has("sync/atomic") || aliases.has("go.uber.org/atomic");
  const result = new Map<string, string>();
  if (!hasAtomicImport) return result;

  for (const method of descendants(root, "method_declaration")) {
    const name = method.childForFieldName("name");
    const body = method.childForFieldName("body");
    if (name === null || body === null) continue;
    const returns = descendants(body, "return_statement");
    if (returns.length !== 1) continue;
    const loads = descendants(returns[0]!, "call_expression")
      .map((call) => selectedCall(call, source))
      .filter((call): call is { operand: string; field: string } => call !== undefined && call.field === "Load");
    if (loads.length !== 1) continue;
    const field = loads[0]!.operand.split(".").at(-1);
    if (field !== undefined) result.set(sourceText(name, source), field);
  }
  return result;
}

function analyzeAtomicCapacityAdmission(
  file: SourceRevision,
  fn: Node,
  body: Node,
  aliases: Map<string, string>,
  atomicAccessors: Map<string, string>,
  signals: Signal[],
): void {
  if (!aliases.has("sync/atomic") && !aliases.has("go.uber.org/atomic")) return;
  const functionName = functionNameOf(fn, file.current) ?? "";
  if (!/^(?:Try)?(?:Add|Acquire|Admit|Claim|Reserve|Take)/i.test(functionName)) return;

  const hasLock = descendants(body, "call_expression").some((call) => {
    const selected = selectedCall(call, file.current);
    return selected !== undefined && (selected.field === "Lock" || selected.field === "RLock");
  });
  if (hasLock) return;

  for (const guard of descendants(body, "if_statement")) {
    const condition = guard.childForFieldName("condition") ?? guard.namedChildren[0];
    const consequence = guard.childForFieldName("consequence")
      ?? guard.namedChildren.find((node) => node.type === "block");
    if (condition === undefined || consequence === undefined) continue;
    const conditionText = sourceText(condition, file.current);
    if (!/>=?/.test(conditionText) || !/(?:max|limit|cap(?:acity)?|quota)/i.test(conditionText)) continue;
    if (descendants(consequence, "return_statement").length === 0) continue;

    const checkedFields = new Set<string>();
    for (const call of descendants(condition, "call_expression")) {
      const selected = selectedCall(call, file.current);
      if (selected === undefined) continue;
      if (selected.field === "Load") {
        checkedFields.add(selected.operand);
        continue;
      }
      const accessorField = atomicAccessors.get(selected.field);
      if (accessorField !== undefined) checkedFields.add(`${selected.operand}.${accessorField}`);
    }
    if (checkedFields.size === 0) continue;

    const mutation = descendants(body, "call_expression").find((call) => {
      if (call.startIndex <= guard.endIndex) return false;
      const selected = selectedCall(call, file.current);
      return selected !== undefined &&
        (selected.field === "Add" || selected.field === "Store" || selected.field === "Swap") &&
        checkedFields.has(selected.operand);
    });
    if (mutation === undefined) continue;
    const selected = selectedCall(mutation, file.current)!;
    signals.push(signal(file, guard, "go-concurrency.atomic-capacity-check-update",
      `${selected.operand} is checked against a capacity limit and updated later; the individually atomic operations do not make admission atomic.`,
      { state: selected.operand, mutation: selected.field, form: "check-then-update" }));
  }
}

function selectedCall(call: Node, source: string): { operand: string; field: string } | undefined {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "selector_expression") return undefined;
  const operand = fn.childForFieldName("operand");
  const field = fn.childForFieldName("field");
  if (operand === null || field === null) return undefined;
  return { operand: sourceText(operand, source), field: sourceText(field, source) };
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
  const waitGroupType = `${syncAlias}.WaitGroup`;
  for (const declaration of descendants(body, "var_spec")) {
    const type = declaration.childForFieldName("type");
    const names = declaration.namedChildren
      .filter((node) => node.type === "identifier")
      .map((node) => sourceText(node, file.current));
    if (type !== null && sourceText(type, file.current) === waitGroupType) {
      names.filter((name) => name !== "_").forEach((name) => waitGroups.add(name));
      continue;
    }
    const values = declaration.childForFieldName("value")?.namedChildren ?? [];
    addInitializedWaitGroups(waitGroups, names, values, file.current, waitGroupType);
  }
  for (const declaration of descendants(body, "short_var_declaration")) {
    const left = declaration.childForFieldName("left");
    const right = declaration.childForFieldName("right");
    const names = left?.namedChildren.map((node) => sourceText(node, file.current)) ?? [];
    const values = right?.namedChildren ?? [];
    addInitializedWaitGroups(waitGroups, names, values, file.current, waitGroupType);
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
    analyzeWaitGroupCompletion(file, body, name, signals);
  }
}

function addInitializedWaitGroups(
  waitGroups: Set<string>,
  names: string[],
  values: Node[],
  source: string,
  waitGroupType: string,
): void {
  if (names.length !== values.length) return;
  const escapedType = waitGroupType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const initializer = new RegExp(
    `^(?:${escapedType}\\s*\\{\\s*\\}|&\\s*${escapedType}\\s*\\{\\s*\\}|new\\s*\\(\\s*${escapedType}\\s*\\))$`,
  );
  values.forEach((value, index) => {
    const name = names[index];
    if (name !== undefined && name !== "_" && initializer.test(sourceText(value, source))) {
      waitGroups.add(name);
    }
  });
}

function analyzeWaitGroupCompletion(file: SourceRevision, body: Node, name: string, signals: Signal[]): void {
  for (const goStatement of descendants(body, "go_statement")) {
    const closure = goStatement.namedChildren.find((child) => child.type === "func_literal") ??
      descendants(goStatement, "func_literal")[0];
    if (closure === undefined) continue;
    const closureBody = closure.childForFieldName("body");
    if (closureBody === null) continue;

    const doneCalls = directScopeDescendants(closureBody, "call_expression")
      .filter((call) => isSelectorCall(call, file.current, name, "Done"));
    if (doneCalls.length === 0 || doneCalls.some(isDeferredCall)) continue;

    const returns = directScopeDescendants(closureBody, "return_statement");
    for (const done of doneCalls) {
      if (isInsideLoop(done, closureBody) || isInsideDeferredClosure(done, closureBody)) continue;
      const earlierReturn = returns.find((statement) => statement.startIndex < done.startIndex);
      if (earlierReturn === undefined) continue;
      signals.push(signal(file, earlierReturn, "go-concurrency.waitgroup.done-not-deferred",
        `${name}.Done is reached only after an earlier return path in this goroutine; Wait can remain blocked when that path exits.`, {
          waitGroup: name,
          operation: "Done",
          placement: "after-early-return",
          doneLine: done.startPosition.row + 1,
        }));
      break;
    }
  }
}

function isSelectorCall(call: Node, source: string, receiver: string, field: string): boolean {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "selector_expression") return false;
  const operand = fn.childForFieldName("operand");
  const selected = fn.childForFieldName("field");
  return operand !== null && selected !== null &&
    sourceText(operand, source) === receiver && sourceText(selected, source) === field;
}

function isDeferredCall(call: Node): boolean {
  return call.parent?.type === "defer_statement";
}

function isInsideDeferredClosure(node: Node, boundary: Node): boolean {
  let current = node.parent;
  while (current !== null && current.id !== boundary.id) {
    if (current.type === "func_literal" && current.parent?.type === "call_expression" && current.parent.parent?.type === "defer_statement") return true;
    current = current.parent;
  }
  return false;
}

function isInsideLoop(node: Node, boundary: Node): boolean {
  let current = node.parent;
  while (current !== null && current.id !== boundary.id) {
    if (current.type === "func_literal") return false;
    if (current.type === "for_statement") return true;
    current = current.parent;
  }
  return false;
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

function analyzeContextErrorClassification(
  file: SourceRevision,
  fn: Node,
  body: Node,
  aliases: Map<string, string>,
  signals: Signal[],
): void {
  const contextAlias = aliases.get("context");
  if (contextAlias === undefined) return;

  const contextNames = new Set(
    parameterDeclarations(fn)
      .filter((parameter) => {
        const type = parameter.childForFieldName("type");
        return type !== null && sourceText(type, file.current) === `${contextAlias}.Context`;
      })
      .map((parameter) => parameter.childForFieldName("name"))
      .filter((name): name is Node => name !== null)
      .map((name) => sourceText(name, file.current)),
  );
  if (contextNames.size === 0) return;

  for (const list of descendants(body, "statement_list")) {
    const statements = list.namedChildren;
    for (let index = 0; index + 1 < statements.length; index += 1) {
      const operation = contextAwareErrorAssignment(statements[index]!, file.current, contextNames);
      if (operation === undefined) continue;

      const handler = statements[index + 1]!;
      if (handler.type !== "if_statement" || !testsNonNil(handler, file.current, operation.errorName)) continue;
      if (!hasOrdinaryErrorHandling(handler, file.current)) continue;
      if (classifiesCancellation(handler, file.current, operation.contextName, operation.errorName, contextAlias)) continue;

      signals.push(signal(file, handler, "go-concurrency.context.error-classification",
        `Error from a call using ${operation.contextName} is handled as an ordinary failure without distinguishing context cancellation.`,
        {
          context: operation.contextName,
          error: operation.errorName,
          form: "context-aware-error-handling",
        }));
    }
  }
}

function contextAwareErrorAssignment(
  statement: Node,
  source: string,
  contextNames: Set<string>,
): { contextName: string; errorName: string } | undefined {
  if (statement.type !== "short_var_declaration" && statement.type !== "assignment_statement") return undefined;
  const left = statement.childForFieldName("left");
  const right = statement.childForFieldName("right");
  const names = left?.namedChildren.map((node) => sourceText(node, source)) ?? [];
  const values = right?.namedChildren ?? [];
  if (!names.includes("err") || values.length !== 1 || values[0]!.type !== "call_expression") return undefined;

  const argumentsNode = values[0]!.childForFieldName("arguments");
  if (argumentsNode === null) return undefined;
  const contextName = [...contextNames].find((name) => containsIdentifier(argumentsNode, source, name));
  return contextName === undefined ? undefined : { contextName, errorName: "err" };
}

function testsNonNil(statement: Node, source: string, errorName: string): boolean {
  const condition = statement.childForFieldName("condition") ?? statement.namedChildren[0];
  if (condition === undefined) return false;
  const compact = sourceText(condition, source).replace(/\s+/g, "");
  return compact.includes(`${errorName}!=nil`) || compact.includes(`nil!=${errorName}`);
}

function hasOrdinaryErrorHandling(statement: Node, source: string): boolean {
  if (descendants(statement, "continue_statement").length > 0) return true;
  return descendants(statement, "call_expression").some((call) => {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return false;
    const field = fn.childForFieldName("field");
    if (field === null) return false;
    return /^(?:Error|Errorf|Errorln|Warn|Warnf|Warnln|Nack|Reject|Fail|Failf|Fatal|Fatalf)$/i
      .test(sourceText(field, source));
  });
}

function classifiesCancellation(
  statement: Node,
  source: string,
  contextName: string,
  errorName: string,
  contextAlias: string,
): boolean {
  if (selectorCalls(statement, source, contextName, "Err").length > 0) return true;
  const compact = sourceText(statement, source).replace(/\s+/g, "");
  return compact.includes(`.Is(${errorName},${contextAlias}.Canceled)`) ||
    compact.includes(`.Is(${errorName},${contextAlias}.DeadlineExceeded)`);
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
