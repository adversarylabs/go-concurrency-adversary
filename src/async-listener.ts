import { posix } from "node:path";
import { type Node, type Tree } from "web-tree-sitter";
import { descendants, parseGo, sourceText } from "./parser.js";
import { type Discovery, type Signal, type SourceRevision } from "./types.js";

interface ParsedFile {
  file: SourceRevision;
  tree: Tree;
  root: Node;
  packageName: string;
  directory: string;
  importsByAlias: Map<string, string>;
}

interface EvidenceNode {
  parsed: ParsedFile;
  node: Node;
}

interface AsyncListenerHelper {
  parsed: ParsedFile;
  name: string;
  listenerParameter: string;
  listenerParameterIndex: number;
  callbackParameter: string;
  callbackParameterIndex: number;
  goStatement: Node;
  callbackCall: Node;
}

interface ServerType {
  parsed: ParsedFile;
  name: string;
  handlerField: string;
  declaration: Node;
  field: Node;
}

interface AsyncListenerFact {
  signature: string;
  server: ServerType;
  startMethod: Node;
  helper: AsyncListenerHelper;
  asyncCall: Node;
  evidence: EvidenceNode[];
}

/**
 * Finds the narrow listener lifecycle exposed by containerd/containerd#12562:
 * a Start method owns net/http.Server, passes its Serve method and a
 * net.Listener to a locally proven goroutine-launching helper, returns, and no
 * method on the owner can close/shut down that server.
 *
 * This is intentionally a program-level pass. The helper and the wrapper live
 * in different Go packages in the grounding change, so a per-file spelling
 * check cannot prove that serving is asynchronous.
 */
export async function analyzeAsyncListenerOwnership(discovery: Discovery): Promise<Signal[]> {
  const current = await parseRelevantFiles(discovery.files, false);
  const previous = discovery.mode === "diff"
    ? await parseRelevantFiles(discovery.files, true)
    : [];
  try {
    const currentFacts = collectFacts(current, discovery.modulePath);
    const previousSignatures = new Set(collectFacts(previous, discovery.modulePath).map((fact) => fact.signature));
    const signals: Signal[] = [];
    for (const fact of currentFacts) {
      if (discovery.mode === "diff" && previousSignatures.has(fact.signature)) continue;
      const anchor = fact.evidence.find(({ parsed, node }) =>
        changedEvidence(discovery.mode, parsed.file, node));
      // A deletion-only change can make an existing owner unsafe, but the
      // runtime currently supplies no surviving changed line for that case.
      // Stay quiet instead of anchoring unchanged code.
      if (discovery.mode === "diff" && anchor === undefined) continue;
      const selected = anchor ?? fact.evidence[0]!;
      signals.push(makeSignal(selected.parsed.file, selected.node, fact));
    }
    return signals;
  } finally {
    for (const parsed of [...current, ...previous]) parsed.tree.delete();
  }
}

async function parseRelevantFiles(files: SourceRevision[], previous: boolean): Promise<ParsedFile[]> {
  const parsed: ParsedFile[] = [];
  for (const file of files) {
    if (file.path.endsWith("_test.go")) continue;
    if (previous && file.status === "added" && file.previous === undefined) continue;
    const source = previous ? (file.previous ?? file.current) : file.current;
    // Avoid reparsing the whole repository for a deliberately rare rule.
    if (!/(?:net\/http|net\b|\.Serve\b|go\s+func|func\s*(?:\([^)]*\)\s*)?\w+\s*\()/.test(source)) continue;
    try {
      const tree = await parseGo(source);
      if (tree.rootNode.hasError) {
        tree.delete();
        continue;
      }
      parsed.push({
        file: previous ? { ...file, current: source } : file,
        tree,
        root: tree.rootNode,
        packageName: packageName(tree.rootNode, source),
        directory: posix.dirname(file.path),
        importsByAlias: importsByAlias(tree.rootNode, source),
      });
    } catch {
      // The ordinary per-file analyzer records syntax/parser errors. This
      // supplementary relationship pass simply fails closed.
    }
  }
  return parsed;
}

