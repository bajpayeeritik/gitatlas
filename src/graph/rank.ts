import fs from "node:fs";
import path from "node:path";
import type { GraphDB } from "./db.js";
import type { SymbolRow } from "../types.js";

/**
 * PageRank over the symbol graph. Symbols that many things reference rank
 * higher — the same trick Aider's repo map uses to decide what an LLM should
 * see first.
 */
export function pagerank(
  db: GraphDB,
  iterations = 20,
  damping = 0.85
): Map<number, number> {
  const edges = db.allEdges();
  const nodes = new Set<number>();
  const outDeg = new Map<number, number>();
  const incoming = new Map<number, number[]>();

  for (const { src, dst } of edges) {
    nodes.add(src);
    nodes.add(dst);
    outDeg.set(src, (outDeg.get(src) ?? 0) + 1);
    let list = incoming.get(dst);
    if (!list) incoming.set(dst, (list = []));
    list.push(src);
  }

  const n = nodes.size;
  const rank = new Map<number, number>();
  if (n === 0) return rank;
  for (const id of nodes) rank.set(id, 1 / n);

  for (let it = 0; it < iterations; it++) {
    const next = new Map<number, number>();
    for (const id of nodes) {
      let sum = 0;
      for (const src of incoming.get(id) ?? []) {
        sum += (rank.get(src) ?? 0) / (outDeg.get(src) ?? 1);
      }
      next.set(id, (1 - damping) / n + damping * sum);
    }
    for (const [id, v] of next) rank.set(id, v);
  }
  return rank;
}

export interface ContextChunk {
  symbol: SymbolRow;
  score: number;
  snippet: string;
}

const SNIPPET_MAX_LINES = 50;

/**
 * Rank symbols against a natural-language query (lexical match on name,
 * signature, and path, boosted by PageRank centrality) and pack source
 * snippets under a token budget (~4 chars/token heuristic).
 */
export function findContext(
  db: GraphDB,
  root: string,
  query: string,
  tokenBudget: number
): ContextChunk[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const ranks = pagerank(db);
  let maxRank = 0;
  for (const v of ranks.values()) maxRank = Math.max(maxRank, v);

  const scored: { symbol: SymbolRow; score: number }[] = [];
  for (const sym of db.allSymbols()) {
    const name = sym.name.toLowerCase();
    const sig = sym.signature.toLowerCase();
    const p = sym.path.toLowerCase();
    let lexical = 0;
    for (const term of terms) {
      if (name === term) lexical += 3;
      else if (name.includes(term)) lexical += 1.5;
      if (sig.includes(term)) lexical += 0.5;
      if (p.includes(term)) lexical += 0.5;
    }
    if (lexical === 0) continue;
    const centrality = maxRank > 0 ? (ranks.get(sym.id) ?? 0) / maxRank : 0;
    scored.push({ symbol: sym, score: lexical * (0.5 + centrality) });
  }
  scored.sort((a, b) => b.score - a.score);

  const chunks: ContextChunk[] = [];
  let budgetLeft = tokenBudget;
  const fileCache = new Map<string, string[] | null>();

  for (const { symbol, score } of scored) {
    if (budgetLeft <= 0 || chunks.length >= 30) break;
    let lines = fileCache.get(symbol.path);
    if (lines === undefined) {
      try {
        lines = fs
          .readFileSync(path.join(root, symbol.path), "utf8")
          .split("\n");
      } catch {
        lines = null;
      }
      fileCache.set(symbol.path, lines);
    }
    if (!lines) continue;
    const end = Math.min(
      symbol.end_line,
      symbol.start_line + SNIPPET_MAX_LINES - 1,
      lines.length
    );
    const snippet = lines.slice(symbol.start_line - 1, end).join("\n");
    const cost = Math.ceil(snippet.length / 4) + 20;
    if (cost > budgetLeft && chunks.length > 0) continue;
    budgetLeft -= cost;
    chunks.push({ symbol, score, snippet });
  }
  return chunks;
}
