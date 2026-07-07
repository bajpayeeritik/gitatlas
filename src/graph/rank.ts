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

export interface ContextResult {
  /** identifier(s) from the query found in the graph: def + usage windows */
  anchored: string | null;
  /** top hits with full source snippets */
  chunks: ContextChunk[];
  /** runner-up hits, signature-only (agent can ask for more) */
  brief: { symbol: SymbolRow; score: number }[];
}

function readLines(root: string, rel: string): string[] | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8").split("\n");
  } catch {
    return null;
  }
}

const DEF_MAX_LINES = 14;

/**
 * Surgical context for one known symbol: its definition plus a ±window line
 * excerpt around every reference site — instead of whole enclosing functions.
 * This is what a task like "handle checkIsFse returning false" actually
 * needs: the semantics of the function and each place its result is used.
 */
export function usageContext(
  db: GraphDB,
  root: string,
  name: string,
  window = 4,
  maxSites = 20
): string {
  const defs = db.findSymbols(name);
  if (defs.length === 0) return `No symbol named '${name}'.`;
  const out: string[] = [];

  for (const d of defs.slice(0, 3)) {
    out.push(`${d.kind} ${d.qualified_name} [${d.path}:${d.start_line}-${d.end_line}]`);
    const src = readLines(root, d.path);
    if (src) {
      const len = d.end_line - d.start_line + 1;
      const take = Math.min(len, DEF_MAX_LINES);
      for (let i = 0; i < take; i++) out.push(`  ${src[d.start_line - 1 + i]}`);
      if (len > take) out.push(`  ... (+${len - take} more lines)`);
    }
  }

  const refs = db.refsTo(name);
  if (refs.length === 0) {
    out.push(`\nNo indexed references to '${name}'.`);
    return out.join("\n");
  }
  out.push(`\n${refs.length} reference site(s):`);

  const byFile = new Map<string, typeof refs>();
  for (const r of refs) {
    let list = byFile.get(r.path);
    if (!list) byFile.set(r.path, (list = []));
    list.push(r);
  }

  let sites = 0;
  let omitted = 0;
  for (const [rel, rs] of byFile) {
    const src = readLines(root, rel);
    if (!src) continue;
    if (sites >= maxSites) { omitted += rs.length; continue; }
    out.push(rel);
    // merge overlapping ±window excerpts so adjacent call sites print once
    type Win = { s: number; e: number; at: number[]; from: Set<string> };
    const wins: Win[] = [];
    for (const r of rs) {
      if (sites >= maxSites) { omitted++; continue; }
      const s = Math.max(1, r.line - window);
      const e = Math.min(src.length, r.line + window);
      const last = wins[wins.length - 1];
      if (last && s <= last.e + 1) {
        last.e = Math.max(last.e, e);
        last.at.push(r.line);
        if (r.from) last.from.add(r.from);
      } else {
        wins.push({ s, e, at: [r.line], from: new Set(r.from ? [r.from] : []) });
      }
      sites++;
    }
    for (const w of wins) {
      const where = w.from.size > 0 ? ` in ${[...w.from].join(", ")}` : "";
      out.push(`  @${w.at.join(",")}${where}`);
      for (let i = w.s; i <= w.e; i++) out.push(`  ${i}│ ${src[i - 1]}`);
    }
  }
  if (omitted > 0) out.push(`(+${omitted} more sites omitted)`);
  return out.join("\n");
}

/** camelCase/snake_case tokens in the query that name indexed symbols. */
export function detectAnchors(db: GraphDB, query: string, max = 3): string[] {
  const tokens = [...new Set(query.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])]
    // longer tokens first: identifiers beat words like "handle" or "return"
    .sort((a, b) => b.length - a.length);
  const anchors: string[] = [];
  for (const t of tokens) {
    if (anchors.length >= max) break;
    const canonical = db.resolveName(t);
    if (canonical && !anchors.includes(canonical)) anchors.push(canonical);
  }
  return anchors;
}

const SNIPPET_MAX_LINES = 40;
const MAX_FULL_SNIPPETS = 3;
const MAX_BRIEF = 12;

const TASK_STOPWORDS = new Set([
  "need", "needs", "needed", "add", "adding", "additional", "change",
  "changes", "changed", "handle", "handles", "handling", "case", "cases",
  "return", "returns", "returned", "returning", "function", "method",
  "class", "where", "when", "which", "what", "also", "make", "making",
  "implement", "implementing", "support", "update", "updating", "fix",
  "fixing", "code", "file", "files", "true", "false", "null", "undefined",
  "the", "and", "for", "with", "from", "into", "this", "that", "should",
  "want", "please", "new", "use", "using", "value", "values",
]);

/**
 * Rank symbols against a natural-language query (lexical match on name,
 * signature, and path, boosted by PageRank centrality) and pack results
 * under a token budget (~4 chars/token heuristic). Token-frugal by design:
 * only the top hits get full source; the rest are one-line signatures, and
 * overlapping symbols (a class and its own methods) are deduplicated.
 */
export function findContext(
  db: GraphDB,
  root: string,
  query: string,
  tokenBudget: number
): ContextResult {
  // Identifiers in the query that exist in the graph get surgical treatment:
  // definition + usage windows, far cheaper than ranked full snippets.
  const anchors = detectAnchors(db, query);
  let anchored: string | null = null;
  let budget = tokenBudget;
  const anchorDefIds = new Set<number>();
  if (anchors.length > 0) {
    anchored = anchors.map((a) => usageContext(db, root, a)).join("\n\n");
    const maxChars = Math.floor(budget * 4 * 0.8);
    if (anchored.length > maxChars) {
      anchored = anchored.slice(0, maxChars) + "\n... (truncated; raise token_budget)";
    }
    budget -= Math.ceil(anchored.length / 4);
    for (const a of anchors) {
      for (const d of db.findSymbols(a)) anchorDefIds.add(d.id);
    }
  }

  const anchorSet = new Set(anchors.map((a) => a.toLowerCase()));
  const allTerms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2 && !anchorSet.has(t));
  // Generic task-phrasing words rank nothing useful ("handle the case where
  // X returns false" should score on X's domain, not on "handle"/"false").
  let terms = allTerms.filter((t) => !TASK_STOPWORDS.has(t));
  if (terms.length === 0) terms = allTerms;
  if (terms.length === 0) return { anchored, chunks: [], brief: [] };

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
  const brief: { symbol: SymbolRow; score: number }[] = [];
  // With anchors satisfied, lexical extras are secondary: signatures only.
  const maxFull = anchored ? 0 : MAX_FULL_SNIPPETS;
  const maxBrief = anchored ? 5 : MAX_BRIEF;
  let budgetLeft = budget;
  const fileCache = new Map<string, string[] | null>();
  const overlaps = (s: SymbolRow) =>
    chunks.some(
      (c) =>
        c.symbol.path === s.path &&
        // either range contains the other -> same code would repeat
        ((c.symbol.start_line <= s.start_line && c.symbol.end_line >= s.end_line) ||
          (s.start_line <= c.symbol.start_line && s.end_line >= c.symbol.end_line))
    );

  for (const { symbol, score } of scored) {
    if (budgetLeft <= 0) break;
    if (anchorDefIds.has(symbol.id)) continue;
    if (overlaps(symbol)) continue;
    if (chunks.length < maxFull) {
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
    } else {
      if (brief.length >= maxBrief) break;
      const cost = 20;
      if (cost > budgetLeft) break;
      budgetLeft -= cost;
      brief.push({ symbol, score });
    }
  }
  return { anchored, chunks, brief };
}