function collectFacts(files: ParsedFile[], modulePath: string | undefined): AsyncListenerFact[] {
  const helpers = files.flatMap(collectAsyncHelpers);
  const serverTypes = files.flatMap(collectHTTPServerTypes);
  const methods = files.flatMap((parsed) =>
    descendants(parsed.root, "method_declaration").map((node) => ({ parsed, node })));
  const facts: AsyncListenerFact[] = [];

  for (const server of serverTypes) {
    if (server.parsed.packageName === "main") continue;
    const typeMethods = methods.filter(({ parsed, node }) =>
      samePackage(parsed, server.parsed) && receiverType(node, parsed.file.current) === server.name);
    if (typeMethods.some(({ parsed, node }) =>
      methodStopsField(node, parsed.file.current, server.handlerField))) continue;

    for (const { parsed, node: method } of typeMethods) {
      if (methodName(method, parsed.file.current) !== "Start") continue;
      if (!startContract(method, parsed)) continue;
      const body = method.childForFieldName("body");
      if (body === null) continue;
      const receiver = receiverName(method, parsed.file.current);
      if (receiver === undefined) continue;
      const listenerOrigins = listenerVariables(body, parsed);
      if (listenerOrigins.size === 0) continue;

      for (const call of directCallableDescendants(body, "call_expression")) {
        if (!nodeIsReachable(call, body, parsed.file.current)) continue;
        const helper = resolveAsyncHelper(call, parsed, helpers, modulePath, body);
        if (helper === undefined) continue;
        const args = call.childForFieldName("arguments")?.namedChildren ?? [];
        const listener = args[helper.listenerParameterIndex];
        const serveMethod = args[helper.callbackParameterIndex];
        const listenerName = listener?.type === "identifier"
          ? sourceText(listener, parsed.file.current)
          : undefined;
        const listenerOrigin = listenerName === undefined ? undefined : listenerOrigins.get(listenerName);
        if (listener?.type !== "identifier" || listenerOrigin === undefined ||
            bindingChangesBetween(body, listenerName!, listenerOrigin.endIndex, call, parsed.file.current) ||
            serveMethod === undefined ||
            !isHandlerServeMethod(serveMethod, parsed.file.current, receiver, server.handlerField, body)) continue;
        const evidence: EvidenceNode[] = [
          { parsed: server.parsed, node: server.field },
          { parsed, node: method.childForFieldName("name") ?? method },
          { parsed, node: call },
          { parsed: helper.parsed, node: helper.goStatement },
          ...typeMethods
            .filter((candidate) => candidate.parsed !== parsed || candidate.node.id !== method.id)
            .map((candidate) => ({ parsed: candidate.parsed, node: candidate.node })),
        ];
        const signature = [
          server.parsed.directory,
          server.parsed.packageName,
          server.name,
          server.handlerField,
          helper.parsed.directory,
          helper.parsed.packageName,
          helper.name,
          semantic(sourceText(listener, parsed.file.current)),
          semantic(sourceText(serveMethod, parsed.file.current)),
        ].join("|");
        facts.push({ signature, server, startMethod: method, helper, asyncCall: call, evidence });
      }
    }
  }
  return facts;
}

function collectHTTPServerTypes(parsed: ParsedFile): ServerType[] {
  const httpAlias = aliasForPath(parsed.importsByAlias, "net/http");
  if (httpAlias === undefined) return [];
  const source = parsed.file.current;
  const facts: ServerType[] = [];
  for (const spec of descendants(parsed.root, "type_spec")) {
    const name = spec.childForFieldName("name");
    const type = spec.childForFieldName("type");
    if (name === null || type?.type !== "struct_type") continue;
    for (const field of descendants(type, "field_declaration")) {
      if (nearestAncestor(field, "struct_type")?.id !== type.id) continue;
      const fieldType = field.childForFieldName("type");
      if (fieldType === null || normalize(sourceText(fieldType, source)) !== `*${httpAlias}.Server`) continue;
      for (const fieldName of declaredNames(field, source)) {
        facts.push({
          parsed,
          name: sourceText(name, source),
          handlerField: fieldName,
          declaration: spec,
          field,
        });
      }
    }
  }
  return facts;
}

