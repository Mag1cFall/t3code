import { tr } from "~/i18n";
/**
 * The languages a composer fence can be switched to from its header, and how
 * a choice is written back into the fence's info string.
 *
 * Ids are the names the highlighter and the file icons both know. The list
 * is curated rather than every grammar the highlighter bundles: a picker is
 * for the common case, and any other language can still be typed on the
 * fence line, where it shows as its own entry.
 */
export const CODE_BLOCK_LANGUAGES = [
  { id: "", label: tr("Plain text") },
  { id: "bash", label: tr("Bash") },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  { id: "dart", label: tr("Dart") },
  { id: "diff", label: tr("Diff") },
  { id: "dockerfile", label: tr("Dockerfile") },
  { id: "elixir", label: tr("Elixir") },
  { id: "go", label: tr("Go") },
  { id: "graphql", label: "GraphQL" },
  { id: "haskell", label: tr("Haskell") },
  { id: "html", label: "HTML" },
  { id: "java", label: tr("Java") },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "jsx", label: "JSX" },
  { id: "kotlin", label: tr("Kotlin") },
  { id: "lua", label: tr("Lua") },
  { id: "markdown", label: "Markdown" },
  { id: "php", label: "PHP" },
  { id: "powershell", label: "PowerShell" },
  { id: "python", label: tr("Python") },
  { id: "r", label: "R" },
  { id: "ruby", label: tr("Ruby") },
  { id: "rust", label: tr("Rust") },
  { id: "scala", label: tr("Scala") },
  { id: "scss", label: "SCSS" },
  { id: "sql", label: "SQL" },
  { id: "svelte", label: tr("Svelte") },
  { id: "swift", label: tr("Swift") },
  { id: "toml", label: "TOML" },
  { id: "tsx", label: "TSX" },
  { id: "typescript", label: "TypeScript" },
  { id: "vue", label: tr("Vue") },
  { id: "xml", label: "XML" },
  { id: "yaml", label: "YAML" },
  { id: "zig", label: tr("Zig") },
] as const;

export type CodeBlockLanguage = { readonly id: string; readonly label: string };

/** Short names people type on the fence line, labelled like the entry they mean. */
const LANGUAGE_ALIASES: Record<string, string> = {
  cs: "csharp",
  "c++": "cpp",
  js: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  yml: "yaml",
};

/** The language is the info string's first word; the rest belongs to the fence. */
export function languageOfInfoString(info: string): string {
  return info.trim().split(/\s+/, 1)[0] ?? "";
}

/**
 * Replaces the language and keeps everything around it: the whitespace the
 * fence had before it and whatever follows it. Plain text clears it, unless
 * something follows: a bare `title=x` would read as the language, so that
 * keeps `text` in front.
 */
export function withInfoStringLanguage(info: string, language: string): string {
  const leading = /^\s*/.exec(info)![0];
  // The language is the first word, so what follows it is empty or starts
  // with whitespace.
  const rest = info.slice(leading.length + languageOfInfoString(info).length);
  if (language) return `${leading}${language}${rest}`;
  return rest.trim() ? `${leading}text${rest}` : "";
}

/** The canonical entry a language names, if the picker lists it. */
export function codeLanguageEntry(language: string): CodeBlockLanguage | null {
  const id = language === "text" ? "" : (LANGUAGE_ALIASES[language.toLowerCase()] ?? language);
  return CODE_BLOCK_LANGUAGES.find((entry) => entry.id === id.toLowerCase()) ?? null;
}

export function codeLanguageLabel(language: string): string {
  return codeLanguageEntry(language)?.label ?? language;
}
