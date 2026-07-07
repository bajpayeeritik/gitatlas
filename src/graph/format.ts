import type { SymbolRow } from "../types.js";
import type { GraphDB } from "./db.js";
import { pagerank } from "./rank.js";

/**
 * Token-frugal symbol list: group by file so paths appear once, collapse
 * `Class.method` prefixes into per-class groups, cap long lists.
 *
 *   src/service/AnalysisService.java
 *     class AnalysisService:23
 *     AnalysisService methods: analyzeUserCodingPatterns:42, performAIAnalysis:163, +3 more
 */
export function compactSymbolList(rows: SymbolRow[], maxEntries = 40): string {
  if (rows.length === 0) return "(none)";
  const byFile = new Map<string, SymbolRow[]>();
  for (const r of rows) {
    let list = byFile.get(r.path);
    if (!list) byFile.set(r.path, (list = []));
    list.push(r);
  }

  const lines: string[] = [];
  let shown = 0;
  let truncated = 0;
  for (const [path, syms] of byFile) {
    if (shown >= maxEntries) {
      truncated += syms.length;
      continue;
    }
    lines.push(path);
    // methods grouped by owning class; everything else listed individually
    const methodsByClass = new Map<string, SymbolRow[]>();
    const rest: SymbolRow[] = [];
    for (const s of syms) {
      const dot = s.qualified_name.indexOf(".");
      if (s.kind === "method" && dot > 0) {
        const cls = s.qualified_name.slice(0, dot);
        let list = methodsByClass.get(cls);
        if (!list) methodsByClass.set(cls, (list = []));
        list.push(s);
      } else {
        rest.push(s);
      }
    }
    for (const s of rest) {
      if (shown >= maxEntries) { truncated++; continue; }
      lines.push(`  ${s.kind} ${s.name}:${s.start_line}`);
      shown++;
    }
    for (const [cls, methods] of methodsByClass) {
      const room = maxEntries - shown;
      if (room <= 0) { truncated += methods.length; continue; }
      const take = methods.slice(0, room);
      const extra = methods.length - take.length;
      truncated += extra;
      shown += take.length;
      lines.push(
        `  ${cls} methods: ` +
          take.map((m) => `${m.name}:${m.start_line}`).join(", ") +
          (extra > 0 ? `, +${extra} more` : "")
      );
    }
  }
  if (truncated > 0) lines.push(`(+${truncated} more entries omitted)`);
  return lines.join("\n");
}

/**
 * Aider-style repo map: the most central symbols (PageRank) grouped by file,
 * signatures only, packed under a token budget. One call orients an agent in
 * an unfamiliar repo for a few hundred tokens.
 */
export function repoMap(db: GraphDB, tokenBudget = 1200): string {
  const ranks = pagerank(db);
  // Centrality-ordered; class-like symbols get a boost so the map reads as
  // repo shape rather than a flat list of hot functions.
  const picked = db
    .allSymbols()
    .map((s) => ({
      s,
      r:
        (ranks.get(s.id) ?? 0) *
        (s.kind === "class" || s.kind === "interface" ? 3 : 1),
    }))
    .filter(({ r }) => r > 0)
    .sort((a, b) => b.r - a.r)
    .slice(0, 100)
    .map(({ s }) => s);

  const byFile = new Map<string, SymbolRow[]>();
  for (const s of picked) {
    let list = byFile.get(s.path);
    if (!list) byFile.set(s.path, (list = []));
    list.push(s);
  }

  let budget = tokenBudget * 4; // chars
  const lines: string[] = [];
  for (const [path, syms] of byFile) {
    if (budget <= 0) break;
    const block = [path];
    for (const s of syms.slice(0, 12).sort((a, b) => a.start_line - b.start_line)) {
      block.push(`  ${s.signature.slice(0, 100)}`);
    }
    const text = block.join("\n");
    if (text.length > budget && lines.length > 0) continue;
    budget -= text.length;
    lines.push(text);
  }
  return lines.join("\n");
}
