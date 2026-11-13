import { parse, type Expression, type FunctionDeclaration, type FunctionExpression, type ArrowFunctionExpression, type Node, type Program, type Statement, type Super, type PrivateIdentifier } from 'acorn';

type StaticFunction = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression;
export type NavigationFunctions = Map<string, StaticFunction | null>;
export interface StaticNavigation { destination?: string; reason?: string }
const MAX_SCRIPT = 100_000;
const MAX_STRING = 30_000;
const BUILTINS = new Set(['window', 'document', 'location', 'open', 'event']);

function path(value: Expression | Super | PrivateIdentifier): string | null {
  if (value.type === 'Identifier') return value.name;
  if (value.type !== 'MemberExpression' || value.computed || value.optional || value.property.type !== 'Identifier') return null;
  const parent = path(value.object);
  return parent ? `${parent}.${value.property.name}` : null;
}

function literal(value: Expression | PrivateIdentifier, bindings: Map<string, string>, depth = 0): string | null {
  if (depth > 20) return null;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value.length <= MAX_STRING ? value.value : null;
  if (value.type === 'Identifier') return bindings.get(value.name) ?? null;
  if (value.type === 'BinaryExpression' && value.operator === '+') {
    const left = literal(value.left, bindings, depth + 1); const right = literal(value.right, bindings, depth + 1);
    return left !== null && right !== null && left.length + right.length <= MAX_STRING ? left + right : null;
  }
  if (value.type === 'TemplateLiteral') {
    let result = value.quasis[0]?.value.cooked ?? '';
    for (let i = 0; i < value.expressions.length; i++) {
      const item = literal(value.expressions[i]!, bindings, depth + 1); if (item === null) return null;
      result += item + (value.quasis[i + 1]?.value.cooked ?? ''); if (result.length > MAX_STRING) return null;
    }
    return result;
  }
  return null;
}

function expressionNavigation(value: Expression, functions: NavigationFunctions, bindings: Map<string, string>, stack: Set<string>): string | null {
  if (value.type === 'AssignmentExpression' && value.operator === '=' && ['Identifier', 'MemberExpression'].includes(value.left.type)) {
    const target = path(value.left as Expression);
    if (target && /^(?:(?:window|document)\.)?location(?:\.href)?$/.test(target) && !shadowed(target, functions, bindings)) return literal(value.right, bindings);
  }
  if (value.type !== 'CallExpression' || value.optional) return null;
  const target = path(value.callee);
  if (!target || shadowed(target, functions, bindings) || value.arguments.some((arg) => arg.type === 'SpreadElement')) return null;
  const args = value.arguments as Expression[];
  if ((target === 'window.open' || target === 'open') && args.length >= 1 && args.length <= 3) {
    if (args.some((arg) => literal(arg, bindings) === null)) return null;
    return literal(args[0]!, bindings);
  }
  if (/^(?:(?:window|document)\.)?location\.(assign|replace)$/.test(target) && args.length === 1) return literal(args[0]!, bindings);
  const fn = functions.get(target);
  if (!fn || fn.async || fn.generator || stack.size >= 8 || stack.has(target) || fn.params.length !== args.length || fn.params.some((param) => param.type !== 'Identifier' || BUILTINS.has(param.name))) return null;
  const bound = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const text = literal(args[i]!, bindings); const param = fn.params[i]!;
    if (text === null || param.type !== 'Identifier') return null;
    bound.set(param.name, text);
  }
  const nextStack = new Set(stack).add(target);
  return fn.body.type === 'BlockStatement' ? statementsNavigation(fn.body.body, functions, bound, nextStack) : expressionNavigation(fn.body, functions, bound, nextStack);
}

function statementsNavigation(statements: Statement[], functions: NavigationFunctions, input: Map<string, string>, stack: Set<string>): string | null {
  const bindings = new Map(input); let destination: string | null = null; let returned = false;
  for (const statement of statements) {
    if (statement.type === 'EmptyStatement') continue;
    if (returned) return null;
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
      for (const variable of statement.declarations) {
        if (variable.id.type !== 'Identifier' || BUILTINS.has(variable.id.name) || !variable.init || bindings.has(variable.id.name)) return null;
        const text = literal(variable.init, bindings); if (text === null) return null; bindings.set(variable.id.name, text);
      }
      continue;
    }
    if (statement.type === 'ReturnStatement' && (!statement.argument || statement.argument.type === 'Literal' && statement.argument.value === false)) { returned = true; continue; }
    const value = statement.type === 'ExpressionStatement' ? statement.expression : statement.type === 'ReturnStatement' ? statement.argument : null;
    if (!value) return null;
    if (statement.type === 'ExpressionStatement' && value.type === 'CallExpression' && path(value.callee) === 'event.preventDefault' && !shadowed('event.preventDefault', functions, bindings) && !value.arguments.length) continue;
    const extracted = expressionNavigation(value, functions, bindings, stack);
    if (extracted === null || destination !== null) return null;
    destination = extracted;
    if (statement.type === 'ReturnStatement') returned = true;
  }
  return destination;
}

