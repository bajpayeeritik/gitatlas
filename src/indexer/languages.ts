import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

type Language = Parser.Language;

export type LangId = "javascript" | "typescript" | "tsx" | "java" | "python";

const EXT_TO_LANG: Record<string, LangId> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".java": "java",
  ".py": "python",
};

export function languageForFile(filePath: string): LangId | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT_TO_LANG[filePath.slice(dot).toLowerCase()];
}

const WASM_FILES: Record<LangId, string> = {
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  java: "tree-sitter-java.wasm",
  python: "tree-sitter-python.wasm",
};

let initialized = false;
const languages = new Map<LangId, Language>();
const parsers = new Map<LangId, Parser>();

export async function getParser(lang: LangId): Promise<Parser> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  let parser = parsers.get(lang);
  if (parser) return parser;
  let language = languages.get(lang);
  if (!language) {
    const wasmPath = require.resolve(
      `tree-sitter-wasms/out/${WASM_FILES[lang]}`
    );
    language = await Parser.Language.load(wasmPath);
    languages.set(lang, language);
  }
  parser = new Parser();
  parser.setLanguage(language);
  parsers.set(lang, parser);
  return parser;
}
