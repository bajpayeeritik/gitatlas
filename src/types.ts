export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "constant";

export type RefKind = "call" | "extends" | "implements" | "use";

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  signature: string;
  /** index into the symbols array of the enclosing symbol, or -1 for top level */
  parent: number;
}

export interface ExtractedRef {
  name: string;
  kind: RefKind;
  line: number;
  /** index into the symbols array of the enclosing symbol, or -1 for module level */
  fromSymbol: number;
}

export interface FileExtraction {
  symbols: ExtractedSymbol[];
  refs: ExtractedRef[];
  imports: string[];
}

export interface SymbolRow {
  id: number;
  file_id: number;
  path: string;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  start_line: number;
  end_line: number;
  signature: string;
}

export interface IndexStats {
  files: number;
  symbols: number;
  edges: number;
  durationMs: number;
  filesIndexed: number;
  filesRemoved: number;
}
