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
  const previousTree = file.previous === undefined ? undefined : await parseGo(file.previous);
  try {
    if (tree.rootNode.hasError) throw new Error("Go source contains syntax errors");
    const aliases = importAliases(tree.rootNode, file.current);
    const atomicAccessors = atomicAccessorMethods(tree.rootNode, file.current, aliases);
    const signals: Signal[] = [];
    const positives: PositiveSignal[] = [];
    analyzeContextDetachment(file, tree.rootNode, aliases, signals);
    analyzeGoroutineIDStateKeys(file, tree.rootNode, previousTree?.rootNode, aliases, signals);
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
      signals: signals.filter((item) =>
        isChangedEvidence(file, item.line, item.endLine) || item.data.changeKind === "deletion"),
      positives: positives.filter((item) => isChangedEvidence(file, item.line)),
    };
  } finally {
    previousTree?.delete();
    tree.delete();
  }
}

function analyzeGoroutineIDStateKeys(
  file: SourceRevision,
  root: Node,
  previousRoot: Node | undefined,
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

  const mutableState = mutableStateIndex(root, file.current, aliases.get("sync"));
  const seen = new Set<string>();
  for (const call of descendants(root, "call_expression")) {
    const selected = selectedCall(call, file.current);
    if (selected === undefined || !["Store", "Load", "Delete"].includes(selected.field)) continue;
    if (!isMutableStateExpression(selected.operandNode, mutableState)) continue;

    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    const key = args[0];
    if (key === undefined) continue;
    const helperCall = directHelperCall(key, file.current, idHelpers);
    if (helperCall === undefined) continue;

    const resolvedEvidence = goroutineIDChangedEvidence(
      file, key, selected.operandNode, mutableState, helperCall, previousRoot);
    if (resolvedEvidence === undefined) continue;
    const dedupe = `${selected.operand}:${helperCall.helper}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    signals.push(signal(file, resolvedEvidence.node, "go-concurrency.goroutine-id-state-key",
      `${selected.operand}.${selected.field} keys mutable state with a goroutine identifier parsed from runtime.Stack text.`, {
        state: selected.operand,
        operation: selected.field,
        helper: helperCall.helper,
        parseFailure: "shared-zero-key-if-unchecked",
        form: "runtime-stack-goroutine-id-state-key",
        ...resolvedEvidence.metadata,
      }));
  }

  for (const index of descendants(root, "index_expression")) {
    const operand = index.childForFieldName("operand");
    const key = index.childForFieldName("index");
    if (operand === null || key === null) continue;
    const state = sourceText(operand, file.current);
    if (!isMutableStateExpression(operand, mutableState)) continue;
    const helperCall = directHelperCall(key, file.current, idHelpers);
    if (helperCall === undefined) continue;
    const resolvedEvidence = goroutineIDChangedEvidence(file, key, operand, mutableState, helperCall, previousRoot);
    if (resolvedEvidence === undefined) continue;
    const dedupe = `${state}:${helperCall.helper}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    signals.push(signal(file, resolvedEvidence.node, "go-concurrency.goroutine-id-state-key",
      `${state} indexes mutable state with a goroutine identifier parsed from runtime.Stack text.`, {
        state,
        operation: index.parent?.type === "assignment_statement" ? "write" : "read",
        helper: helperCall.helper,
        parseFailure: "shared-zero-key-if-unchecked",
        form: "runtime-stack-goroutine-id-state-key",
        ...resolvedEvidence.metadata,
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
    if (!isMutableStateExpression(state, mutableState)) continue;
    const helperCall = directHelperCall(key, file.current, idHelpers);
    if (helperCall === undefined) continue;
    const resolvedEvidence = goroutineIDChangedEvidence(file, key, state, mutableState, helperCall, previousRoot);
    if (resolvedEvidence === undefined) continue;
    const dedupe = `${stateText}:${helperCall.helper}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    signals.push(signal(file, resolvedEvidence.node, "go-concurrency.goroutine-id-state-key",
      `${stateText} deletes mutable state with a goroutine identifier parsed from runtime.Stack text.`, {
        state: stateText,
        operation: "delete",
        helper: helperCall.helper,
        parseFailure: "shared-zero-key-if-unchecked",
        form: "runtime-stack-goroutine-id-state-key",
        ...resolvedEvidence.metadata,
      }));
  }
}

interface GoroutineIDHelper {
  anchors: Node[];
  scope: Node;
  parsedID: string;
}

type GoroutinePrefixState = "trimmed" | "token";

interface GoroutinePrefixTransform {
  anchors: Node[];
  state: GoroutinePrefixState;
}

function goroutineIDHelpers(
  root: Node,
  source: string,
  runtimeAlias: string,
  strconvAlias: string,
  stringsAlias: string,
): Map<string, GoroutineIDHelper> {
  const helpers = new Map<string, GoroutineIDHelper>();
  for (const fn of descendants(root, "function_declaration")) {
    const name = fn.childForFieldName("name");
    const body = fn.childForFieldName("body");
    if (name === null || body === null) continue;
    const stackCalls = functionDescendants(fn, body, "call_expression").filter((call) => {
      const functionNode = call.childForFieldName("function");
      if (functionNode === null || sourceText(functionNode, source) !== `${runtimeAlias}.Stack`) return false;
      if (isLocallyShadowedAt(fn, call, source, runtimeAlias)) return false;
      const args = call.childForFieldName("arguments")?.namedChildren ?? [];
      return args.length >= 2 && sourceText(args[1]!, source) === "false";
    });
    if (stackCalls.length !== 1) continue;
    const stackCall = stackCalls[0]!;
    const stackArgs = stackCall.childForFieldName("arguments")?.namedChildren ?? [];
    const stackBuffer = stackArgs[0] === undefined ? undefined : sliceOperandIdentifier(stackArgs[0], source);
    const stackLength = assignedResult(stackCall, source);
    if (stackBuffer === undefined || stackLength === undefined || stackLength === "_" ||
        stackArgs[0] === undefined || !isFullSlice(stackArgs[0])) continue;

    const prefixCalls = functionDescendants(fn, body, "call_expression").filter((call) => {
      const functionNode = call.childForFieldName("function");
      if (functionNode === null || sourceText(functionNode, source) !== `${stringsAlias}.TrimPrefix`) return false;
      if (isLocallyShadowedAt(fn, call, source, stringsAlias)) return false;
      const args = call.childForFieldName("arguments")?.namedChildren ?? [];
      return args.length === 2 &&
        isStackString(args[0]!, fn, source, stackBuffer, stackLength) &&
        isGoroutinePrefixLiteral(args[1]!, source);
    });
    if (prefixCalls.length !== 1) continue;
    const prefixCall = prefixCalls[0]!;
    if (identifierReassignedBetween(fn, body, stackCall, prefixCall, source, stackBuffer) ||
        identifierReassignedBetween(fn, body, stackCall, prefixCall, source, stackLength)) continue;
    const prefixValue = assignedResult(prefixCall, source);
    if (prefixValue === undefined) continue;
    const integerParses = functionDescendants(fn, body, "call_expression").flatMap((call) => {
      const functionNode = call.childForFieldName("function");
      if (functionNode === null) return [];
      if (!new RegExp(`^${escapeRegExp(strconvAlias)}\\.(?:Atoi|ParseInt|ParseUint)$`).test(sourceText(functionNode, source))) return [];
      if (isLocallyShadowedAt(fn, call, source, strconvAlias)) return [];
      const transform = relatedReassignments(
        fn, body, prefixCall, call, source, prefixValue, stringsAlias);
      if (transform === undefined) return [];
      const firstArgument = call.childForFieldName("arguments")?.namedChildren[0];
      if (firstArgument === undefined || !goroutineIDParseInput(
        firstArgument, fn, source, prefixValue, stringsAlias, transform.state)) return [];
      return [{ call, transform }];
    });
    if (integerParses.length !== 1) continue;
    const integerParse = integerParses[0]!;
    const parsedID = discardedParseResult(integerParse.call, source);
    if (parsedID === undefined) continue;
    const identityReturns = functionDescendants(fn, body, "return_statement").filter((statement) => {
      const list = statement.namedChildren.find((child) => child.type === "expression_list");
      const values = list?.namedChildren ?? statement.namedChildren;
      return values.length === 1 && expressionPreservesIDIdentity(values[0]!, parsedID, source);
    });
    if (identityReturns.length === 0) continue;
    if (parsedIDUnconditionallyOverwritten(fn, body, integerParse.call, source, parsedID)) continue;
    if (hasTerminatingZeroGuard(fn, body, integerParse.call, parsedID, source)) continue;
    helpers.set(sourceText(name, source), {
      anchors: [stackCall, prefixCall, ...integerParse.transform.anchors, integerParse.call, ...identityReturns],
      scope: fn,
      parsedID,
    });
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

function isFullSlice(node: Node): boolean {
  const start = node.childForFieldName("start");
  return node.type === "slice_expression" && isZeroOrOmitted(start) &&
    node.childForFieldName("end") === null && node.childForFieldName("capacity") === null;
}

function isStackString(node: Node, fnBoundary: Node, source: string, buffer: string, length: string): boolean {
  if (node.type !== "call_expression") return false;
  const fn = node.childForFieldName("function");
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  if (fn?.type !== "identifier" || sourceText(fn, source) !== "string" || args.length !== 1 ||
      isLocallyShadowedAt(fnBoundary, node, source, "string")) return false;
  const slice = args[0]!;
  const start = slice.childForFieldName("start");
  const end = slice.childForFieldName("end");
  return sliceOperandIdentifier(slice, source) === buffer && isZeroOrOmitted(start) &&
    end?.type === "identifier" && sourceText(end, source) === length &&
    slice.childForFieldName("capacity") === null;
}

function isZeroOrOmitted(node: Node | null): boolean {
  return node === null || (node.type === "int_literal" && parseGoInteger(node.text) === 0);
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

function findEnclosingCallable(node: Node): Node | null {
  let current: Node | null = node;
  while (current !== null) {
    if (current.type === "function_declaration" || current.type === "method_declaration" || current.type === "func_literal") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function callableParameterDeclarations(fn: Node): Node[] {
  const lists = [fn.childForFieldName("receiver"), fn.childForFieldName("parameters")];
  return lists.flatMap((list) => list?.namedChildren.filter((node) => node.type === "parameter_declaration") ?? []);
}

function hasTerminatingZeroGuard(fn: Node, body: Node, parser: Node, parsedID: string, source: string): boolean {
  const parserStatements = nearestAncestor(parser, "statement_list");
  const returns = functionDescendants(fn, body, "return_statement")
    .filter((statement) => containsIdentifier(statement, source, parsedID));
  const assignments = identifierAssignments(fn, body, source, parsedID);
  return functionDescendants(fn, body, "if_statement").some((statement) => {
    if (statement.startIndex <= parser.endIndex) return false;
    if (parserStatements === null || statement.parent?.id !== parserStatements.id) return false;
    const condition = statement.childForFieldName("condition");
    return condition !== null && isParsedIDZeroCondition(condition, parsedID, source) &&
      guardTerminates(statement, fn, source, false) && returns.length > 0 &&
      returns.every((returned) => returned.startIndex > statement.endIndex &&
        returned.startIndex >= parserStatements.startIndex && returned.endIndex <= parserStatements.endIndex) &&
      assignments.every((assignment) => assignment.startIndex <= statement.endIndex ||
        returns.every((returned) => assignment.startIndex >= returned.startIndex) ||
        assignmentPreservesNonzeroID(assignment, parsedID, source));
  });
}

function hasTerminatingKeyGuard(
  fn: Node,
  body: Node,
  assignment: Node,
  use: Node,
  key: string,
  source: string,
): boolean {
  return terminatingKeyGuards(fn, body, assignment, use, key, source).length > 0;
}

function terminatingKeyGuards(
  fn: Node,
  body: Node,
  assignment: Node,
  use: Node,
  key: string,
  source: string,
): Node[] {
  return functionDescendants(fn, body, "if_statement").filter((statement) => {
    if (statement.startIndex <= assignment.endIndex || statement.endIndex >= use.startIndex) return false;
    const guardStatements = statement.parent;
    if (guardStatements?.type !== "statement_list" ||
        use.startIndex < guardStatements.startIndex || use.endIndex > guardStatements.endIndex) return false;
    const condition = statement.childForFieldName("condition");
    const laterAssignments = identifierAssignments(fn, body, source, key).filter((candidate) =>
      candidate.startIndex > statement.endIndex && candidate.endIndex < use.startIndex &&
      assignmentMutatesKeyBinding(fn, body, assignment, candidate, use, key, source));
    return condition !== null && isParsedIDZeroCondition(condition, key, source) &&
      guardTerminates(statement, fn, source, true) &&
      laterAssignments.every((candidate) => assignmentPreservesNonzeroID(candidate, key, source));
  });
}

function assignmentMutatesKeyBinding(
  fn: Node,
  body: Node,
  origin: Node,
  assignment: Node,
  use: Node,
  name: string,
  source: string,
): boolean {
  if (assignment.type === "short_var_declaration") return declarationVisibleAt(assignment, use);
  const shadows = [
    ...functionDescendants(fn, body, "short_var_declaration"),
    ...functionDescendants(fn, body, "var_spec"),
    ...functionDescendants(fn, body, "range_clause"),
    ...functionDescendants(fn, body, "receive_statement"),
    ...functionDescendants(fn, body, "type_switch_statement"),
  ];
  return !shadows.some((declaration) => declaration.startIndex > origin.endIndex &&
    declaration.startIndex < assignment.startIndex && controlBindingNames(declaration, source).includes(name) &&
    declarationVisibleAt(declaration, assignment) && !declarationVisibleAt(declaration, use));
}

function guardTerminates(statement: Node, boundary: Node, source: string, allowReturn: boolean): boolean {
  const consequence = statement.childForFieldName("consequence");
  return consequence !== null && blockTerminates(consequence, boundary, source, allowReturn);
}

const pathContinues = 1;
const pathTerminatesSafely = 2;
const pathTerminatesUnsafely = 4;

function blockTerminates(block: Node, boundary: Node, source: string, allowReturn: boolean): boolean {
  return blockTerminationOutcomes(block, boundary, source, allowReturn) === pathTerminatesSafely;
}

function blockTerminationOutcomes(block: Node, boundary: Node, source: string, allowReturn: boolean): number {
  const statementList = block.type === "statement_list"
    ? block
    : block.namedChildren.find((node) => node.type === "statement_list");
  if (statementList === undefined) {
    const nested = block.namedChildren.find((node) =>
      node.type === "block" || node.type === "if_statement" ||
      node.type === "expression_switch_statement" || node.type === "type_switch_statement");
    return nested === undefined
      ? pathContinues
      : statementTerminationOutcomes(nested, boundary, source, allowReturn);
  }
  let outcomes = pathContinues;
  for (const statement of statementList.namedChildren) {
    if ((outcomes & pathContinues) === 0) break;
    outcomes = (outcomes & ~pathContinues) |
      statementTerminationOutcomes(statement, boundary, source, allowReturn);
  }
  return outcomes;
}

function statementTerminationOutcomes(statement: Node, boundary: Node, source: string, allowReturn: boolean): number {
  if (statement.type === "return_statement") {
    return allowReturn ? pathTerminatesSafely : pathTerminatesUnsafely;
  }
  if (statement.type === "continue_statement") {
    return hasAncestorBefore(statement, "for_statement", boundary) ? pathTerminatesSafely : pathTerminatesUnsafely;
  }
  if (statement.type === "break_statement" || statement.type === "goto_statement" ||
      statement.type === "fallthrough_statement") return pathTerminatesUnsafely;
  if (statement.type === "if_statement") {
    const consequence = statement.childForFieldName("consequence");
    const alternative = statement.childForFieldName("alternative");
    const consequenceOutcomes = consequence === null
      ? pathContinues
      : blockTerminationOutcomes(consequence, boundary, source, allowReturn);
    const alternativeOutcomes = alternative === null
      ? pathContinues
      : blockTerminationOutcomes(alternative, boundary, source, allowReturn);
    return consequenceOutcomes | alternativeOutcomes;
  }
  if (statement.type === "expression_switch_statement" || statement.type === "type_switch_statement") {
    return switchTerminationOutcomes(statement, boundary, source, allowReturn);
  }
  if (statement.type === "block") return blockTerminationOutcomes(statement, boundary, source, allowReturn);
  if (statement.type !== "expression_statement") return pathContinues;
  const call = statement.namedChildren[0];
  const callee = call?.type === "call_expression" ? call.childForFieldName("function") : null;
  return callee?.type === "identifier" && sourceText(callee, source) === "panic" &&
    isBuiltinPanic(call!, boundary, source) ? pathTerminatesSafely : pathContinues;
}

function switchTerminationOutcomes(statement: Node, boundary: Node, source: string, allowReturn: boolean): number {
  const cases = statement.namedChildren.filter((node) =>
    node.type === "expression_case" || node.type === "type_case" || node.type === "default_case");
  let outcomes = cases.some((node) => node.type === "default_case") ? 0 : pathContinues;
  for (const item of cases) {
    outcomes |= blockTerminationOutcomes(item, boundary, source, allowReturn);
  }
  return outcomes;
}

function isBuiltinPanic(call: Node, boundary: Node, source: string): boolean {
  if (isLocallyShadowedAt(boundary, call, source, "panic")) return false;
  let root = boundary;
  while (root.parent !== null) root = root.parent;
  return !descendants(root, "function_declaration").some((fn) => {
    const name = fn.childForFieldName("name");
    return name !== null && sourceText(name, source) === "panic";
  }) && !descendants(root, "var_spec").some((spec) =>
    findEnclosingCallable(spec) === null && directDeclaredNames(spec, source).includes("panic"));
}

function isParsedIDZeroCondition(condition: Node, parsedID: string, source: string): boolean {
  const unwrapped = unwrapParentheses(condition);
  if (unwrapped.type !== "binary_expression") return false;
  const left = unwrapped.childForFieldName("left");
  const right = unwrapped.childForFieldName("right");
  if (left === null || right === null) return false;
  const operator = source.slice(left.endIndex, right.startIndex).trim();
  return (isExactIdentifierValue(left, parsedID, source) && integerNodeValue(right, source) === 0 &&
      (operator === "==" || operator === "<=")) ||
    (integerNodeValue(left, source) === 0 && isExactIdentifierValue(right, parsedID, source) &&
      (operator === "==" || operator === ">=")) ||
    (isExactIdentifierValue(left, parsedID, source) && integerNodeValue(right, source) === 1 && operator === "<");
}

function unwrapParentheses(node: Node): Node {
  let current = node;
  while (current.type === "parenthesized_expression" && current.namedChildren.length === 1) {
    current = current.namedChildren[0]!;
  }
  return current;
}

function integerNodeValue(node: Node, source: string): number | undefined {
  const current = unwrapParentheses(node);
  if (current.type === "int_literal") return parseGoInteger(sourceText(current, source));
  if (current.type !== "unary_expression" || current.namedChildren.length !== 1) return undefined;
  const value = integerNodeValue(current.namedChildren[0]!, source);
  if (value === undefined) return undefined;
  const operator = source.slice(current.startIndex, current.namedChildren[0]!.startIndex).trim();
  if (operator === "+") return value;
  if (operator === "-") return -value;
  return undefined;
}

function parseGoInteger(literal: string): number | undefined {
  const text = literal.replaceAll("_", "");
  let value: number;
  if (/^0[bB][01]+$/.test(text)) value = Number.parseInt(text.slice(2), 2);
  else if (/^0[oO][0-7]+$/.test(text)) value = Number.parseInt(text.slice(2), 8);
  else if (/^0[xX][0-9a-fA-F]+$/.test(text)) value = Number.parseInt(text.slice(2), 16);
  else if (/^0[0-7]+$/.test(text) && text.length > 1) value = Number.parseInt(text.slice(1), 8);
  else if (/^(?:0|[1-9]\d*)$/.test(text)) value = Number.parseInt(text, 10);
  else return undefined;
  return Number.isSafeInteger(value) ? value : undefined;
}

function hasAncestorBefore(node: Node, type: string, boundary: Node): boolean {
  let current = node.parent;
  while (current !== null && current.id !== boundary.id) {
    if (current.type === type) return true;
    current = current.parent;
  }
  return false;
}

function relatedReassignments(
  fn: Node,
  body: Node,
  origin: Node,
  parse: Node,
  source: string,
  name: string,
  stringsAlias: string,
): GoroutinePrefixTransform | undefined {
  const originAssignment = origin.parent?.parent;
  if (originAssignment === null || originAssignment === undefined) return undefined;
  const related: Node[] = [];
  let state: GoroutinePrefixState = "trimmed";
  const assignments = [
    ...functionDescendants(fn, body, "short_var_declaration"),
    ...functionDescendants(fn, body, "assignment_statement"),
  ].filter((assignment) => assignment.startIndex > origin.endIndex && assignment.endIndex < parse.startIndex)
    .sort((left, right) => left.startIndex - right.startIndex);
  for (const assignment of assignments) {
    const left = assignment.childForFieldName("left")?.namedChildren ?? [];
    const indexes = left.flatMap((node, index) =>
      node.type === "identifier" && sourceText(node, source) === name ? [index] : []);
    if (indexes.length === 0) continue;
    if (!assignmentMutatesKeyBinding(
      fn, body, originAssignment, assignment, parse, name, source)) continue;
    const right = assignment.childForFieldName("right")?.namedChildren ?? [];
    for (const index of indexes) {
      const value = right.length === left.length ? right[index] : right[0];
      if (value === undefined) return undefined;
      const next = goroutinePrefixAssignmentState(
        value, assignment, origin, fn, body, source, name, stringsAlias, state);
      if (next === undefined) return undefined;
      state = next;
    }
    related.push(assignment);
  }
  return { anchors: related, state };
}

function goroutineIDParseInput(
  node: Node,
  fn: Node,
  source: string,
  name: string,
  stringsAlias: string,
  state: GoroutinePrefixState,
): boolean {
  const current = unwrapParentheses(node);
  if (isExactIdentifierValue(current, name, source)) return state === "token";
  return isGoroutinePrefixTokenSelection(current, fn, source, name, stringsAlias);
}

function isGoroutinePrefixTokenSelection(
  current: Node,
  fn: Node,
  source: string,
  name: string,
  stringsAlias: string,
): boolean {
  if (current.type !== "index_expression") return false;
  const index = current.childForFieldName("index");
  if (index === null || integerNodeValue(index, source) !== 0) return false;
  const operand = current.childForFieldName("operand");
  if (operand?.type !== "call_expression") return false;
  const called = operand.childForFieldName("function");
  if (called === null || isLocallyShadowedAt(fn, operand, source, stringsAlias)) return false;
  const calledText = sourceText(called, source);
  const args = operand.childForFieldName("arguments")?.namedChildren ?? [];
  if (calledText === `${stringsAlias}.Fields`) {
    return args.length === 1 && isExactIdentifierValue(args[0]!, name, source);
  }
  return calledText === `${stringsAlias}.Split` && args.length === 2 &&
    isExactIdentifierValue(args[0]!, name, source) && isSpaceLiteral(args[1]!, source);
}

function goroutinePrefixAssignmentState(
  value: Node,
  assignment: Node,
  origin: Node,
  fn: Node,
  body: Node,
  source: string,
  name: string,
  stringsAlias: string,
  state: GoroutinePrefixState,
): GoroutinePrefixState | undefined {
  const unwrapped = unwrapParentheses(value);
  if (isExactIdentifierValue(unwrapped, name, source)) return state;
  if (isGoroutinePrefixTokenSelection(unwrapped, fn, source, name, stringsAlias)) return "token";
  if (state !== "trimmed") return undefined;
  const current = unwrapParentheses(value);
  if (current.type !== "slice_expression") return undefined;
  const operand = current.childForFieldName("operand");
  const start = current.childForFieldName("start");
  const end = current.childForFieldName("end");
  if (operand === null || !isExactIdentifierValue(operand, name, source) || !isZeroOrOmitted(start) ||
      end?.type !== "identifier" || current.childForFieldName("capacity") !== null) return undefined;
  const boundary = sourceText(end, source);
  const matched = functionDescendants(fn, body, "call_expression").some((call) => {
    if (call.startIndex <= origin.endIndex || call.endIndex >= assignment.startIndex) return false;
    const called = call.childForFieldName("function");
    if (called === null || sourceText(called, source) !== `${stringsAlias}.IndexByte` ||
        isLocallyShadowedAt(fn, call, source, stringsAlias)) return false;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    const boundaryOrigin = call.parent?.parent;
    if (boundaryOrigin === null || boundaryOrigin === undefined) return false;
    return args.length === 2 && isExactIdentifierValue(args[0]!, name, source) &&
      isSpaceLiteral(args[1]!, source) && assignedResult(call, source) === boundary &&
      declarationVisibleAt(boundaryOrigin, assignment) &&
      !identifierAssignments(fn, body, source, boundary).some((candidate) =>
        candidate.id !== boundaryOrigin.id && candidate.startIndex > call.endIndex &&
        candidate.endIndex < assignment.startIndex && assignmentMutatesKeyBinding(
          fn, body, boundaryOrigin, candidate, assignment, boundary, source));
  });
  return matched ? "token" : undefined;
}

function isSpaceLiteral(node: Node, source: string): boolean {
  if (node.type !== "interpreted_string_literal" && node.type !== "raw_string_literal" &&
      node.type !== "rune_literal") return false;
  return ["\" \"", "` `", "' '"].includes(sourceText(node, source));
}

function identifierReassignedBetween(
  fn: Node,
  body: Node,
  from: Node,
  to: Node,
  source: string,
  name: string,
): boolean {
  return identifierAssignments(fn, body, source, name)
    .some((assignment) => assignment.startIndex > from.endIndex && assignment.endIndex < to.startIndex);
}

function parsedIDUnconditionallyOverwritten(fn: Node, body: Node, parser: Node, source: string, name: string): boolean {
  const statements = nearestAncestor(parser, "statement_list");
  if (statements === null) return false;
  const returns = functionDescendants(fn, body, "return_statement")
    .filter((statement) => containsIdentifier(statement, source, name));
  return identifierAssignments(fn, body, source, name).some((assignment) => {
    if (assignment.startIndex <= parser.endIndex || assignment.parent?.id !== statements.id) return false;
    const left = assignment.childForFieldName("left")?.namedChildren ?? [];
    const right = assignment.childForFieldName("right")?.namedChildren ?? [];
    const offset = left.findIndex((node) => node.type === "identifier" && sourceText(node, source) === name);
    const value = right.length === left.length ? right[offset] : right[0];
    return value !== undefined && !assignmentUsesPreviousBinding(assignment, name, source) &&
      !containsIdentifier(value, source, name) && returns.length > 0 &&
      returns.every((returned) => returned.startIndex > assignment.endIndex &&
        returned.startIndex >= statements.startIndex && returned.endIndex <= statements.endIndex);
  });
}

function identifierAssignments(fn: Node, body: Node, source: string, name: string): Node[] {
  return [
    ...functionDescendants(fn, body, "short_var_declaration"),
    ...functionDescendants(fn, body, "assignment_statement"),
  ].filter((assignment) => {
    const left = assignment.childForFieldName("left")?.namedChildren ?? [];
    return left.some((node) => node.type === "identifier" && sourceText(node, source) === name);
  });
}

function assignmentPreservesNonzeroID(assignment: Node, name: string, source: string): boolean {
  const left = assignment.childForFieldName("left")?.namedChildren ?? [];
  const right = assignment.childForFieldName("right")?.namedChildren ?? [];
  const offset = left.findIndex((node) => node.type === "identifier" && sourceText(node, source) === name);
  const value = right.length === left.length ? right[offset] : right[0];
  if (value === undefined) return false;
  const operator = assignmentOperator(assignment, source);
  if (operator !== undefined && operator !== "=" && operator !== ":=") {
    const constant = integerNodeValue(value, source);
    if ((operator === "|=" || operator === "&=") && isExactIdentifierValue(value, name, source)) return true;
    return ((operator === "+=" || operator === "-=" || operator === "|=" || operator === "^=" ||
        operator === "<<=" || operator === ">>=" || operator === "&^=") && constant === 0) ||
      ((operator === "*=" || operator === "/=") && constant === 1);
  }
  if (expressionPreservesIDIdentity(value, name, source)) return true;
  const constant = integerNodeValue(value, source);
  return constant !== undefined && constant !== 0;
}

function assignmentUsesPreviousBinding(assignment: Node, name: string, source: string): boolean {
  if (assignment.type !== "assignment_statement") return false;
  const left = assignment.childForFieldName("left")?.namedChildren ?? [];
  return left.length === 1 && left[0]?.type === "identifier" && sourceText(left[0], source) === name &&
    ![undefined, "=", ":="].includes(assignmentOperator(assignment, source));
}

function assignmentOperator(assignment: Node, source: string): string | undefined {
  const left = assignment.childForFieldName("left");
  const right = assignment.childForFieldName("right");
  if (left === null || right === null) return undefined;
  const operator = source.slice(left.endIndex, right.startIndex).trim();
  return /^(?::=|=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|>>=|&\^=)$/.test(operator) ? operator : undefined;
}

function expressionPreservesIDIdentity(value: Node, name: string, source: string): boolean {
  if (isExactIdentifierValue(value, name, source)) return true;
  if (isBuiltinInt64IdentityConversion(value, name, source)) return true;
  const expression = unwrapParentheses(value);
  if (expression.type !== "binary_expression") return false;
  const first = expression.childForFieldName("left");
  const second = expression.childForFieldName("right");
  if (first === null || second === null) return false;
  const operator = source.slice(first.endIndex, second.startIndex).trim();
  if ((operator === "|" || operator === "&") &&
      isExactIdentifierValue(first, name, source) && isExactIdentifierValue(second, name, source)) return true;
  if ((operator === "+" || operator === "|") &&
      ((isExactIdentifierValue(first, name, source) && integerNodeValue(second, source) === 0) ||
       (integerNodeValue(first, source) === 0 && isExactIdentifierValue(second, name, source)))) return true;
  if (operator === "-" && isExactIdentifierValue(first, name, source) && integerNodeValue(second, source) === 0) return true;
  if (operator === "/" && isExactIdentifierValue(first, name, source) && integerNodeValue(second, source) === 1) return true;
  if (operator === "^" && isExactIdentifierValue(first, name, source) && integerNodeValue(second, source) === 0) return true;
  return operator === "*" &&
    ((isExactIdentifierValue(first, name, source) && integerNodeValue(second, source) === 1) ||
     (integerNodeValue(first, source) === 1 && isExactIdentifierValue(second, name, source)));
}

function isBuiltinInt64IdentityConversion(node: Node, name: string, source: string): boolean {
  const current = unwrapParentheses(node);
  if (current.type !== "call_expression") return false;
  const fn = current.childForFieldName("function");
  const args = current.childForFieldName("arguments")?.namedChildren ?? [];
  if (fn?.type !== "identifier" || sourceText(fn, source) !== "int64" || args.length !== 1 ||
      !isExactIdentifierValue(args[0]!, name, source)) return false;
  const callable = findEnclosingCallable(current);
  if (callable !== null && isLocallyShadowedAt(callable, current, source, "int64")) return false;
  let root = current;
  while (root.parent !== null) root = root.parent;
  const namedDeclarations = [
    ...descendants(root, "type_spec"),
    ...descendants(root, "type_alias"),
    ...descendants(root, "function_declaration"),
    ...descendants(root, "const_spec"),
  ];
  if (namedDeclarations.some((declaration) => {
    const declared = declaration.childForFieldName("name");
    return declared !== null && sourceText(declared, source) === "int64";
  })) return false;
  return !descendants(root, "var_spec").some((spec) => {
    if (findEnclosingCallable(spec) !== null) return false;
    return directDeclaredNames(spec, source).includes("int64");
  });
}

function isExactIdentifierValue(node: Node, name: string, source: string): boolean {
  if (node.type === "identifier") return sourceText(node, source) === name;
  if (node.type === "parenthesized_expression" && node.namedChildren.length === 1) {
    return isExactIdentifierValue(node.namedChildren[0]!, name, source);
  }
  if (node.type === "unary_expression" && sourceText(node, source).trim().startsWith("+") && node.namedChildren.length === 1) {
    return isExactIdentifierValue(node.namedChildren[0]!, name, source);
  }
  return false;
}

function isLocallyShadowedAt(fn: Node, reference: Node, source: string, name: string): boolean {
  const body = fn.childForFieldName("body");
  const declarations = [
    ...callableParameterDeclarations(fn),
    ...(body === null ? [] : [
      ...functionDescendants(fn, body, "short_var_declaration"),
      ...functionDescendants(fn, body, "var_spec"),
      ...functionDescendants(fn, body, "range_clause"),
      ...functionDescendants(fn, body, "receive_statement"),
      ...functionDescendants(fn, body, "type_switch_statement"),
    ]),
  ];
  for (const declaration of declarations) {
    if (declaration.startIndex >= reference.startIndex ||
        (!callableParameterDeclarations(fn).some((parameter) => parameter.id === declaration.id) &&
          !declarationVisibleAt(declaration, reference))) continue;
    if (controlBindingNames(declaration, source).includes(name)) return true;
  }
  return false;
}

function controlBindingNames(declaration: Node, source: string): string[] {
  if (declaration.type === "parameter_declaration" || declaration.type === "var_spec") {
    return directDeclaredNames(declaration, source);
  }
  if ((declaration.type === "range_clause" || declaration.type === "receive_statement") &&
      !sourceText(declaration, source).includes(":=")) return [];
  const field = declaration.type === "type_switch_statement" ? "alias" : "left";
  const selected = declaration.childForFieldName(field)?.namedChildren ?? [];
  const named = selected.length > 0 ? selected : declaration.namedChildren;
  return named
    .filter((node) => node.type === "identifier" || node.type === "field_identifier")
    .map((node) => sourceText(node, source));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function changedHelperAnchor(file: SourceRevision, anchors: Node[], previousRoot: Node | undefined): Node | undefined {
  return anchors.find((node) => isSemanticallyChangedEvidence(file, node, previousRoot));
}

interface GoroutineIDChangedEvidence {
  node: Node;
  metadata: Record<string, unknown>;
}

function goroutineIDChangedEvidence(
  file: SourceRevision,
  key: Node,
  state: Node,
  mutableState: MutableStateIndex,
  helper: ResolvedGoroutineIDHelper,
  previousRoot: Node | undefined,
): GoroutineIDChangedEvidence | undefined {
  if (isSemanticallyChangedEvidence(file, key, previousRoot)) return { node: key, metadata: {} };
  const helperAnchor = changedHelperAnchor(file, helper.anchors, previousRoot);
  if (helperAnchor !== undefined) return { node: helperAnchor, metadata: {} };
  const guardAnchor = changedTerminatingGuardEvidence(file, helper, previousRoot);
  if (guardAnchor !== undefined) return guardAnchor;
  const callerGuardAnchor = changedCallerGuardEvidence(file, helper, previousRoot);
  if (callerGuardAnchor !== undefined) return callerGuardAnchor;
  const stateAnchor = mutableStateEvidence(state, mutableState)
    .find((node) => isSemanticallyChangedEvidence(file, node, previousRoot));
  if (stateAnchor !== undefined) return { node: stateAnchor, metadata: { changeKind: "state-declaration" } };
  return deletedTerminatingGuardEvidence(file, helper, previousRoot);
}

function changedCallerGuardEvidence(
  file: SourceRevision,
  helper: ResolvedGoroutineIDHelper,
  previousRoot: Node | undefined,
): GoroutineIDChangedEvidence | undefined {
  const caller = helper.callerKey;
  if (caller === undefined || file.status !== "modified" || file.previous === undefined || previousRoot === undefined) {
    return undefined;
  }
  const identity = callableIdentity(caller.scope, file.current);
  if (identity === undefined) return undefined;
  const previousScope = [
    ...descendants(previousRoot, "function_declaration"),
    ...descendants(previousRoot, "method_declaration"),
  ].find((candidate) => callableIdentity(candidate, file.previous!) === identity);
  const previousBody = previousScope?.childForFieldName("body");
  if (previousScope === undefined || previousBody === null || previousBody === undefined) return undefined;

  const previousOrigins = [
    ...functionDescendants(previousScope, previousBody, "short_var_declaration"),
    ...functionDescendants(previousScope, previousBody, "assignment_statement"),
  ].filter((assignment) => assignmentAssignsHelper(assignment, caller.key, helper.helper, file.previous!));
  const previousAliases = importAliases(previousRoot, file.previous);
  const previousState = mutableStateIndex(previousRoot, file.previous, previousAliases.get("sync"));
  const previousUses = mutableStateKeyUses(previousScope, previousBody, caller.key, previousState);
  const proof = previousOrigins.flatMap((origin) => previousUses
    .filter((use) => use.startIndex > origin.endIndex)
    .flatMap((use) => terminatingKeyGuards(
      previousScope, previousBody, origin, use, caller.key, file.previous!)))
    .sort((left, right) => left.startIndex - right.startIndex)[0];
  if (proof === undefined) return undefined;

  const currentBody = caller.scope.childForFieldName("body");
  if (currentBody !== null) {
    const changedGuard = functionDescendants(caller.scope, currentBody, "if_statement").find((statement) => {
      if (statement.startIndex <= caller.assignment.endIndex || statement.endIndex >= caller.use.startIndex) return false;
      const condition = statement.childForFieldName("condition");
      return condition !== null && isParsedIDZeroCondition(condition, caller.key, file.current) &&
        isSemanticallyChangedEvidence(file, statement, previousRoot);
    });
    if (changedGuard !== undefined) {
      return { node: changedGuard, metadata: { changeKind: "guard-change", anchorScope: identity } };
    }
  }
  return {
    node: caller.use,
    metadata: {
      changeKind: "deletion",
      deletedSemantic: "terminating-zero-guard",
      deletedLine: proof.startPosition.row + 1,
      anchorScope: identity,
    },
  };
}

function callableIdentity(callable: Node, source: string): string | undefined {
  const name = callable.childForFieldName("name");
  if (name === null) return undefined;
  if (callable.type === "function_declaration") return `function:${sourceText(name, source)}`;
  if (callable.type !== "method_declaration") return undefined;
  const receiver = callable.childForFieldName("receiver");
  const declaration = receiver === null ? undefined : descendants(receiver, "parameter_declaration")[0];
  const type = declaration?.childForFieldName("type");
  return type === null || type === undefined
    ? undefined
    : `method:${sourceText(type, source).replace(/\s+/g, "")}:${sourceText(name, source)}`;
}

function assignmentAssignsHelper(assignment: Node, key: string, helper: string, source: string): boolean {
  const left = assignment.childForFieldName("left")?.namedChildren ?? [];
  const right = assignment.childForFieldName("right")?.namedChildren ?? [];
  const offset = left.findIndex((node) => node.type === "identifier" && sourceText(node, source) === key);
  const value = right.length === left.length ? right[offset] : right[0];
  if (offset < 0 || value?.type !== "call_expression") return false;
  const fn = value.childForFieldName("function");
  return fn?.type === "identifier" && sourceText(fn, source) === helper;
}

function mutableStateKeyUses(
  callable: Node,
  body: Node,
  key: string,
  index: MutableStateIndex,
): Node[] {
  const uses: Node[] = [];
  for (const call of functionDescendants(callable, body, "call_expression")) {
    const selected = selectedCall(call, index.source);
    if (selected !== undefined && ["Store", "Load", "Delete"].includes(selected.field) &&
        isMutableStateExpression(selected.operandNode, index)) {
      const candidate = call.childForFieldName("arguments")?.namedChildren[0];
      if (candidate !== undefined && isExactIdentifierValue(candidate, key, index.source)) uses.push(candidate);
      continue;
    }
    const functionNode = call.childForFieldName("function");
    if (functionNode?.type !== "identifier" || sourceText(functionNode, index.source) !== "delete") continue;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    if (args[0] !== undefined && args[1] !== undefined && isMutableStateExpression(args[0], index) &&
        isExactIdentifierValue(args[1], key, index.source)) uses.push(args[1]);
  }
  for (const expression of functionDescendants(callable, body, "index_expression")) {
    const operand = expression.childForFieldName("operand");
    const candidate = expression.childForFieldName("index");
    if (operand !== null && candidate !== null && isMutableStateExpression(operand, index) &&
        isExactIdentifierValue(candidate, key, index.source)) uses.push(candidate);
  }
  return uses;
}

function changedTerminatingGuardEvidence(
  file: SourceRevision,
  helper: ResolvedGoroutineIDHelper,
  previousRoot: Node | undefined,
): GoroutineIDChangedEvidence | undefined {
  if (file.status !== "modified" || file.previous === undefined || previousRoot === undefined) return undefined;
  const currentBody = helper.scope.childForFieldName("body");
  if (currentBody === null) return undefined;
  for (const statement of functionDescendants(helper.scope, currentBody, "if_statement")) {
    if (!isSemanticallyChangedEvidence(file, statement, previousRoot)) continue;
    const previous = correspondingNodeIgnoringComments(statement, previousRoot);
    const previousCondition = previous?.childForFieldName("condition");
    const previousHelper = previous === undefined ? null : findEnclosingCallable(previous);
    if (previous !== undefined && previousCondition !== null && previousCondition !== undefined &&
        previousHelper !== null &&
        isParsedIDZeroCondition(previousCondition, helper.parsedID, file.previous) &&
        guardTerminates(previous, previousHelper, file.previous, false)) {
      return { node: statement, metadata: { changeKind: "guard-change" } };
    }
  }
  return undefined;
}

function deletedTerminatingGuardEvidence(
  file: SourceRevision,
  helper: ResolvedGoroutineIDHelper,
  previousRoot: Node | undefined,
): GoroutineIDChangedEvidence | undefined {
  if (file.status !== "modified" || file.previous === undefined || previousRoot === undefined) return undefined;
  const currentName = helper.scope.childForFieldName("name");
  const currentBody = helper.scope.childForFieldName("body");
  if (currentName === null || currentBody === null) return undefined;
  const helperName = sourceText(currentName, file.current);
  const previousHelper = descendants(previousRoot, "function_declaration").find((fn) => {
    const name = fn.childForFieldName("name");
    return name !== null && sourceText(name, file.previous!) === helperName;
  });
  const previousBody = previousHelper?.childForFieldName("body");
  if (previousHelper === undefined || previousBody === null || previousBody === undefined) return undefined;
  const currentGuardSignatures = new Set(
    functionDescendants(helper.scope, currentBody, "if_statement")
      .map((statement) => semanticNodeSignature(statement, file.current)),
  );
  const deletedGuard = functionDescendants(previousHelper, previousBody, "if_statement").find((statement) => {
    const condition = statement.childForFieldName("condition");
    return condition !== null && isParsedIDZeroCondition(condition, helper.parsedID, file.previous!) &&
      guardTerminates(statement, previousHelper, file.previous!, false) &&
      !currentGuardSignatures.has(semanticNodeSignature(statement, file.previous!));
  });
  if (deletedGuard === undefined) return undefined;
  return {
    node: currentName,
    metadata: {
      changeKind: "deletion",
      deletedSemantic: "terminating-zero-guard",
      deletedLine: deletedGuard.startPosition.row + 1,
      anchorScope: helperName,
    },
  };
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

interface MutableStateIndex {
  root: Node;
  source: string;
  syncAlias: string | undefined;
  mapAliases: Set<string>;
  mapAliasDeclarations: Map<string, Node>;
  fields: Map<string, Set<string>>;
  fieldDeclarations: Map<string, Map<string, Node>>;
}

interface IdentifierBinding {
  mutable: boolean;
  namedType?: string;
  receiverOwned?: boolean;
  evidence: Node[];
}

function mutableStateIndex(root: Node, source: string, syncAlias: string | undefined): MutableStateIndex {
  const mapAliases = new Set<string>();
  const mapAliasDeclarations = new Map<string, Node>();
  const typeSpecs = [...descendants(root, "type_spec"), ...descendants(root, "type_alias")];
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const spec of typeSpecs) {
      if (spec.namedChildren.some((child) => child.type === "type_parameter_list")) continue;
      const name = spec.childForFieldName("name");
      const type = spec.childForFieldName("type");
      if (name === null || type === null) continue;
      const alias = sourceText(name, source);
      const target = sourceText(type, source).replace(/[\s()]/g, "");
      if (!mapAliases.has(alias) && (/^map\[/.test(target) || mapAliases.has(target))) {
        mapAliases.add(alias);
        mapAliasDeclarations.set(alias, spec);
        discovered = true;
      }
    }
  }
  const fields = new Map<string, Set<string>>();
  const fieldDeclarations = new Map<string, Map<string, Node>>();
  for (const spec of typeSpecs) {
    const name = spec.childForFieldName("name");
    const type = spec.childForFieldName("type");
    if (name === null || type?.type !== "struct_type") continue;
    const typeName = sourceText(name, source);
    for (const field of descendants(type, "field_declaration")) {
      if (nearestAncestor(field, "struct_type")?.id !== type.id) continue;
      const fieldType = field.childForFieldName("type");
      if (fieldType === null || !isMutableStateType(sourceText(fieldType, source), syncAlias, mapAliases)) continue;
      for (const fieldName of directDeclaredNames(field, source)) {
        const names = fields.get(typeName) ?? new Set<string>();
        names.add(fieldName);
        fields.set(typeName, names);
        const declarations = fieldDeclarations.get(typeName) ?? new Map<string, Node>();
        declarations.set(fieldName, field);
        fieldDeclarations.set(typeName, declarations);
      }
    }
  }
  return { root, source, syncAlias, mapAliases, mapAliasDeclarations, fields, fieldDeclarations };
}

function isMutableStateExpression(node: Node, index: MutableStateIndex): boolean {
  if (node.type === "identifier") {
    return resolveIdentifierBinding(sourceText(node, index.source), node, index)?.mutable === true;
  }
  if (node.type !== "selector_expression") return false;
  const receiver = node.childForFieldName("operand");
  const field = node.childForFieldName("field");
  if (receiver?.type !== "identifier" || field === null) return false;
  const binding = resolveIdentifierBinding(sourceText(receiver, index.source), node, index);
  const receiverType = binding?.namedType;
  return binding?.receiverOwned === true && receiverType !== undefined &&
    index.fields.get(receiverType)?.has(sourceText(field, index.source)) === true;
}

function mutableStateEvidence(node: Node, index: MutableStateIndex): Node[] {
  if (node.type === "identifier") {
    return resolveIdentifierBinding(sourceText(node, index.source), node, index)?.evidence ?? [];
  }
  if (node.type !== "selector_expression") return [];
  const receiver = node.childForFieldName("operand");
  const field = node.childForFieldName("field");
  if (receiver?.type !== "identifier" || field === null) return [];
  const receiverBinding = resolveIdentifierBinding(sourceText(receiver, index.source), node, index);
  const receiverType = receiverBinding?.namedType;
  if (receiverBinding?.receiverOwned !== true || receiverType === undefined) return [];
  const declaration = index.fieldDeclarations.get(receiverType)?.get(sourceText(field, index.source));
  return declaration === undefined ? [] : [...(receiverBinding?.evidence ?? []), declaration];
}

function resolveIdentifierBinding(
  name: string,
  use: Node,
  index: MutableStateIndex,
  excludedDeclarationId?: number,
): IdentifierBinding | undefined {
  const callable = findEnclosingCallable(use);
  if (callable !== null) {
    const body = callable.childForFieldName("body");
    if (body !== null) {
      const locals = [
        ...functionDescendants(callable, body, "var_spec"),
        ...functionDescendants(callable, body, "short_var_declaration"),
        ...functionDescendants(callable, body, "assignment_statement"),
        ...functionDescendants(callable, body, "range_clause"),
        ...functionDescendants(callable, body, "receive_statement"),
        ...functionDescendants(callable, body, "type_switch_statement"),
      ].filter((declaration) => declaration.id !== excludedDeclarationId &&
        declaration.startIndex < use.startIndex && declarationVisibleAt(declaration, use))
        .flatMap((declaration) => {
          const binding = bindingFromDeclaration(declaration, name, index);
          return binding === undefined ? [] : [{ binding, start: declaration.startIndex }];
        })
        .sort((left, right) => right.start - left.start);
      if (locals[0] !== undefined) return locals[0].binding;
    }
    for (const parameter of callableParameterDeclarations(callable)) {
      if (!directDeclaredNames(parameter, index.source).includes(name)) continue;
      const type = parameter.childForFieldName("type");
      if (type !== null) return bindingFromType(type, index, parameter);
    }
  }

  const globals = descendants(index.root, "var_spec")
    .filter((spec) => spec.id !== excludedDeclarationId && findEnclosingCallable(spec) === null)
    .flatMap((spec) => {
      const binding = bindingFromDeclaration(spec, name, index);
      return binding === undefined ? [] : [{ binding, start: spec.startIndex }];
    })
    .sort((left, right) => right.start - left.start);
  return globals[0]?.binding;
}

function bindingFromDeclaration(declaration: Node, name: string, index: MutableStateIndex): IdentifierBinding | undefined {
  if (declaration.type === "var_spec") {
    const names = directDeclaredNames(declaration, index.source);
    const offset = names.indexOf(name);
    if (offset < 0) return undefined;
    const type = declaration.childForFieldName("type");
    if (type !== null) return bindingFromType(type, index, declaration);
    const values = declaration.namedChildren.find((node) => node.type === "expression_list")?.namedChildren ?? [];
    const value = values.length === names.length ? values[offset] : values[0];
    return value === undefined ? { mutable: false, evidence: [declaration] } : bindingFromValue(value, index, declaration);
  }
  if (declaration.type === "short_var_declaration" || declaration.type === "assignment_statement") {
    const left = declaration.childForFieldName("left")?.namedChildren ?? [];
    const right = declaration.childForFieldName("right")?.namedChildren ?? [];
    const offset = left.findIndex((node) => node.type === "identifier" && sourceText(node, index.source) === name);
    if (offset < 0) return undefined;
    const value = right.length === left.length ? right[offset] : right[0];
    return value === undefined ? { mutable: false, evidence: [declaration] } : bindingFromValue(value, index, declaration);
  }
  if (declaration.type === "range_clause" || declaration.type === "receive_statement" ||
      declaration.type === "type_switch_statement") {
    return controlBindingNames(declaration, index.source).includes(name)
      ? { mutable: false, evidence: [declaration] }
      : undefined;
  }
  return undefined;
}

function bindingFromType(type: Node, index: MutableStateIndex, declaration: Node): IdentifierBinding {
  const text = sourceText(type, index.source);
  const resolved = namedType(text);
  const alias = resolved === undefined ? undefined : index.mapAliasDeclarations.get(resolved);
  return {
    mutable: isMutableStateType(text, index.syncAlias, index.mapAliases),
    ...(resolved === undefined ? {} : { namedType: resolved }),
    ...(isMethodReceiverDeclaration(declaration) ? { receiverOwned: true } : {}),
    evidence: alias === undefined ? [declaration] : [declaration, alias],
  };
}

function isMethodReceiverDeclaration(declaration: Node): boolean {
  let current = declaration.parent;
  while (current !== null && current.type !== "method_declaration" && current.type !== "function_declaration") {
    if (current.parent?.type === "method_declaration") {
      return current.parent.childForFieldName("receiver")?.id === current.id;
    }
    current = current.parent;
  }
  return false;
}

function bindingFromValue(value: Node, index: MutableStateIndex, declaration: Node): IdentifierBinding {
  const aliased = aliasedMutableStateBinding(value, index, declaration);
  if (aliased?.mutable === true || aliased?.namedType !== undefined) {
    return { ...aliased, evidence: [declaration, ...aliased.evidence] };
  }
  const text = sourceText(value, index.source);
  const type = initializedNamedType(text);
  const alias = type === undefined ? undefined : index.mapAliasDeclarations.get(type);
  return {
    mutable: isMutableStateInitializer(text, index.syncAlias, index.mapAliases),
    ...(type === undefined ? {} : { namedType: type }),
    evidence: alias === undefined ? [declaration] : [declaration, alias],
  };
}

function aliasedMutableStateBinding(
  value: Node,
  index: MutableStateIndex,
  declaration: Node,
): IdentifierBinding | undefined {
  if (value.type === "identifier") {
    return resolveIdentifierBinding(sourceText(value, index.source), value, index, declaration.id);
  }
  if (value.type !== "selector_expression") return undefined;
  const receiver = value.childForFieldName("operand");
  const field = value.childForFieldName("field");
  if (receiver?.type !== "identifier" || field === null) return undefined;
  const receiverType = resolveIdentifierBinding(
    sourceText(receiver, index.source), value, index, declaration.id)?.namedType;
  if (receiverType === undefined) return undefined;
  const fieldName = sourceText(field, index.source);
  const fieldDeclaration = index.fieldDeclarations.get(receiverType)?.get(fieldName);
  return fieldDeclaration === undefined
    ? undefined
    : { mutable: true, evidence: [fieldDeclaration] };
}

function directDeclaredNames(declaration: Node, source: string): string[] {
  const type = declaration.childForFieldName("type");
  return declaration.namedChildren
    .filter((node) => (node.type === "identifier" || node.type === "field_identifier") &&
      (type === null || node.endIndex <= type.startIndex))
    .map((node) => sourceText(node, source));
}

function declarationVisibleAt(declaration: Node, use: Node): boolean {
  let scope = declaration.parent;
  const lexicalScopes = new Set([
    "block", "source_file", "if_statement", "for_statement", "expression_switch_statement",
    "type_switch_statement", "expression_case", "type_case", "communication_case",
  ]);
  while (scope !== null && !lexicalScopes.has(scope.type)) scope = scope.parent;
  return scope !== null && use.startIndex >= scope.startIndex && use.endIndex <= scope.endIndex;
}

function nearestAncestor(node: Node, type: string): Node | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return null;
}

function namedType(type: string): string | undefined {
  const normalized = type.replace(/[\s*()]/g, "");
  return /^[A-Za-z_]\w*$/.test(normalized) ? normalized : undefined;
}

function initializedNamedType(value: string): string | undefined {
  return /^&?([A-Za-z_]\w*)\s*\{/.exec(value.trim())?.[1];
}

function isMutableStateType(type: string, syncAlias: string | undefined, mapAliases: Set<string>): boolean {
  const normalized = type.replace(/\s+/g, "");
  return /^map\[/.test(normalized) || mapAliases.has(normalized.replace(/[()]/g, "")) ||
    (syncAlias !== undefined && (normalized === `${syncAlias}.Map` || normalized === `*${syncAlias}.Map`));
}

function isMutableStateInitializer(value: string, syncAlias: string | undefined, mapAliases: Set<string>): boolean {
  const initialized = initializedNamedType(value);
  const made = /^make\s*\(\s*([A-Za-z_]\w*)\s*(?:,|\))/.exec(value)?.[1];
  return /^make\s*\(\s*map\s*\[/.test(value) ||
    /^map\s*\[.*\]\s*.*\{/.test(value) ||
    (made !== undefined && mapAliases.has(made)) ||
    (initialized !== undefined && mapAliases.has(initialized)) ||
    (syncAlias !== undefined && new RegExp(`^&?${syncAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.Map\\s*\\{`).test(value));
}

function directHelperCall(
  key: Node,
  source: string,
  helpers: Map<string, GoroutineIDHelper>,
): ResolvedGoroutineIDHelper | undefined {
  if (key.type === "call_expression") return helperCall(key, source, helpers);
  if (key.type !== "identifier") return undefined;
  const enclosing = findEnclosingCallable(key);
  const body = enclosing?.childForFieldName("body");
  if (enclosing === null || enclosing === undefined || body === null || body === undefined) return undefined;
  const keyName = sourceText(key, source);
  const assignments = [
    ...functionDescendants(enclosing, body, "short_var_declaration"),
    ...functionDescendants(enclosing, body, "assignment_statement"),
  ].filter((assignment) => assignment.startIndex < key.startIndex && declarationVisibleAt(assignment, key))
    .flatMap((assignment) => {
      const left = assignment.childForFieldName("left")?.namedChildren ?? [];
      const right = assignment.childForFieldName("right")?.namedChildren ?? [];
      const offset = left.findIndex((node) => node.type === "identifier" && sourceText(node, source) === keyName);
      if (offset < 0) return [];
      const value = right.length === left.length ? right[offset] : right[0];
      return [{ assignment, value }];
    })
    .sort((left, right) => left.assignment.startIndex - right.assignment.startIndex);
  const origins = assignments.flatMap((candidate) => {
    if (candidate.value?.type !== "call_expression") return [];
    const resolved = helperCall(candidate.value, source, helpers);
    return resolved === undefined ? [] : [{ ...candidate, resolved }];
  });
  const origin = origins.at(-1);
  if (origin === undefined) return undefined;
  const transformations = assignments.filter((candidate) => candidate.assignment.startIndex > origin.assignment.endIndex);
  if (transformations.some((candidate) => candidate.value === undefined ||
      (!assignmentUsesPreviousBinding(candidate.assignment, keyName, source) &&
        !containsIdentifier(candidate.value, source, keyName) && integerNodeValue(candidate.value, source) !== 0))) {
    return undefined;
  }
  if (hasTerminatingKeyGuard(enclosing, body, origin.assignment, key, keyName, source)) return undefined;
  return {
    ...origin.resolved,
    anchors: [...origin.resolved.anchors, origin.assignment, ...transformations.map((candidate) => candidate.assignment)],
    callerKey: { scope: enclosing, assignment: origin.assignment, use: key, key: keyName },
  };
}

interface ResolvedGoroutineIDHelper extends GoroutineIDHelper {
  helper: string;
  callerKey?: {
    scope: Node;
    assignment: Node;
    use: Node;
    key: string;
  };
}

function helperCall(
  call: Node,
  source: string,
  helpers: Map<string, GoroutineIDHelper>,
): ResolvedGoroutineIDHelper | undefined {
  const functionNode = call.childForFieldName("function");
  if (functionNode?.type !== "identifier") return undefined;
  const helper = sourceText(functionNode, source);
  const resolved = helpers.get(helper);
  if (resolved === undefined) return undefined;
  const enclosing = findEnclosingCallable(call);
  if (enclosing !== null && isLocallyShadowedAt(enclosing, call, source, helper)) return undefined;
  return { helper, ...resolved };
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

function isSemanticallyChangedEvidence(file: SourceRevision, node: Node, previousRoot: Node | undefined): boolean {
  if (!isChangedEvidence(file, node.startPosition.row + 1, node.endPosition.row + 1)) return false;
  if (file.status !== "modified" || file.previous === undefined || previousRoot === undefined) return true;
  const previous = correspondingNodeIgnoringComments(node, previousRoot);
  return previous === undefined || semanticNodeSignature(node, file.current) !== semanticNodeSignature(previous, file.previous);
}

function correspondingNodeIgnoringComments(node: Node, previousRoot: Node): Node | undefined {
  const path: number[] = [];
  let current = node;
  while (current.parent !== null) {
    const siblings = nonCommentChildren(current.parent);
    const offset = siblings.findIndex((child) => child.id === current.id);
    if (offset < 0) return undefined;
    path.unshift(offset);
    current = current.parent;
  }
  let previous = previousRoot;
  for (const offset of path) {
    const next = nonCommentChildren(previous)[offset];
    if (next === undefined) return undefined;
    previous = next;
  }
  return previous.type === node.type ? previous : undefined;
}

function nonCommentChildren(node: Node): Node[] {
  const children: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child !== null && child.type !== "comment") children.push(child);
  }
  return children;
}

function semanticNodeSignature(node: Node, source: string): string {
  const children = nonCommentChildren(node);
  if (children.length === 0) return `${node.type}:${sourceText(node, source)}`;
  return `${node.type}(${children.map((child) => semanticNodeSignature(child, source)).join(",")})`;
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
      .filter((call): call is { operand: string; operandNode: Node; field: string } => call !== undefined && call.field === "Load");
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

function selectedCall(call: Node, source: string): { operand: string; operandNode: Node; field: string } | undefined {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "selector_expression") return undefined;
  const operand = fn.childForFieldName("operand");
  const field = fn.childForFieldName("field");
  if (operand === null || field === null) return undefined;
  return { operand: sourceText(operand, source), operandNode: operand, field: sourceText(field, source) };
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
