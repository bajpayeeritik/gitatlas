import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import { GraphDB, dbPath } from "../graph/db.js";
import { findContext } from "../graph/rank.js";
import { indexRepo } from "../indexer/indexer.js";
import type { SymbolRow } from "../types.js";

function fmtSymbol(s: SymbolRow): string {
  return `${s.kind} ${s.qualified_name}  [${s.path}:${s.start_line}-${s.end_line}]\n    ${s.signature}`;
}

function fmtList(rows: SymbolRow[], emptyMsg: string): string {
  if (rows.length === 0) return emptyMsg;
  return rows.map(fmtSymbol).join("\n");
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
    "graph_stats",
    {
      description:
        "Statistics about the code graph for this repository: file, symbol, reference and edge counts, plus when it was last indexed.",
      inputSchema: {},
    },
    async () => {
      const s = db.stats();
      const last = db.getMeta("last_indexed") ?? "never";
      return text(
        `files: ${s.files}\nsymbols: ${s.symbols}\nreferences: ${s.refs}\nedges: ${s.edges}\nlast indexed: ${last}`
      );
    }
  );

  server.registerTool(
    "get_symbol",
    {
      description:
        "Look up a function, class, method or interface by exact name (or Qualified.Name) and get its location and signature.",
      inputSchema: { name: z.string().describe("Exact symbol name") },
    },
    async ({ name }) =>
      text(fmtList(db.findSymbols(name), `No symbol named '${name}' found.`))
  );

  server.registerTool(
    "search_symbols",
    {
      description:
        "Fuzzy-search symbols by substring of their name. Use when you don't know the exact name.",
      inputSchema: { pattern: z.string().describe("Substring to search for") },
    },
    async ({ pattern }) =>
      text(
        fmtList(
          db.searchSymbols(pattern),
          `No symbols matching '${pattern}'.`
        )
      )
  );

  server.registerTool(
    "who_calls",
    {
      description:
        "Find all functions/methods that call or reference the named symbol (reverse dependency lookup). Essential before changing a function's behavior or signature.",
      inputSchema: { name: z.string().describe("Symbol name to find callers of") },
    },
    async ({ name }) => {
      const targets = db.findSymbols(name);
      if (targets.length === 0) return text(`No symbol named '${name}' found.`);
      const callers = db.callersOf(targets.map((t) => t.id));
      return text(
        `Definitions:\n${fmtList(targets, "")}\n\nCalled/referenced by ${callers.length} symbol(s):\n` +
          fmtList(callers, "  (nothing in the indexed graph references it)")
      );
    }
  );

  server.registerTool(
    "what_it_calls",
    {
      description:
        "Find everything the named symbol calls or depends on (forward dependencies).",
      inputSchema: { name: z.string().describe("Symbol name") },
    },
    async ({ name }) => {
      const sources = db.findSymbols(name);
      if (sources.length === 0) return text(`No symbol named '${name}' found.`);
      const callees = db.calleesOf(sources.map((s) => s.id));
      return text(
        `'${name}' calls/references ${callees.length} indexed symbol(s):\n` +
          fmtList(callees, "  (no resolved outgoing references)")
      );
    }
  );

  server.registerTool(
    "file_outline",
    {
      description:
        "List every symbol defined in a file (repo-relative path, forward slashes), with line ranges. Faster than reading the file when you only need structure.",
      inputSchema: {
        path: z.string().describe("Repo-relative file path, e.g. src/app/main.ts"),
      },
    },
    async ({ path: p }) => {
      const rows = db.fileSymbols(p.replace(/\\/g, "/"));
      return text(fmtList(rows, `No indexed symbols in '${p}' (wrong path, or file not indexed).`));
    }
  );

  server.registerTool(
    "impact_of_change",
    {
      description:
        "Blast-radius analysis: given a file, list every symbol elsewhere in the repo that depends (directly or one hop transitively) on symbols defined in it. Use before refactoring.",
      inputSchema: { path: z.string().describe("Repo-relative file path") },
    },
    async ({ path: p }) => {
      const defined = db.fileSymbols(p.replace(/\\/g, "/"));
      if (defined.length === 0) {
        return text(`No indexed symbols in '${p}'.`);
      }
      const direct = db.callersOf(defined.map((d) => d.id));
      const directExternal = direct.filter((s) => s.path !== p);
      const secondHop = db
        .callersOf(directExternal.map((s) => s.id))
        .filter(
          (s) => s.path !== p && !directExternal.some((d) => d.id === s.id)
        );
      return text(
        `Symbols defined in ${p}: ${defined.length}\n\n` +
          `Direct dependents (${directExternal.length}):\n` +
          fmtList(directExternal, "  none") +
          `\n\nTransitive dependents, one hop (${secondHop.length}):\n` +
          fmtList(secondHop, "  none")
      );
    }
  );

  server.registerTool(
    "find_context",
    {
      description:
        "The main entry point: given a natural-language task description, return the most relevant code snippets from the repo, ranked by lexical match and graph centrality, packed under a token budget. Call this FIRST when starting work on an unfamiliar part of the codebase.",
      inputSchema: {
        query: z
          .string()
          .describe("Natural-language description of the task or topic"),
        token_budget: z
          .number()
          .optional()
          .describe("Approximate max tokens of context to return (default 4000)"),
      },
    },
    async ({ query, token_budget }) => {
      const chunks = findContext(db, root, query, token_budget ?? 4000);
      if (chunks.length === 0) {
        return text(`No relevant symbols found for: ${query}`);
      }
      const parts = chunks.map(
        (c) =>
          `### ${c.symbol.kind} ${c.symbol.qualified_name} (${c.symbol.path}:${c.symbol.start_line}) [score ${c.score.toFixed(2)}]\n\`\`\`\n${c.snippet}\n\`\`\``
      );
      return text(parts.join("\n\n"));
    }
  );

  server.registerTool(
    "reindex",
    {
      description:
        "Re-index the repository incrementally (only changed files are re-parsed). Call if you suspect the graph is stale.",
      inputSchema: {},
    },
    async () => {
      const stats = await indexRepo(root);
      return text(
        `Reindexed: ${stats.filesIndexed} files updated, ${stats.filesRemoved} removed, ` +
          `${stats.symbols} symbols, ${stats.edges} edges (${stats.durationMs}ms).`
      );
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