function collectAsyncHelpers(parsed: ParsedFile): AsyncListenerHelper[] {
  const netAlias = aliasForPath(parsed.importsByAlias, "net");
  if (netAlias === undefined) return [];
  const source = parsed.file.current;
  const helpers: AsyncListenerHelper[] = [];
  for (const fn of descendants(parsed.root, "function_declaration")) {
    const name = fn.childForFieldName("name");
    const body = fn.childForFieldName("body");
    if (name === null || body === null) continue;
    const parameters = directParameterBindings(fn, source);
    const listener = parameters.find((parameter) => normalize(parameter.type) === `${netAlias}.Listener`);
    const callback = parameters.find((parameter) =>
      normalize(parameter.type) === `func${netAlias}.Listenererror`);
    if (listener === undefined || callback === undefined) continue;
    const listenerName = listener.name;
    const callbackName = callback.name;
    // A helper that directly stops the listener owns shutdown itself. Merely
    // observing cancellation does not release the listener or serving goroutine.
    if (helperStopsListener(body, source, listenerName)) continue;

    for (const goStatement of directCallableDescendants(body, "go_statement")) {
      if (!nodeIsReachable(goStatement, body, source)) continue;
      if (bindingChangesBetween(body, listenerName, body.startIndex, goStatement, source) ||
          bindingChangesBetween(body, callbackName, body.startIndex, goStatement, source)) continue;
      const invocation = goStatement.namedChildren.find((node) => node.type === "call_expression");
      const literal = invocation?.childForFieldName("function");
      if (literal?.type !== "func_literal") continue;
      const literalBody = literal.childForFieldName("body");
      if (literalBody === null) continue;
      const callbackCall = directCallableDescendants(literalBody, "call_expression").find((call) => {
        if (!nodeIsReachable(call, literalBody, source)) return false;
        const called = call.childForFieldName("function");
        const args = call.childForFieldName("arguments")?.namedChildren ?? [];
        return called?.type === "identifier" && sourceText(called, source) === callbackName &&
          !localBindingShadowsAtUse(literalBody, callbackName, call, source) &&
          args.length === 1 && args[0]?.type === "identifier" && sourceText(args[0], source) === listenerName &&
          !localBindingShadowsAtUse(literalBody, listenerName, args[0], source);
      });
      if (callbackCall === undefined || !defersListenerClose(literalBody, source, listenerName)) continue;
      helpers.push({
        parsed,
        name: sourceText(name, source),
        listenerParameter: listenerName,
        listenerParameterIndex: listener.index,
        callbackParameter: callbackName,
        callbackParameterIndex: callback.index,
        goStatement,
        callbackCall,
      });
    }
  }
  return helpers;
}

function resolveAsyncHelper(
  call: Node,
  caller: ParsedFile,
  helpers: AsyncListenerHelper[],
  modulePath: string | undefined,
  callerBody: Node,
): AsyncListenerHelper | undefined {
  const fn = call.childForFieldName("function");
  if (fn?.type === "identifier") {
    const name = sourceText(fn, caller.file.current);
    if (callableParameterNamed(callerBody, name, caller.file.current) ||
        localBindingShadowsAtUse(callerBody, name, call, caller.file.current)) return undefined;
    return helpers.find((helper) => helper.name === name && samePackage(helper.parsed, caller));
  }
  if (fn?.type !== "selector_expression") return undefined;
  const operand = fn.childForFieldName("operand");
  const field = fn.childForFieldName("field");
  if (operand?.type !== "identifier" || field === null) return undefined;
  const alias = sourceText(operand, caller.file.current);
  if (callableParameterNamed(callerBody, alias, caller.file.current) ||
      localBindingShadowsAtUse(callerBody, alias, call, caller.file.current)) return undefined;
  const importPath = caller.importsByAlias.get(alias);
  if (importPath === undefined) return undefined;
  const name = sourceText(field, caller.file.current);
  return helpers.find((helper) => helper.name === name && importResolvesTo(importPath, helper.parsed, modulePath));
}

