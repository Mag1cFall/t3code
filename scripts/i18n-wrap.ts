// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - 同步改写源码的维护脚本，输出给终端
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import MagicString from "magic-string";
import { parseSync } from "oxc-parser";

const ROOT = NodePath.resolve(import.meta.dirname, "../apps/web/src");
const LOCALE_FILE = NodePath.join(ROOT, "locales", "zh-Hant.json");
const SKIP_FILE = /\.(test|browser|spec|bench)\.[cm]?[jt]sx?$|routeTree\.gen\.ts$|^i18n\.ts$/;
const SKIP_DIRECTORY = new Set(["locales"]);
const TEXT_NAME =
  /^(aria-label|aria-description|aria-placeholder|aria-valuetext|alt|title|label|description|placeholder|tooltip|message|error|subtitle|eyebrow|headline|heading|hint|summary|detail|reason|caption|children)$|(Label|Tooltip|Title|Description|Message|Placeholder|Hint|Reason|Headline|Heading|Caption|Summary)$/;
const CODE_ELEMENTS = new Set(["code", "pre", "kbd", "samp", "style", "script"]);
const CODE_KEY =
  /^(id|key|value|type|kind|href|url|path|className|class|icon|command|mode|variant|tag|slug|pattern|query|cwd|event|prompt)$/;
const CODE_CALLEE =
  /^(tr|i18nTr|require|RegExp|describe|it|test|expect|console\.\w+|Effect\.\w+|Schema\.\w+|.*\.(includes|startsWith|endsWith|indexOf|querySelector|querySelectorAll|getItem|setItem|removeItem|addEventListener|removeEventListener|postMessage|matchMedia|has|get|delete|annotateCurrentSpan|withSpan|logInfo|logWarning|logError|logDebug))$/;
const VALUE_WRAPPERS = new Set([
  "ConditionalExpression",
  "LogicalExpression",
  "JSXExpressionContainer",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
]);
const EXPRESSION_TS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSInstantiationExpression",
]);
// RENDER_KEYS 列出被逻辑当作标识使用的字面量，这些文字在显示处翻译
const RENDER_KEYS: Record<string, ReadonlyArray<string>> = {
  "components/Sidebar.logic.ts": [
    "Working",
    "Connecting",
    "Completed",
    "Pending Approval",
    "Awaiting Input",
    "Plan Ready",
    "Waiting",
  ],
  "components/ThreadStatusIndicators.tsx": ["Terminal process running"],
};
// UNWRAPPED_FILES 列出整份不包装的文件：文字会写入设置、被逻辑比对，或在 i18n 初始化前运行
const UNWRAPPED_FILES = new Set([
  "components/settings/customModelEditor.logic.ts",
  "lib/bootError.ts",
]);
// PROMPT_FILES 列出拼装代理提示词的文件，其中只包装属性与 JSX 文字
const PROMPT_FILES = new Set(["components/pullRequest/pullRequestDetail.logic.ts"]);
// NOT_TEXT 列出形似界面文字的代码字面量
const NOT_TEXT: Record<string, ReadonlyArray<string>> = {
  "components/ChatView.tsx": ["Continue where you left off."],
  "components/DiffPanel.tsx": ["HEAD"],
  "components/pullRequest/PullRequestTimelineTab.tsx": ["ghost"],
  "components/settings/AddProviderInstanceDialog.tsx": ["{{driver}}_work"],
  "components/settings/CaptureShortcutConfig.tsx": [
    "~/.config/niri/config.kdl",
    "~/.config/hypr/hyprland.conf",
  ],
  "components/settings/ProviderModelsSection.tsx": ["model-slug"],
  "components/projectScriptEditor.tsx": ["bun test"],
  "components/search/ProjectContentSearchDialog.tsx": ["ab"],
  "components/settings/ScheduledTasksSettings.tsx": ["hex", "base64"],
  "state/use-atom-query-runner.ts": ["atom query"],
};
const LOCAL_NAME = "tr";
const ALIAS_NAME = "i18nTr";
const BRANDS = new Set([
  "T3 Code",
  "T3 Connect",
  "Codex",
  "Claude",
  "Claude Code",
  "OMP",
  "Cursor",
  "Grok",
  "OpenCode",
  "Pi",
  "Muse",
  "Antigravity",
  "GitHub",
  "GitLab",
  "Bitbucket",
  "Forgejo",
  "Azure DevOps",
  "Tailscale",
  "ChatGPT",
  "OpenAI",
  "Anthropic",
  "Git",
  "macOS",
  "Windows",
  "Linux",
  "iOS",
  "Android",
  "VS Code",
  "Markdown",
  "JSON",
]);
const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  rarr: "→",
  larr: "←",
  times: "×",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
};