export function parseNavigationScript(code: string): Program | null {
  if (!code.trim() || code.length > MAX_SCRIPT) return null;
  try { return parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch { return null; }
}

/** Register declarations without evaluating them. Conflicting declarations stay unsupported. */
export function registerNavigationFunctions(program: Program, functions: NavigationFunctions): void {
  const add = (name: string, fn: StaticFunction) => functions.set(name, functions.has(name) ? null : fn);
  for (const statement of program.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id) add(statement.id.name, statement);
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') for (const variable of statement.declarations) {
      if (variable.id.type === 'Identifier' && variable.init && ['FunctionExpression', 'ArrowFunctionExpression'].includes(variable.init.type)) add(variable.id.name, variable.init as FunctionExpression | ArrowFunctionExpression);
    }
  }
}

function canonicalBinding(name: string): string { return name.replace(/^(?:window|document)\.(?=location(?:\.|$))|^window\.(?=open$)/, ''); }
function shadowed(target: string, functions: NavigationFunctions, bindings: Map<string, string>): boolean {
  const root = target.split('.')[0]!;
  return BUILTINS.has(root) && (bindings.has(root) || functions.has(root)) || functions.get(canonicalBinding(target)) === null;
}

/** Writes are never performed. Their targets make declaration-only helper resolution ambiguous. */
export function invalidateNavigationBindings(program: Program, functions: NavigationFunctions): void {
  const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
  const assignmentPath = (value: Node): string | null => {
    if (value.type === 'Identifier') return (value as Expression & { name: string }).name;
    if (value.type !== 'MemberExpression') return null;
    const member = value as Extract<Expression, { type: 'MemberExpression' }>;
    const parent = assignmentPath(member.object);
    const property = member.property.type === 'Identifier' && !member.computed ? member.property.name : member.property.type === 'Literal' && typeof member.property.value === 'string' ? member.property.value : null;
    return parent && property ? `${parent}.${property}` : null;
  };
  const poison = (name: string) => {
    const normalized = canonicalBinding(name);
    if (/^(?:(?:window|document)\.)?location(?:\.href)?$/.test(name)) return;
    const helper = name.replace(/^window\./, '');
    if (functions.has(helper)) functions.set(helper, null);
    if (BUILTINS.has(normalized.split('.')[0]!)) functions.set(normalized, null);
  };
  const stack: Node[] = [program]; let visited = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (++visited > 50_000) { for (const key of functions.keys()) functions.set(key, null); return; }
    if (node.type === 'AssignmentExpression') poison(assignmentPath((node as Extract<Expression, { type: 'AssignmentExpression' }>).left) ?? '');
    if (node.type === 'UpdateExpression') poison(assignmentPath((node as Extract<Expression, { type: 'UpdateExpression' }>).argument) ?? '');
    if (node.type === 'VariableDeclarator') {
      const declaration = node as Node & { id: Node; init: Node | null };
      if (declaration.id.type === 'Identifier' && !(declaration.init && ['FunctionExpression', 'ArrowFunctionExpression'].includes(declaration.init.type))) {
        const name = (declaration.id as Node & { name: string }).name;
        if (functions.has(name) || BUILTINS.has(name)) functions.set(name, null);
      }
    }
    for (const value of Object.values(node)) {
      if (isNode(value)) stack.push(value);
      else if (Array.isArray(value)) for (const child of value) if (isNode(child)) stack.push(child);
    }
  }
}

export function staticNavigation(code: string, functions: NavigationFunctions, declarations = false): StaticNavigation {
  const program = parseNavigationScript(code);
  if (!program) return { reason: code.length > MAX_SCRIPT ? 'Script exceeds the static analysis limit' : 'Script needs explicit mapping; it was not executed' };
  const executable = program.body.filter((statement) => !(declarations && (statement.type === 'FunctionDeclaration' || statement.type === 'VariableDeclaration' && statement.declarations.every((variable) => variable.init && ['FunctionExpression', 'ArrowFunctionExpression'].includes(variable.init.type)))));
  if (executable.some((statement) => statement.type.startsWith('Import') || statement.type.startsWith('Export'))) return { reason: 'Module behavior needs explicit mapping' };
  if (!executable.length && declarations) {
    const declared: StaticFunction[] = [];
    for (const statement of program.body) {
      if (statement.type === 'FunctionDeclaration') declared.push(statement);
      if (statement.type === 'VariableDeclaration') for (const variable of statement.declarations) if (variable.init && ['FunctionExpression', 'ArrowFunctionExpression'].includes(variable.init.type)) declared.push(variable.init as FunctionExpression | ArrowFunctionExpression);
    }
    const unsupported = declared.some((fn) => {
      if (fn.async || fn.generator || fn.params.some((param) => param.type !== 'Identifier' || BUILTINS.has(param.name))) return true;
      const bindings = new Map(fn.params.map((param) => [(param as Node & { name: string }).name, 'static-argument']));
      const destination = fn.body.type === 'BlockStatement' ? statementsNavigation(fn.body.body, functions, bindings, new Set(fn.id ? [fn.id.name] : [])) : expressionNavigation(fn.body, functions, bindings, new Set());
      return destination === null;
    });
    return unsupported ? { reason: 'This script defines functions whose behavior needs explicit mapping; their code was not executed' } : {};
  }
  const destination = statementsNavigation(executable as Statement[], functions, new Map(), new Set());
  return destination !== null ? { destination } : { reason: 'Dynamic behavior or side effects need explicit mapping; no script was executed' };
}
