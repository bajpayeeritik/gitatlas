import type Parser from "web-tree-sitter";
import type { LangId } from "./languages.js";

type Node = Parser.SyntaxNode;
import { getParser } from "./languages.js";
import type {
  ExtractedRef,
  ExtractedSymbol,
  FileExtraction,
  RefKind,
  SymbolKind,
} from "../types.js";

const MAX_FILE_BYTES = 1_500_000;

/** node.type -> symbol kind, per language family */
const JS_DEFS: Record<string, SymbolKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  method_definition: "method",
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "type",
};

const JAVA_DEFS: Record<string, SymbolKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "class",
  annotation_type_declaration: "interface",
  method_declaration: "method",
  constructor_declaration: "method",
};

const PY_DEFS: Record<string, SymbolKind> = {
  function_definition: "function",
  class_definition: "class",
};

const CLASS_LIKE: Set<SymbolKind> = new Set(["class", "interface", "enum"]);

export async function extractFile(
  filePath: string,
  source: string,
  lang: LangId
): Promise<FileExtraction> {
  const empty: FileExtraction = { symbols: [], refs: [], imports: [] };
  if (Buffer.byteLength(source) > MAX_FILE_BYTES) return empty;
  const parser = await getParser(lang);
  const tree = parser.parse(source);
  if (!tree) return empty;
  try {
    const ctx = new Extraction(lang);
    ctx.walk(tree.rootNode, -1);
    return ctx.result();
  } finally {
    tree.delete();
  }
}

class Extraction {
  private symbols: ExtractedSymbol[] = [];
  private refs: ExtractedRef[] = [];
  private imports: string[] = [];
  private defs: Record<string, SymbolKind>;

  constructor(private lang: LangId) {
    this.defs =
      lang === "java" ? JAVA_DEFS : lang === "python" ? PY_DEFS : JS_DEFS;
  }

  result(): FileExtraction {
    return { symbols: this.symbols, refs: this.refs, imports: this.imports };
  }

  walk(node: Node, parent: number): void {
    let nextParent = parent;

    const defKind = this.defs[node.type];
    if (defKind) {
      const idx = this.addSymbol(node, defKind, parent);
      if (idx >= 0) nextParent = idx;
    } else {
      this.handleNonDef(node, parent);
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.walk(child, nextParent);
    }
  }

  private addSymbol(node: Node, kind: SymbolKind, parent: number): number {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return -1;
    let resolvedKind = kind;
    // A function nested inside a class body is a method.
    if (
      kind === "function" &&
      parent >= 0 &&
      CLASS_LIKE.has(this.symbols[parent].kind)
    ) {
      resolvedKind = "method";
    }
    // Signature = the source line holding the symbol's name, which skips
    // annotations/decorators (even multi-line ones) reliably.
    const nameLineOffset = nameNode.startPosition.row - node.startPosition.row;
    const sigLine = node.text.split("\n")[nameLineOffset]?.trim();
    this.symbols.push({
      name: nameNode.text,
      kind: resolvedKind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: sigLine ? sigLine.slice(0, 200) : firstLine(node.text),
      parent,
    });
    const idx = this.symbols.length - 1;
    this.extractHeritage(node, idx);
    return idx;
  }

  private handleNonDef(node: Node, parent: number): void {
    switch (this.lang) {
      case "java":
        this.handleJava(node, parent);
        break;
      case "python":
        this.handlePython(node, parent);
        break;
      default:
        this.handleJs(node, parent);
    }
  }

  private handleJs(node: Node, parent: number): void {
    switch (node.type) {
      case "call_expression": {
        const fn = node.childForFieldName("function");
        const name = calleeName(fn);
        if (name) this.addRef(name, "call", node, parent);
        break;
      }
      case "new_expression": {
        const ctor = node.childForFieldName("constructor");
        const name = calleeName(ctor);
        if (name) this.addRef(name, "call", node, parent);
        break;
      }
      case "variable_declarator": {
        // const foo = () => {} / function() {} → treat as function def
        const value = node.childForFieldName("value");
        const nameNode = node.childForFieldName("name");
        if (
          value &&
          nameNode &&
          nameNode.type === "identifier" &&
          (value.type === "arrow_function" || value.type === "function_expression")
        ) {
          this.symbols.push({
            name: nameNode.text,
            kind: "function",
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            signature: firstLine(node.text),
            parent,
          });
        }
        break;
      }
      case "import_statement": {
        const src = node.childForFieldName("source");
        if (src) this.imports.push(stripQuotes(src.text));
        break;
      }
      case "type_identifier": {
        // TS type annotation usage
        this.addRef(node.text, "use", node, parent);
        break;
      }
    }
  }