type Node = { readonly type: string; readonly start: number; readonly end: number } & Record<
  string,
  any
>;

// decodeEntities 还原 JSX 文字中的实体，遇到未知实体返回 null
function decodeEntities(value: string): string | null {
  let unknown = false;
  const decoded = value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    const named = ENTITIES[entity.toLowerCase()];
    if (named === undefined) unknown = true;
    return named ?? match;
  });
  return unknown ? null : decoded;
}

// normalizeText 按 JSX 的空白规则合并换行与缩进
function normalizeText(value: string): string {
  return value.replace(/[ \t\r\n]+/g, " ").trim();
}

// isClassList 识别样式类名列表
function isClassList(text: string): boolean {
  const tokens = text.split(/\s+/);
  return (
    tokens.every((token) => /^[a-z0-9!:[\]&_/.%(),=#-]+$/.test(token)) &&
    (tokens.some((token) => /[/:[\]]/.test(token)) ||
      tokens.filter((token) => token.includes("-")).length >= 2)
  );
}

// isPropText 判断属性或对象字段中的字符串字面量是否为界面文字
function isPropText(value: string): boolean {
  const text = value.trim();
  if (!/[A-Za-z]{2}/.test(text) || BRANDS.has(text) || text.includes("{{")) return false;
  if (isClassList(text) || /^[a-z][\w+.-]*:\/\//i.test(text)) return false;
  if (!/\s/.test(text)) return /^[A-Z][a-z]+(?:[.…!?:])?$/.test(text);
  return /[a-z]/.test(text) && !/=>|[{};]/.test(text);
}

// isLooseText 判断 JSX 子节点或文字属性中的字符串是否为界面文字，首尾空白需保留的不处理
function isLooseText(value: string): boolean {
  const text = value.trim();
  if (value !== text || !/[A-Za-z]{2}/.test(text) || BRANDS.has(text) || text.includes("{{"))
    return false;
  if (isClassList(text) || /^[a-z][\w+.-]*:\/\//i.test(text) || /^[/$@#][\w:-]*$/.test(text))
    return false;
  return !/=>|[{};]/.test(text);
}

// isSentence 判断任意位置的字符串字面量是否为多词界面句子
function isSentence(value: string): boolean {
  const text = value.trim();
  return isPropText(text) && /^[A-Z]/.test(text) && /\s[a-z]/.test(text);
}

function calleeName(node: Node): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed)
    return `${calleeName(node.object)}.${node.property.name}`;
  if (node.type === "ThisExpression") return "this";
  return "";
}

// isUntranslatable 判断字面量所处位置是否为代码而非界面文字
function isUntranslatable(node: Node, ancestors: Array<Node>): boolean {
  let child = node;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index]!;
    if (VALUE_WRAPPERS.has(parent.type)) {
      child = parent;
      continue;
    }
    if (parent.type === "JSXAttribute" || parent.type === "TaggedTemplateExpression") return true;
    if (parent.type === "BinaryExpression" && /^(?:[!=]==?|in)$/.test(parent.operator)) return true;
    if (/^(SwitchCase|ImportExpression|ImportDeclaration|Export\w+Declaration)$/.test(parent.type))
      return true;
    if (parent.type === "Property") {
      if (parent.key === child) return true;
      const name = propertyName(parent.key);
      return name !== null && CODE_KEY.test(name);
    }
    if (parent.type === "CallExpression" || parent.type === "NewExpression") {
      if (parent.callee === child) return false;
      const name = calleeName(parent.callee);
      return parent.type === "NewExpression" ? name.endsWith("Error") : CODE_CALLEE.test(name);
    }
    return false;
  }
  return false;
}

function listFiles(directory: string, files: Array<string> = []): Array<string> {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORY.has(entry.name)) listFiles(full, files);
    } else if (/\.tsx?$/.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function children(node: Node): Array<Node> {
  const result: Array<Node> = [];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") result.push(child);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      result.push(value);
    }
  }
  return result;
}

function propertyName(node: Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXNamespacedName") return `${node.namespace.name}:${node.name.name}`;
  return null;
}

function placeholderName(expression: Node, used: Set<string>): string {
  let base = "value";
  if (expression.type === "Identifier") base = expression.name;
  else if (expression.type === "MemberExpression" && !expression.computed)
    base = expression.property.name;
  let name = base;
  for (let index = 2; used.has(name); index++) name = `${base}${index}`;
  used.add(name);
  return name;
}

function isSimpleExpression(node: Node): boolean {
  if (node.type === "Identifier") return true;
  if (node.type === "Literal") return typeof node.value === "number";
  if (node.type === "MemberExpression")
    return !node.computed && !node.optional && isSimpleExpression(node.object);
  return false;
}