function startContract(method: Node, parsed: ParsedFile): boolean {
  const contextAlias = aliasForPath(parsed.importsByAlias, "context");
  if (contextAlias === undefined) return false;
  const source = parsed.file.current;
  const parameters = directParameters(method);
  const hasContext = parameters.some((parameter) =>
    normalize(sourceText(parameter.childForFieldName("type") ?? parameter, source)) === `${contextAlias}.Context`);
  const result = method.childForFieldName("result");
  return hasContext && result !== null && /(^|[^A-Za-z0-9_])error([^A-Za-z0-9_]|$)/
    .test(sourceText(result, source));
}

function listenerVariables(body: Node, parsed: ParsedFile): Map<string, Node> {
  const source = parsed.file.current;
  const netAlias = aliasForPath(parsed.importsByAlias, "net");
  if (netAlias === undefined) return new Map();
  const names = new Map<string, Node>();
  for (const assignment of directCallableDescendants(body, "short_var_declaration")) {
    const left = assignment.childForFieldName("left")?.namedChildren ?? [];
    const right = assignment.childForFieldName("right")?.namedChildren ?? [];
    for (let index = 0; index < right.length; index += 1) {
      const value = right[index];
      if (value?.type !== "call_expression") continue;
      const fn = value.childForFieldName("function");
      if (fn?.type === "selector_expression" &&
          sourceText(fn.childForFieldName("operand") ?? fn, source) === netAlias &&
          sourceText(fn.childForFieldName("field") ?? fn, source) === "Listen" &&
          !callableParameterNamed(body, netAlias, source) &&
          !localBindingShadowsAtUse(body, netAlias, value, source) &&
          nodeIsReachable(value, body, source)) {
        const target = left[index] ?? left[0];
        if (target?.type === "identifier") names.set(sourceText(target, source), assignment);
      }
    }
  }
  return names;
}

function methodStopsField(method: Node, source: string, fieldName: string): boolean {
  const body = method.childForFieldName("body");
  const receiver = receiverName(method, source);
  if (body === null || receiver === undefined) return false;
  const aliases = new Map<string, Node>();
  for (const declaration of directCallableDescendants(body, "short_var_declaration")) {
    const left = declaration.childForFieldName("left")?.namedChildren ?? [];
    const right = declaration.childForFieldName("right")?.namedChildren ?? [];
    if (left.length !== 1 || right.length !== 1 || left[0]?.type !== "identifier") continue;
    if (isReceiverField(right[0]!, source, receiver, fieldName, body)) {
      aliases.set(sourceText(left[0], source), declaration);
    }
  }
  // Any syntactic close/shutdown path on the owned field is enough to stay
  // quiet here. Proving that path is wired into daemon shutdown is a broader
  // ownership question; this rule is specifically for the complete absence of
  // a stop mechanism.
  return descendants(body, "call_expression").some((call) => {
    if (!callIsDefinitelyActive(call, body) || !nodeIsReachable(call, body, source)) return false;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return false;
    const operand = fn.childForFieldName("operand");
    const selected = fn.childForFieldName("field");
    if (operand === null || selected === null || !/^(?:Close|Shutdown|Stop)$/.test(sourceText(selected, source))) {
      return false;
    }
    if (isReceiverField(operand, source, receiver, fieldName, body)) return true;
    if (operand.type !== "identifier") return false;
    const alias = sourceText(operand, source);
    const declaration = aliases.get(alias);
    return declaration !== undefined && declaration.endIndex < call.startIndex &&
      declarationScopeContainsUse(declaration, call) &&
      !bindingChangesBetween(body, alias, declaration.endIndex, call, source);
  });
}

