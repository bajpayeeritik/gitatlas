import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import { GraphDB, dbPath } from "../graph/db.js";
import { findContext } from "../graph/rank.js";
import { compactSymbolList, repoMap } from "../graph/format.js";
import { indexRepo } from "../indexer/indexer.js";
import type { SymbolRow } from "../types.js";

function fmtDefs(rows: SymbolRow[]): string {
  return rows
    .map((s) => `${s.kind} ${s.qualified_name} [${s.path}:${s.start_line}-${s.end_line}] ${s.signature}`)
    .join("\n");
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export async function serveMcp(root: string): Promise<void> {
  if (!fs.existsSync(dbPath(root))) {
    // First run against an unindexed repo: build the graph before serving.
    await indexRepo(root);
  }
  const db = new GraphDB(root);

  const server = new McpServer({ name: "codegraph", version: "0.1.0" });

  server.registerTool(
    "repo_map",
    {
      description:
        "Compact orientation map of the repo: most central symbols grouped by file, signatures only. Call once when starting work in an unfamiliar codebase.",
      inputSchema: {
        token_budget: z.number().optional().describe("Max tokens (default 1200)"),
      },
    },
    async ({ token_budget }) => text(repoMap(db, token_budget ?? 1200))
  );

  server.registerTool(
    "find_context",
    {
      description:
        "Most relevant code for a natural-language task, ranked by lexical match and graph centrality. Top hits as source, runners-up as signatures.",
      inputSchema: {
        query: z.string().describe("Task or topic description"),
        token_budget: z.number().optional().describe("Max tokens (default 2000)"),
      },
    },
    async ({ query, token_budget }) => {
      const { chunks, brief } = findContext(db, root, query, token_budget ?? 2000);
      if (chunks.length === 0) return text(`No relevant symbols found for: ${query}`);
      const parts = chunks.map(
        (c) =>
          `### ${c.symbol.kind} ${c.symbol.qualified_name} (${c.symbol.path}:${c.symbol.start_line})\n\`\`\`\n${c.snippet}\n\`\`\``
      );
      if (brief.length > 0) {
        parts.push(
          "Also relevant:\n" +
            brief
              .map((b) => `  ${b.symbol.qualified_name} ${b.symbol.path}:${b.symbol.start_line}`)
              .join("\n")
        );
      }
      return text(parts.join("\n\n"));
    }
  );

  server.registerTool(
    "who_calls",
    {
      description:
        "Everything that calls/references a symbol (reverse dependencies). Use before changing behavior or signatures.",
      inputSchema: { name: z.string().describe("Symbol name") },
    },
    async ({ name }) => {
      const targets = db.findSymbols(name);
      if (targets.length === 0) return text(`No symbol named '${name}'.`);
      const callers = db.callersOf(targets.map((t) => t.id));
      return text(
        `Defined:\n${fmtDefs(targets)}\n\nReferenced by ${callers.length} symbol(s):\n` +
          compactSymbolList(callers)
      );
    }
  );

  server.registerTool(
    "what_it_calls",
    {
      description: "Everything a symbol calls/depends on (forward dependencies).",
      inputSchema: { name: z.string().describe("Symbol name") },
    },
    async ({ name }) => {
      const sources = db.findSymbols(name);
      if (sources.length === 0) return text(`No symbol named '${name}'.`);
      const callees = db.calleesOf(sources.map((s) => s.id));
      return text(
        `'${name}' references ${callees.length} indexed symbol(s):\n` +
          compactSymbolList(callees)
      );
    }
  );

  server.registerTool(
    "file_outline",
    {
      description:
        "All symbols in a file with line ranges. Cheaper than reading the file when you only need structure.",
      inputSchema: { path: z.string().describe("Repo-relative path") },
    },
    async ({ path: p }) => {
      const rows = db.fileSymbols(p.replace(/\\/g, "/"));
      if (rows.length === 0) return text(`No indexed symbols in '${p}'.`);
      return text(
        rows
          .map((s) => `${s.kind} ${s.qualified_name} :${s.start_line}-${s.end_line} ${s.signature}`)
          .join("\n")
      );
    }
  );

  server.registerTool(
    "impact_of_change",
    {
      description:
        "Blast radius of editing a file: external symbols that depend on it, direct and one hop transitive.",
      inputSchema: { path: z.string().describe("Repo-relative path") },
    },
    async ({ path: p }) => {
      const rel = p.replace(/\\/g, "/");
      const defined = db.fileSymbols(rel);
      if (defined.length === 0) return text(`No indexed symbols in '${p}'.`);
      const direct = db.callersOf(defined.map((d) => d.id));
      const directExternal = direct.filter((s) => s.path !== rel);
      const secondHop = db
        .callersOf(directExternal.map((s) => s.id))
        .filter(
          (s) => s.path !== rel && !directExternal.some((d) => d.id === s.id)
        );
      return text(
        `Direct dependents (${directExternal.length}):\n` +
          compactSymbolList(directExternal) +
          `\n\nTransitive, one hop (${secondHop.length}):\n` +
          compactSymbolList(secondHop, 20)
      );
    }
  );

  server.registerTool(
    "get_symbol",
    {
      description: "Exact-name symbol lookup: location and signature.",
      inputSchema: { name: z.string().describe("Exact symbol name") },
    },
    async ({ name }) => {
      const rows = db.findSymbols(name);
      return text(rows.length > 0 ? fmtDefs(rows) : `No symbol named '${name}'.`);
    }
  );

  server.registerTool(
    "search_symbols",
    {
      description: "Fuzzy symbol search by name substring.",
      inputSchema: { pattern: z.string().describe("Substring") },
    },
    async ({ pattern }) => {
      const rows = db.searchSymbols(pattern);
      return text(
        rows.length > 0 ? compactSymbolList(rows) : `No symbols matching '${pattern}'.`
      );
    }
  );

  server.registerTool(
    "reindex",
    {
      description: "Incrementally re-index the repo if the graph seems stale.",
      inputSchema: {},
    },
    async () => {
      const stats = await indexRepo(root);
      return text(
        `Reindexed: ${stats.filesIndexed} updated, ${stats.filesRemoved} removed, ` +
          `${stats.symbols} symbols, ${stats.edges} edges (${stats.durationMs}ms).`
      );
    }
  );

  server.registerTool(
    "graph_stats",
    {
      description: "Graph size and last-indexed time.",
      inputSchema: {},
    },
    async () => {
      const s = db.stats();
      return text(
        `files ${s.files}, symbols ${s.symbols}, refs ${s.refs}, edges ${s.edges}, ` +
          `last indexed ${db.getMeta("last_indexed") ?? "never"}`
      );
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
