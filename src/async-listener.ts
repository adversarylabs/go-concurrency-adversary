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
  callbackParameter: string;
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
    const currentFacts = collectFacts(current);
    const previousSignatures = new Set(collectFacts(previous).map((fact) => fact.signature));
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
    if (!/(?:net\/http|net\b|\.Serve\b|go\s+func|func\s+\w+\s*\()/.test(source)) continue;
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

function collectFacts(files: ParsedFile[]): AsyncListenerFact[] {
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
      const listenerNames = listenerVariables(body, parsed);
      if (listenerNames.size === 0) continue;

      for (const call of directCallableDescendants(body, "call_expression")) {
        const helper = resolveAsyncHelper(call, parsed, helpers);
        if (helper === undefined) continue;
        const args = call.childForFieldName("arguments")?.namedChildren ?? [];
        const listener = args.find((arg) =>
          arg.type === "identifier" && listenerNames.has(sourceText(arg, parsed.file.current)));
        const serveMethod = args.find((arg) =>
          isHandlerServeMethod(arg, parsed.file.current, receiver, server.handlerField));
        if (listener === undefined || serveMethod === undefined) continue;
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
          semantic(sourceText(call, parsed.file.current)),
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
    const parameters = directParameters(fn);
    const listener = parameters.find((parameter) =>
      normalize(sourceText(parameter.childForFieldName("type") ?? parameter, source)) === `${netAlias}.Listener`);
    const callback = parameters.find((parameter) =>
      normalize(sourceText(parameter.childForFieldName("type") ?? parameter, source)) ===
        `func${netAlias}.Listenererror`);
    const listenerName = listener === undefined ? undefined : declaredNames(listener, source)[0];
    const callbackName = callback === undefined ? undefined : declaredNames(callback, source)[0];
    if (listenerName === undefined || callbackName === undefined) continue;
    // A helper that observes cancellation or owns another shutdown path is not
    // evidence that the wrapper itself leaks.
    if (containsCancellationOrShutdown(body, source, listenerName)) continue;

    for (const goStatement of directCallableDescendants(body, "go_statement")) {
      const invocation = goStatement.namedChildren.find((node) => node.type === "call_expression");
      const literal = invocation?.childForFieldName("function");
      if (literal?.type !== "func_literal") continue;
      const literalBody = literal.childForFieldName("body");
      if (literalBody === null) continue;
      const callbackCall = directCallableDescendants(literalBody, "call_expression").find((call) => {
        const called = call.childForFieldName("function");
        const args = call.childForFieldName("arguments")?.namedChildren ?? [];
        return called?.type === "identifier" && sourceText(called, source) === callbackName &&
          args.length === 1 && args[0]?.type === "identifier" && sourceText(args[0], source) === listenerName;
      });
      if (callbackCall === undefined || !defersListenerClose(literalBody, source, listenerName)) continue;
      helpers.push({
        parsed,
        name: sourceText(name, source),
        listenerParameter: listenerName,
        callbackParameter: callbackName,
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
): AsyncListenerHelper | undefined {
  const fn = call.childForFieldName("function");
  if (fn?.type === "identifier") {
    const name = sourceText(fn, caller.file.current);
    return helpers.find((helper) => helper.name === name && samePackage(helper.parsed, caller));
  }
  if (fn?.type !== "selector_expression") return undefined;
  const operand = fn.childForFieldName("operand");
  const field = fn.childForFieldName("field");
  if (operand?.type !== "identifier" || field === null) return undefined;
  const importPath = caller.importsByAlias.get(sourceText(operand, caller.file.current));
  if (importPath === undefined) return undefined;
  const name = sourceText(field, caller.file.current);
  return helpers.find((helper) => helper.name === name && importResolvesTo(importPath, helper.parsed));
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

function listenerVariables(body: Node, parsed: ParsedFile): Set<string> {
  const source = parsed.file.current;
  const netAlias = aliasForPath(parsed.importsByAlias, "net");
  if (netAlias === undefined) return new Set();
  const names = new Set<string>();
  for (const spec of directCallableDescendants(body, "var_spec")) {
    const type = spec.childForFieldName("type");
    if (type !== null && normalize(sourceText(type, source)) === `${netAlias}.Listener`) {
      for (const name of declaredNames(spec, source)) names.add(name);
    }
  }
  for (const assignment of directCallableDescendants(body, "short_var_declaration")) {
    const left = assignment.childForFieldName("left")?.namedChildren ?? [];
    const right = assignment.childForFieldName("right")?.namedChildren ?? [];
    for (let index = 0; index < right.length; index += 1) {
      const value = right[index];
      if (value?.type !== "call_expression") continue;
      const fn = value.childForFieldName("function");
      if (fn !== null && normalize(sourceText(fn, source)) === `${netAlias}.Listen`) {
        const target = left[index] ?? left[0];
        if (target?.type === "identifier") names.add(sourceText(target, source));
      }
    }
  }
  return names;
}

function methodStopsField(method: Node, source: string, fieldName: string): boolean {
  const body = method.childForFieldName("body");
  const receiver = receiverName(method, source);
  if (body === null || receiver === undefined) return false;
  const aliases = new Set<string>();
  for (const declaration of directCallableDescendants(body, "short_var_declaration")) {
    const left = declaration.childForFieldName("left")?.namedChildren ?? [];
    const right = declaration.childForFieldName("right")?.namedChildren ?? [];
    if (left.length !== 1 || right.length !== 1 || left[0]?.type !== "identifier") continue;
    if (isReceiverField(right[0]!, source, receiver, fieldName)) aliases.add(sourceText(left[0], source));
  }
  // Any syntactic close/shutdown path on the owned field is enough to stay
  // quiet here. Proving that path is wired into daemon shutdown is a broader
  // ownership question; this rule is specifically for the complete absence of
  // a stop mechanism.
  return descendants(body, "call_expression").some((call) => {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return false;
    const operand = fn.childForFieldName("operand");
    const selected = fn.childForFieldName("field");
    if (operand === null || selected === null || !/^(?:Close|Shutdown|Stop)$/.test(sourceText(selected, source))) {
      return false;
    }
    return isReceiverField(operand, source, receiver, fieldName) ||
      (operand.type === "identifier" && aliases.has(sourceText(operand, source)));
  });
}

function containsCancellationOrShutdown(body: Node, source: string, listenerName: string): boolean {
  return descendants(body, "call_expression").some((call) => {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return false;
    const operand = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    if (operand === null || field === null) return false;
    const selected = sourceText(field, source);
    if (selected === "Done") return true;
    if (!/^(?:Close|Shutdown|Stop)$/.test(selected)) return false;
    // The exact helper defers listener.Close inside the serving goroutine. That
    // releases the socket only after Serve returns; it is not a stop path.
    return !(sourceText(operand, source) === listenerName && insideDeferStatement(call));
  });
}

function defersListenerClose(body: Node, source: string, listenerName: string): boolean {
  return descendants(body, "defer_statement").some((statement) =>
    descendants(statement, "call_expression").some((call) => {
      const fn = call.childForFieldName("function");
      if (fn?.type !== "selector_expression") return false;
      const operand = fn.childForFieldName("operand");
      const field = fn.childForFieldName("field");
      return operand?.type === "identifier" && field !== null &&
        sourceText(operand, source) === listenerName && sourceText(field, source) === "Close";
    }));
}

function isHandlerServeMethod(node: Node, source: string, receiver: string, fieldName: string): boolean {
  if (node.type !== "selector_expression") return false;
  const operand = node.childForFieldName("operand");
  const field = node.childForFieldName("field");
  return operand !== null && field !== null && sourceText(field, source) === "Serve" &&
    isReceiverField(operand, source, receiver, fieldName);
}

function isReceiverField(node: Node, source: string, receiver: string, fieldName: string): boolean {
  if (node.type !== "selector_expression") return false;
  const operand = node.childForFieldName("operand");
  const field = node.childForFieldName("field");
  return operand?.type === "identifier" && field !== null &&
    sourceText(operand, source) === receiver && sourceText(field, source) === fieldName;
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
  return parameters === null ? [] : descendants(parameters, "parameter_declaration");
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

function importResolvesTo(importPath: string, target: ParsedFile): boolean {
  const directory = target.directory === "." ? "" : target.directory;
  const directoryMatch = directory === "" || importPath === directory || importPath.endsWith(`/${directory}`);
  return directoryMatch && posix.basename(importPath) === target.packageName;
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
    ruleId: "go-concurrency.async-listener.missing-shutdown",
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