  private handleJava(node: Node, parent: number): void {
    switch (node.type) {
      case "method_invocation": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) this.addRef(nameNode.text, "call", node, parent);
        break;
      }
      case "object_creation_expression": {
        const typeNode = node.childForFieldName("type");
        if (typeNode) {
          this.addRef(lastIdentifier(typeNode.text), "call", node, parent);
        }
        break;
      }
      case "import_declaration": {
        const spec = node.namedChild(0);
        if (spec) this.imports.push(spec.text);
        break;
      }
      case "type_identifier": {
        // Field/param/variable type usage — how Spring-style DI references
        // classes without ever writing `new Foo()`.
        this.addRef(node.text, "use", node, parent);
        break;
      }
    }
  }

  private handlePython(node: Node, parent: number): void {
    switch (node.type) {
      case "call": {
        const fn = node.childForFieldName("function");
        const name = calleeName(fn);
        if (name) this.addRef(name, "call", node, parent);
        break;
      }
      case "import_statement":
      case "import_from_statement": {
        const mod =
          node.childForFieldName("module_name") ?? node.namedChild(0);
        if (mod) this.imports.push(mod.text);
        break;
      }
    }
  }

  /** extends / implements / superclass lists on a definition node. */
  private extractHeritage(node: Node, symIdx: number): void {
    if (this.lang === "java") {
      const superclass = node.childForFieldName("superclass");
      if (superclass) {
        this.addRef(lastIdentifier(superclass.text), "extends", node, symIdx);
      }
      const interfaces = node.childForFieldName("interfaces");
      if (interfaces) {
        for (const t of identifiersIn(interfaces)) {
          this.addRef(t, "implements", node, symIdx);
        }
      }
    } else if (this.lang === "python") {
      if (node.type === "class_definition") {
        const supers = node.childForFieldName("superclasses");
        if (supers) {
          for (const t of identifiersIn(supers)) {
            this.addRef(t, "extends", node, symIdx);
          }
        }
      }
    } else {
      // JS/TS: class_heritage holds extends/implements clauses
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "class_heritage" || child.type === "extends_clause") {
          for (const t of identifiersIn(child)) {
            this.addRef(t, "extends", node, symIdx);
          }
        } else if (child.type === "implements_clause") {
          for (const t of identifiersIn(child)) {
            this.addRef(t, "implements", node, symIdx);
          }
        }
      }
    }
  }

  private addRef(name: string, kind: RefKind, node: Node, from: number): void {
    if (!name || IGNORED_NAMES.has(name)) return;
    this.refs.push({
      name,
      kind,
      line: node.startPosition.row + 1,
      fromSymbol: from,
    });
  }
}

/** Noise: language builtins that would create useless mega-hub edges. */
const IGNORED_NAMES = new Set([
  "log", "warn", "error", "info", "debug", "print", "println",
  "push", "pop", "shift", "unshift", "map", "filter", "reduce", "forEach",
  "join", "split", "slice", "splice", "concat", "indexOf", "includes",
  "get", "set", "has", "add", "delete", "keys", "values", "entries",
  "toString", "valueOf", "equals", "hashCode", "len", "range", "str",
  "int", "list", "dict", "super", "require", "append", "format",
  "stringify", "parse", "then", "catch", "finally", "resolve", "reject",
  "trim", "replace", "match", "test", "exec", "charAt", "substring",
]);

function firstLine(text: string): string {
  // Skip annotation/decorator lines (@Service, @Override, @Test...) so the
  // signature shows the actual declaration.
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // also skip continuation lines of multi-line annotations
    if (!line || line.startsWith("@") || line.startsWith('"') || line.startsWith(")")) {
      continue;
    }
    return line.slice(0, 200);
  }
  return text.trim().slice(0, 200);
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, "");
}

function lastIdentifier(typeText: string): string {
  // Foo<Bar> -> Foo, a.b.Foo -> Foo
  const base = typeText.split("<")[0].trim();
  const parts = base.split(".");
  return parts[parts.length - 1].trim();
}

/** Callee name for JS/Python call expressions: identifier or member/attribute tail. */
function calleeName(fn: Node | null): string | undefined {
  if (!fn) return undefined;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    return prop?.text;
  }
  if (fn.type === "attribute") {
    const attr = fn.childForFieldName("attribute");
    return attr?.text;
  }
  return undefined;
}

/** All type-ish identifiers inside a heritage clause node. */
function identifiersIn(node: Node): string[] {
  const out: string[] = [];
  const visit = (n: Node) => {
    if (
      n.type === "identifier" ||
      n.type === "type_identifier" ||
      n.type === "constant"
    ) {
      out.push(n.text);
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) visit(c);
    }
  };
  visit(node);
  return out.map(lastIdentifier).filter(Boolean);
}