function helperStopsListener(body: Node, source: string, listenerName: string): boolean {
  return descendants(body, "call_expression").some((call) => {
    if (!callIsDefinitelyActive(call, body) || !nodeIsReachable(call, body, source)) return false;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return false;
    const operand = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    if (operand?.type !== "identifier" || field === null || sourceText(operand, source) !== listenerName ||
        localBindingShadowsAtUse(body, listenerName, operand, source)) return false;
    const selected = sourceText(field, source);
    if (!/^(?:Close|Shutdown|Stop)$/.test(selected)) return false;
    if (bindingChangesBetween(body, listenerName, body.startIndex, call, source)) return false;
    // The exact helper defers listener.Close inside the serving goroutine. That
    // releases the socket only after Serve returns; it is not a stop path.
    return !insideDeferStatement(call);
  });
}

function callIsDefinitelyActive(call: Node, callableBody: Node): boolean {
  let current: Node | null = call.parent;
  while (current !== null && current.id !== callableBody.id) {
    if (current.type === "func_literal") {
      const invocation = current.parent;
      if (invocation?.type !== "call_expression" || invocation.childForFieldName("function")?.id !== current.id) {
        return false;
      }
      const execution = invocation.parent;
      if (execution?.type !== "go_statement" && execution?.type !== "expression_statement") return false;
      current = execution.parent;
      continue;
    }
    current = current.parent;
  }
  return current?.id === callableBody.id;
}

function defersListenerClose(body: Node, source: string, listenerName: string): boolean {
  return descendants(body, "defer_statement").some((statement) =>
    nodeIsReachable(statement, body, source) && descendants(statement, "call_expression").some((call) => {
      if (!callIsDefinitelyActive(call, body) ||
          bindingChangesBetween(body, listenerName, body.startIndex, call, source)) return false;
      const fn = call.childForFieldName("function");
      if (fn?.type !== "selector_expression") return false;
      const operand = fn.childForFieldName("operand");
      const field = fn.childForFieldName("field");
      return operand?.type === "identifier" && field !== null &&
        sourceText(operand, source) === listenerName && sourceText(field, source) === "Close" &&
        !localBindingShadowsAtUse(body, listenerName, operand, source);
    }));
}

function isHandlerServeMethod(
  node: Node,
  source: string,
  receiver: string,
  fieldName: string,
  body: Node,
): boolean {
  if (node.type !== "selector_expression") return false;
  const operand = node.childForFieldName("operand");
  const field = node.childForFieldName("field");
  return operand !== null && field !== null && sourceText(field, source) === "Serve" &&
    isReceiverField(operand, source, receiver, fieldName, body);
}

function isReceiverField(
  node: Node,
  source: string,
  receiver: string,
  fieldName: string,
  body?: Node,
): boolean {
  if (node.type !== "selector_expression") return false;
  const operand = node.childForFieldName("operand");
  const field = node.childForFieldName("field");
  return operand?.type === "identifier" && field !== null &&
    sourceText(operand, source) === receiver && sourceText(field, source) === fieldName &&
    (body === undefined || !localBindingShadowsAtUse(body, receiver, operand, source));
}

function localBindingShadowsAtUse(body: Node, name: string, use: Node, source: string): boolean {
  const declarations = [
    ...descendants(body, "short_var_declaration"),
    ...descendants(body, "var_spec"),
    ...descendants(body, "const_spec"),
  ];
  return declarations.some((declaration) => declaration.startIndex < use.startIndex &&
    bindingNames(declaration, source).includes(name) && declarationScopeContainsUse(declaration, use));
}

function callableParameterNamed(body: Node, name: string, source: string): boolean {
  const callable = body.parent;
  return callable !== null && callable.childForFieldName("body")?.id === body.id &&
    directParameters(callable).some((parameter) => declaredNames(parameter, source).includes(name));
}

function declarationScopeContainsUse(declaration: Node, use: Node): boolean {
  const block = enclosingBlock(declaration);
  if (block === null) return false;
  let current = declaration.parent;
  while (current !== null && current.id !== block.id) {
    if (["if_statement", "for_statement", "expression_switch_statement", "type_switch_statement",
      "select_statement"].includes(current.type)) return containsNode(current, use);
    current = current.parent;
  }
  return containsNode(block, use);
}