// wrapFile 为单个文件包装界面文字，返回是否有改动
function wrapFile(file: string, keys: Set<string>): boolean {
  const source = NodeFS.readFileSync(file, "utf8");
  const relative = NodePath.relative(ROOT, file).replaceAll("\\", "/");
  if (UNWRAPPED_FILES.has(relative)) return false;
  const keep = new Set([...(RENDER_KEYS[relative] ?? []), ...(NOT_TEXT[relative] ?? [])]);
  const imported = /import \{ tr(?: as (\w+))? \} from "~\/i18n";/.exec(source);
  const shadowed = /\b(?:const|let|var|function)\s+tr\b|[(,{]\s*tr\s*[,)}=:]/.test(source);
  const fn = imported !== null ? (imported[1] ?? LOCAL_NAME) : shadowed ? ALIAS_NAME : LOCAL_NAME;
  const program = parseSync(file, source).program as unknown as Node;
  const output = new MagicString(source);
  const edited: Array<[number, number]> = [];
  const overlaps = (node: Node) =>
    edited.some(([start, end]) => node.start < end && node.end > start);
  const replace = (start: number, end: number, text: string) => {
    output.overwrite(start, end, text);
    edited.push([start, end]);
  };
  const call = (key: string, values: Array<[string, string]>) => {
    keys.add(key);
    const args = values
      .map(([name, expression]) => (name === expression ? name : `${name}: ${expression}`))
      .join(", ");
    return values.length === 0
      ? `${fn}(${JSON.stringify(key)})`
      : `${fn}(${JSON.stringify(key)}, { ${args} })`;
  };

  const wrapExpression = (node: Node, isText: (value: string) => boolean = isPropText) => {
    if (overlaps(node)) return;
    if (node.type === "Literal" && typeof node.value === "string") {
      const text = node.value.trim();
      if (isText(node.value) && !keep.has(text)) return;
    }
    if (node.type === "TemplateLiteral" && node.expressions.length > 0) {
      const text = node.quasis.map((quasi: Node) => quasi.value.cooked ?? "").join("0");
      if (!isText(text) || node.quasis.some((quasi: Node) => quasi.value.cooked === null)) return;
      const used = new Set<string>();
      const values: Array<[string, string]> = [];
      let key = "";
      node.quasis.forEach((quasi: Node, index: number) => {
        key += quasi.value.cooked;
        const expression = node.expressions[index] as Node | undefined;
        if (expression === undefined) return;
        const name = placeholderName(expression, used);
        values.push([name, source.slice(expression.start, expression.end)]);
        key += `{{${name}}}`;
      });
      if (!keep.has(key.trim())) replace(node.start, node.end, call(key, values));
      return;
    }
    if (node.type === "TemplateLiteral" && node.quasis.length === 1) {
      const cooked = node.quasis[0].value.cooked;
      if (typeof cooked === "string" && isText(cooked) && !keep.has(cooked.trim()))
        replace(node.start, node.end, call(cooked, []));
      return;
    }
    if (node.type === "ConditionalExpression") {
      wrapExpression(node.consequent, isText);
      wrapExpression(node.alternate, isText);
    } else if (node.type === "LogicalExpression") {
      wrapExpression(node.left, isText);
      wrapExpression(node.right, isText);
    } else if (node.type === "ParenthesizedExpression" || EXPRESSION_TS.has(node.type)) {
      wrapExpression(node.expression, isText);
    }
  };

  const wrapChildren = (element: Node) => {
    const runs: Array<Array<Node>> = [];
    let current: Array<Node> = [];
    for (const child of element.children as Array<Node>) {
      const inline =
        child.type === "JSXText" ||
        (child.type === "JSXExpressionContainer" && isSimpleExpression(child.expression));
      if (inline) current.push(child);
      else {
        if (current.length > 0) runs.push(current);
        current = [];
        if (child.type === "JSXExpressionContainer") wrapExpression(child.expression, isLooseText);
      }
    }
    if (current.length > 0) runs.push(current);
    for (const run of runs) {
      const texts = run.filter((child) => child.type === "JSXText");
      const decoded = texts.map((child) => decodeEntities(child.value));
      if (decoded.some((value) => value === null) || !/[A-Za-z]{2}/.test(decoded.join(" ")))
        continue;
      const first = run[0]!;
      const last = run[run.length - 1]!;
      if (overlaps(first) || overlaps(last)) continue;
      const used = new Set<string>();
      const values: Array<[string, string]> = [];
      let key = "";
      for (const child of run) {
        if (child.type === "JSXText") key += decodeEntities(child.value);
        else {
          const name = placeholderName(child.expression, used);
          values.push([name, source.slice(child.expression.start, child.expression.end)]);
          key += `{{${name}}}`;
        }
      }
      const normalized = normalizeText(key);
      if (BRANDS.has(normalized) || keep.has(normalized) || /^[/$@#][\w:-]*$/.test(normalized))
        continue;
      const leading = first.type === "JSXText" ? /^[ \t\r\n]*/.exec(first.value)![0] : "";
      const trailing = last.type === "JSXText" ? /[ \t\r\n]*$/.exec(last.value)![0] : "";
      replace(first.start, last.end, `${leading}{${call(normalized, values)}}${trailing}`);
    }
  };

  const ancestors: Array<Node> = [];
  const visit = (node: Node) => {
    if (node.type.startsWith("TS") && !EXPRESSION_TS.has(node.type)) return;
    if (node.type === "JSXElement") {
      const name = propertyName(node.openingElement.name);
      for (const attribute of node.openingElement.attributes as Array<Node>) {
        if (attribute.type !== "JSXAttribute" || attribute.value === null) continue;
        const attributeName = propertyName(attribute.name);
        if (
          attributeName === null ||
          attributeName === "children" ||
          !TEXT_NAME.test(attributeName)
        )
          continue;
        const value = attribute.value as Node;
        if (value.type === "Literal" && typeof value.value === "string") {
          const decoded = decodeEntities(value.value);
          if (
            decoded !== null &&
            isPropText(decoded) &&
            !keep.has(decoded.trim()) &&
            !overlaps(value)
          )
            replace(value.start, value.end, `{${call(decoded.trim(), [])}}`);
        } else if (value.type === "JSXExpressionContainer") {
          wrapExpression(value.expression, isLooseText);
        }
      }
      if (name === null || !CODE_ELEMENTS.has(name)) wrapChildren(node);
    } else if (node.type === "JSXFragment") {
      wrapChildren(node);
    } else if (
      node.type === "Property" &&
      node.kind === "init" &&
      !node.computed &&
      !node.shorthand &&
      !node.method
    ) {
      const name = propertyName(node.key);
      if (name !== null && TEXT_NAME.test(name)) wrapExpression(node.value);
    } else if (
      (node.type === "Literal" && typeof node.value === "string") ||
      node.type === "TemplateLiteral"
    ) {
      const text =
        node.type === "Literal"
          ? (node.value as string)
          : node.quasis.map((quasi: Node) => quasi.value.cooked ?? "").join(" ");
      if (
        !PROMPT_FILES.has(relative) &&
        isSentence(text) &&
        !keep.has(text.trim()) &&
        !isUntranslatable(node, ancestors)
      )
        wrapExpression(node);
    }
    ancestors.push(node);
    for (const child of children(node)) visit(child);
    ancestors.pop();
  };
  visit(program);

  if (edited.length === 0) return false;
  if (imported === null) {
    const specifier = fn === LOCAL_NAME ? LOCAL_NAME : `${LOCAL_NAME} as ${fn}`;
    const imports = (program.body as Array<Node>).filter(
      (statement) => statement.type === "ImportDeclaration",
    );
    const anchor = imports.at(-1);
    if (anchor === undefined) output.prepend(`import { ${specifier} } from "~/i18n";\n`);
    else output.appendLeft(anchor.end, `\nimport { ${specifier} } from "~/i18n";`);
  }
  NodeFS.writeFileSync(file, output.toString());
  return true;
}

const keys = new Set<string>();
let changed = 0;
for (const file of listFiles(ROOT)) if (wrapFile(file, keys)) changed += 1;

const existing: Record<string, string> = NodeFS.existsSync(LOCALE_FILE)
  ? JSON.parse(NodeFS.readFileSync(LOCALE_FILE, "utf8"))
  : {};
const used = new Set([...keys, ...Object.values(RENDER_KEYS).flat()]);
for (const file of listFiles(ROOT)) {
  const source = NodeFS.readFileSync(file, "utf8");
  for (const match of source.matchAll(/\b(?:tr|i18nTr)\(\s*("(?:[^"\\]|\\.)*")/g))
    used.add(JSON.parse(match[1]!));
}
const locale: Record<string, string> = {};
for (const key of [...used].sort()) locale[key] = existing[key] ?? "";
NodeFS.mkdirSync(NodePath.dirname(LOCALE_FILE), { recursive: true });
NodeFS.writeFileSync(LOCALE_FILE, `${JSON.stringify(locale, null, 2)}\n`);
const missing = Object.values(locale).filter((value) => value === "").length;
console.log(`wrapped files: ${changed}`);
console.log(`locale keys: ${Object.keys(locale).length}, untranslated: ${missing}`);
