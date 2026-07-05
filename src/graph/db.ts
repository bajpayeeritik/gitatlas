import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { FileExtraction, SymbolRow, RefKind } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  language TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  from_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE TABLE IF NOT EXISTS edges (
  src INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE TABLE IF NOT EXISTS imports (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  spec TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DB_DIR = ".codegraph";
export const DB_FILE = "graph.db";

export function dbPath(root: string): string {
  return path.join(root, DB_DIR, DB_FILE);
}

export class GraphDB {
  readonly db: Database.Database;

  constructor(root: string) {
    const dir = path.join(root, DB_DIR);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, DB_FILE));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getFileHashes(): Map<string, string> {
    const rows = this.db.prepare("SELECT path, hash FROM files").all() as {
      path: string;
      hash: string;
    }[];
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  removeFile(filePath: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }

  /** Replace all indexed data for one file in a single transaction. */
  upsertFile(
    filePath: string,
    hash: string,
    language: string,
    data: FileExtraction
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
      const fileId = this.db
        .prepare(
          "INSERT INTO files (path, hash, language, indexed_at) VALUES (?, ?, ?, ?)"
        )
        .run(filePath, hash, language, new Date().toISOString())
        .lastInsertRowid as number;

      const insSym = this.db.prepare(
        `INSERT INTO symbols (file_id, name, qualified_name, kind, start_line, end_line, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const symIds: number[] = [];
      for (const s of data.symbols) {
        const qualified =
          s.parent >= 0 && data.symbols[s.parent]
            ? `${data.symbols[s.parent].name}.${s.name}`
            : s.name;
        const id = insSym.run(
          fileId,
          s.name,
          qualified,
          s.kind,
          s.startLine,
          s.endLine,
          s.signature
        ).lastInsertRowid as number;
        symIds.push(id);
      }

      const insRef = this.db.prepare(
        "INSERT INTO refs (file_id, from_symbol_id, name, kind, line) VALUES (?, ?, ?, ?, ?)"
      );
      for (const r of data.refs) {
        insRef.run(
          fileId,
          r.fromSymbol >= 0 ? symIds[r.fromSymbol] : null,
          r.name,
          r.kind,
          r.line
        );
      }

      const insImp = this.db.prepare(
        "INSERT INTO imports (file_id, spec) VALUES (?, ?)"
      );
      for (const spec of data.imports) insImp.run(fileId, spec);
    });
    tx();
  }

  /**
   * Link phase: rebuild the edges table by resolving refs to symbol
   * definitions by name. Same-name collisions produce edges to every
   * candidate definition (documented MVP limitation; SCIP-precision
   * resolution is on the roadmap).
   */
  link(): number {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM edges");
      this.db.exec(`
        INSERT OR IGNORE INTO edges (src, dst, kind)
        SELECT r.from_symbol_id, s.id, r.kind
        FROM refs r
        JOIN symbols s ON s.name = r.name
        WHERE r.from_symbol_id IS NOT NULL
          AND s.id != r.from_symbol_id
      `);
    });
    tx();
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }
    ).n;
  }

  stats(): { files: number; symbols: number; refs: number; edges: number } {
    const one = (sql: string) =>
      (this.db.prepare(sql).get() as { n: number }).n;
    return {
      files: one("SELECT COUNT(*) AS n FROM files"),
      symbols: one("SELECT COUNT(*) AS n FROM symbols"),
      refs: one("SELECT COUNT(*) AS n FROM refs"),
      edges: one("SELECT COUNT(*) AS n FROM edges"),
    };
  }

  findSymbols(name: string, limit = 20): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT s.id, s.file_id, f.path, s.name, s.qualified_name, s.kind,
                s.start_line, s.end_line, s.signature
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name = ? OR s.qualified_name = ?
         ORDER BY s.kind != 'class', s.name LIMIT ?`
      )
      .all(name, name, limit) as SymbolRow[];
  }

  searchSymbols(pattern: string, limit = 50): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT s.id, s.file_id, f.path, s.name, s.qualified_name, s.kind,
                s.start_line, s.end_line, s.signature
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name LIKE ? ORDER BY LENGTH(s.name) LIMIT ?`
      )
      .all(`%${pattern}%`, limit) as SymbolRow[];
  }

  fileSymbols(filePath: string): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT s.id, s.file_id, f.path, s.name, s.qualified_name, s.kind,
                s.start_line, s.end_line, s.signature
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ? ORDER BY s.start_line`
      )
      .all(filePath) as SymbolRow[];
  }

  /** Symbols with an edge pointing at any of the given symbol ids. */
  callersOf(symbolIds: number[], kind?: RefKind): SymbolRow[] {
    if (symbolIds.length === 0) return [];
    const placeholders = symbolIds.map(() => "?").join(",");
    const kindClause = kind ? "AND e.kind = ?" : "";
    const params: (number | string)[] = [...symbolIds];
    if (kind) params.push(kind);
    return this.db
      .prepare(
        `SELECT DISTINCT s.id, s.file_id, f.path, s.name, s.qualified_name, s.kind,
                s.start_line, s.end_line, s.signature
         FROM edges e
         JOIN symbols s ON s.id = e.src
         JOIN files f ON f.id = s.file_id
         WHERE e.dst IN (${placeholders}) ${kindClause}
         ORDER BY f.path, s.start_line`
      )
      .all(...params) as SymbolRow[];
  }

  /** Symbols that the given symbol ids point at (callees / supertypes). */
  calleesOf(symbolIds: number[]): SymbolRow[] {
    if (symbolIds.length === 0) return [];
    const placeholders = symbolIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT DISTINCT s.id, s.file_id, f.path, s.name, s.qualified_name, s.kind,
                s.start_line, s.end_line, s.signature
         FROM edges e
         JOIN symbols s ON s.id = e.dst
         JOIN files f ON f.id = s.file_id
         WHERE e.src IN (${placeholders})
         ORDER BY f.path, s.start_line`
      )
      .all(...symbolIds) as SymbolRow[];
  }

  allEdges(): { src: number; dst: number }[] {
    return this.db.prepare("SELECT src, dst FROM edges").all() as {
      src: number;
      dst: number;
    }[];
  }

  allSymbols(): SymbolRow[] {
    return this.db
      .prepare(
        `SELECT s.id, s.file_id, f.path, s.name, s.qualified_name, s.kind,
                s.start_line, s.end_line, s.signature
         FROM symbols s JOIN files f ON f.id = s.file_id`
      )
      .all() as SymbolRow[];
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
}