function bindingChangesBetween(
  body: Node,
  name: string,
  startIndex: number,
  use: Node,
  source: string,
): boolean {
  const changes = [
    ...descendants(body, "assignment_statement"),
    ...descendants(body, "short_var_declaration"),
  ];
  return changes.some((change) => change.startIndex > startIndex && change.endIndex < use.startIndex &&
    bindingNames(change, source).includes(name) && declarationScopeContainsUse(change, use));
}

function bindingNames(node: Node, source: string): string[] {
  if (node.type === "short_var_declaration" || node.type === "assignment_statement") {
    const left = node.childForFieldName("left");
    if (left === null) return [];
    return descendants(left, "identifier").map((candidate) => sourceText(candidate, source));
  }
  return declaredNames(node, source);
}

function nodeIsReachable(node: Node, callableBody: Node, source: string): boolean {
  let current: Node | null = node;
  while (current !== null && current.id !== callableBody.id) {
    const parent: Node | null = current.parent;
    if (parent === null) return false;
    if (parent.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      const consequence = parent.childForFieldName("consequence");
      const alternative = parent.childForFieldName("alternative");
      const value = condition === null ? undefined : staticBoolean(condition, source);
      if ((value === false && consequence !== null && containsNode(consequence, current)) ||
          (value === true && alternative !== null && containsNode(alternative, current))) return false;
    }
    const statements = directStatements(parent);
    const containingIndex = statements.findIndex((statement) => containsNode(statement, current!));
    if (containingIndex >= 0 && statements.slice(0, containingIndex).some(unconditionallyTerminates)) return false;
    current = parent;
  }
  return current?.id === callableBody.id;
}

function directStatements(node: Node): Node[] {
  const list = node.namedChildren.find((child) => child.type === "statement_list");
  return list?.namedChildren ?? (node.type === "block" || node.type.endsWith("_case") ? node.namedChildren : []);
}

function unconditionallyTerminates(statement: Node): boolean {
  return statement.type === "return_statement" || statement.type === "goto_statement" ||
    statement.type === "break_statement" || statement.type === "continue_statement";
}

function staticBoolean(node: Node, source: string): boolean | undefined {
  const value = normalize(sourceText(node, source));
  if (value === "false") return false;
  if (value === "true") return true;
  return undefined;
}

function enclosingBlock(node: Node): Node | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === "block" || current.type.endsWith("_case")) return current;
    current = current.parent;
  }
  return null;
}

function containsNode(outer: Node, inner: Node): boolean {
  return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;
}

function directCallableDescendants(node: Node, type: string): Node[] {
  const result: Node[] = [];
  const pending = [...node.namedChildren].reverse();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current.type === type) result.push(current);
    if (current.type === "func_literal") continue;
    for (let index = current.namedChildCount - 1; index >= 0; index -= 1) {
      const child = current.namedChild(index);
      if (child !== null) pending.push(child);
    }
  }
  return result;
}

function directParameters(callable: Node): Node[] {
  const parameters = callable.childForFieldName("parameters");
  return parameters === null ? [] : parameters.namedChildren.filter((node) =>
    node.type === "parameter_declaration" || node.type === "variadic_parameter_declaration");
}

function directParameterBindings(callable: Node, source: string): Array<{ name: string; type: string; index: number }> {
  const result: Array<{ name: string; type: string; index: number }> = [];
  let index = 0;
  for (const parameter of directParameters(callable)) {
    const type = parameter.childForFieldName("type");
    const names = declaredNames(parameter, source);
    if (names.length === 0) {
      index += 1;
      continue;
    }
    for (const name of names) {
      result.push({ name, type: sourceText(type ?? parameter, source), index });
      index += 1;
    }
  }
  return result;
}

function receiverName(method: Node, source: string): string | undefined {
  const receiver = method.childForFieldName("receiver");
  const declaration = receiver === null ? undefined : descendants(receiver, "parameter_declaration")[0];
  return declaration === undefined ? undefined : declaredNames(declaration, source)[0];
}

