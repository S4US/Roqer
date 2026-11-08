import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * React needs every render of a component to call the same hooks in the same
 * order. A hook below an early return is called on some renders and not
 * others, and React then throws "Rendered more hooks than during the previous
 * render", which takes down the whole window. The project's lint has no React
 * hooks rule, so this reads the renderer's source for that one mistake: in a
 * component or hook, a hook called after a top-level statement that can return.
 */

const SOURCE_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));

function isHookCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use[A-Z]/.test(node.expression.text);
}

/** The first hook called in `node`, not counting nested functions, which have their own. */
function firstHook(node: ts.Node): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (current: ts.Node) => {
    if (found !== undefined || (current !== node && ts.isFunctionLike(current))) return;
    if (isHookCall(current)) {
      found = current;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function canReturn(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return true;
  let found = false;
  const visit = (current: ts.Node) => {
    if (found || ts.isFunctionLike(current)) return;
    if (ts.isReturnStatement(current)) found = true;
    else ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function hooksAfterReturns(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const check = (name: string, body: ts.ConciseBody | undefined) => {
    if (body === undefined || !ts.isBlock(body)) return;
    let returned: ts.Statement | undefined;
    for (const statement of body.statements) {
      const hook = firstHook(statement);
      if (hook !== undefined && returned !== undefined) {
        problems.push(`${file}:${line(hook)} ${name} calls ${(hook.expression as ts.Identifier).text}() after it may return at line ${line(returned)}`);
      }
      if (returned === undefined && canReturn(statement)) returned = statement;
    }
  };
  const named = (name: string) => /^([A-Z]|use[A-Z])/.test(name);
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && named(node.name.text)) check(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && named(node.name.text) && node.initializer !== undefined) {
      let value: ts.Expression = node.initializer;
      // memo(function Name() {...}) and the like.
      if (ts.isCallExpression(value) && value.arguments[0] !== undefined && ts.isFunctionLike(value.arguments[0])) value = value.arguments[0];
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) check(node.name.text, value.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

test("no component or hook calls a hook after it may already have returned", () => {
  const files = readdirSync(SOURCE_DIRECTORY).filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."));
  assert.ok(files.includes("App.tsx"), "the renderer's source was found");
  const problems = files.flatMap((file) => hooksAfterReturns(file, readFileSync(join(SOURCE_DIRECTORY, file), "utf8")));
  assert.deepEqual(problems, []);
});

test("the check finds a hook below an early return, and passes one above it", () => {
  const broken = "function Strip({ steps }) {\n  const [a] = useState(0);\n  if (steps.length === 0) return null;\n  const b = usePresence(a, 1);\n  return b;\n}\n";
  assert.deepEqual(hooksAfterReturns("strip.tsx", broken), ["strip.tsx:4 Strip calls usePresence() after it may return at line 3"]);
  const fixed = "const Strip = memo(function Strip({ steps }) {\n  const [a] = useState(0);\n  const b = usePresence(a, 1);\n  if (steps.length === 0) return null;\n  return b;\n});\n";
  assert.deepEqual(hooksAfterReturns("strip.tsx", fixed), []);
});