function receiverType(method: Node, source: string): string | undefined {
  const receiver = method.childForFieldName("receiver");
  const declaration = receiver === null ? undefined : descendants(receiver, "parameter_declaration")[0];
  const type = declaration?.childForFieldName("type");
  if (type === undefined || type === null) return undefined;
  const normalized = normalize(sourceText(type, source)).replace(/^\*+/, "");
  return /^[A-Za-z_]\w*$/.test(normalized) ? normalized : undefined;
}

function methodName(method: Node, source: string): string | undefined {
  const name = method.childForFieldName("name");
  return name === null ? undefined : sourceText(name, source);
}

function declaredNames(declaration: Node, source: string): string[] {
  const type = declaration.childForFieldName("type");
  return declaration.namedChildren
    .filter((node) => (node.type === "identifier" || node.type === "field_identifier") &&
      (type === null || node.endIndex <= type.startIndex))
    .map((node) => sourceText(node, source));
}

function packageName(root: Node, source: string): string {
  const clause = descendants(root, "package_clause")[0];
  const name = clause?.namedChildren.find((node) =>
    node.type === "package_identifier" || node.type === "identifier");
  return name === undefined ? "" : sourceText(name, source);
}

function importsByAlias(root: Node, source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const spec of descendants(root, "import_spec")) {
    const text = sourceText(spec, source).trim();
    const match = /^(?:(\.|_|[A-Za-z_]\w*)\s+)?["`]([^"`]+)["`]$/.exec(text);
    if (match === null || match[1] === "_" || match[1] === ".") continue;
    const path = match[2]!;
    result.set(match[1] ?? path.split("/").at(-1)!, path);
  }
  return result;
}

function aliasForPath(imports: Map<string, string>, path: string): string | undefined {
  for (const [alias, candidate] of imports) if (candidate === path) return alias;
  return undefined;
}

function importResolvesTo(importPath: string, target: ParsedFile, modulePath: string | undefined): boolean {
  if (modulePath === undefined) return false;
  const expected = target.directory === "." ? modulePath : `${modulePath}/${target.directory}`;
  return importPath === expected && posix.basename(importPath) === target.packageName;
}

function samePackage(left: ParsedFile, right: ParsedFile): boolean {
  return left.directory === right.directory && left.packageName === right.packageName;
}

function nearestAncestor(node: Node, type: string): Node | null {
  let current = node.parent;
  while (current !== null) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return null;
}

function insideDeferStatement(node: Node): boolean {
  let current = node.parent;
  while (current !== null) {
    if (current.type === "defer_statement") return true;
    if (current.type === "function_declaration" || current.type === "method_declaration") return false;
    current = current.parent;
  }
  return false;
}

function changedEvidence(mode: Discovery["mode"], file: SourceRevision, node: Node): boolean {
  if (mode === "repository") return true;
  if (file.status === "added") return true;
  if (file.status !== "modified") return false;
  const start = node.startPosition.row + 1;
  const end = node.endPosition.row + 1;
  for (let line = start; line <= end; line += 1) if (file.changedLines.has(line)) return true;
  return false;
}

function makeSignal(file: SourceRevision, node: Node, fact: AsyncListenerFact): Signal {
  const line = node.startPosition.row + 1;
  return {
    ruleId: "go-concurrency.async-listener.missing-close",
    path: file.path,
    line,
    ...(node.endPosition.row > node.startPosition.row ? { endLine: node.endPosition.row + 1 } : {}),
    message: `${fact.server.name}.Start launches ${fact.server.handlerField}.Serve asynchronously, but no method on ${fact.server.name} closes or shuts down that owned net/http.Server.`,
    snippet: file.current.split("\n")[line - 1]?.trim() ?? "",
    data: {
      form: "async-listener-owner-without-shutdown",
      ownerType: fact.server.name,
      serverField: fact.server.handlerField,
      startMethod: "Start",
      helper: fact.helper.name,
      helperPath: fact.helper.parsed.file.path,
      helperLine: fact.helper.goStatement.startPosition.row + 1,
    },
  };
}

function normalize(value: string): string {
  return value.replace(/[\s()]/g, "");
}

function semantic(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");
}
