# codegraph

**A living knowledge graph of your codebase, served to every AI coding tool as a source of truth.**

`codegraph` indexes your repository into a symbol graph (functions, classes, methods, calls, inheritance, imports), keeps that graph up to date automatically on every commit via git hooks, and exposes it to any MCP-capable AI tool — Claude Code, Cursor, Codex, Antigravity, Windsurf, Copilot — through a standard [Model Context Protocol](https://modelcontextprotocol.io) server.

```
┌─────────────┐   tree-sitter    ┌──────────────────┐    MCP (stdio)    ┌──────────────┐
│  your repo  │ ───────────────► │ .codegraph/      │ ────────────────► │ Claude Code  │
│             │                  │   graph.db       │                   │ Cursor       │
│  git commit │ ── post-commit ─►│  (SQLite, local) │                   │ Codex, ...   │
└─────────────┘   incremental    └──────────────────┘                   └──────────────┘
```

- **Zero infrastructure.** The graph is a single SQLite file in `.codegraph/` next to `.git/`. No Neo4j, no docker, no server to run.
- **Incremental by content hash.** Every file's parse is keyed by its content hash — unchanged files cost nothing, so post-commit updates are fast even on large repos.
- **Language support:** TypeScript, JavaScript, JSX/TSX, Java, Python (via tree-sitter WASM grammars — no native compilation needed).
- **Respects .gitignore** — file discovery uses `git ls-files`, so build output and vendored code never pollute the graph.

## Quick start

```bash
npm install -g codegraph        # or: npm link from a clone

cd your-repo
codegraph index                 # build the graph (fast; incremental after the first run)
codegraph install-hook          # keep it fresh on every commit / merge / branch switch
codegraph stats                 # see what got indexed
```

### Hook it up to your AI tool

Any MCP client works. For **Claude Code** (`.mcp.json` in the repo root):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--root", "."]
    }
  }
}
```

For **Cursor** (`.cursor/mcp.json`) and other clients, the same `command`/`args` shape applies.

### MCP tools exposed

| Tool | What it answers |
|---|---|
| `find_context` | "Give me the most relevant code for this task" — ranked by lexical match × graph centrality (PageRank), packed under a token budget |
| `who_calls` | Reverse dependencies: everything that calls/references a symbol |
| `what_it_calls` | Forward dependencies of a symbol |
| `impact_of_change` | Blast radius of editing a file (direct + 1-hop transitive dependents) |
| `file_outline` | All symbols in a file with line ranges — structure without reading the file |
| `get_symbol` / `search_symbols` | Exact and fuzzy symbol lookup |
| `graph_stats` | Index freshness and size |
| `reindex` | Force an incremental refresh |

### CLI queries (no MCP client needed)

```bash
codegraph symbol AnalysisService
codegraph callers detectProblem
codegraph context "how does perplexity api integration work" --budget 3000
```

## How it works

1. **Parse** — tree-sitter (WASM) turns each source file into an AST; we extract definitions (functions, classes, methods, interfaces, enums), references (calls, `extends`, `implements`), and imports.
2. **Store** — everything lands in SQLite (WAL mode) with the file's content hash. Deleting a file's row cascades to its symbols and references.
3. **Link** — a second phase resolves references to definitions by name across the whole repo, producing the edge table.
4. **Update** — git hooks (`post-commit`, `post-merge`, `post-checkout`) run `codegraph update`: files are re-listed, hashes compared, and only changed files re-parsed before re-linking.
5. **Serve** — the MCP server answers structural queries straight from SQLite and ranks context with PageRank centrality (the same insight behind Aider's repo map: what everything points at is what the model most needs to see).

## Honest limitations (MVP)

- **Name-based linking.** References resolve by identifier name, not full type-aware resolution — same-named symbols in different files all receive edges. SCIP-precision resolution is the top roadmap item.
- Dynamic dispatch, reflection, and metaprogramming are invisible, as in every static index.
- Common builtin names (`map`, `get`, `toString`, …) are deliberately not linked to avoid mega-hub noise.

## Roadmap

- [ ] SCIP/LSP-based precise symbol resolution (per-language)
- [ ] Embedding-based semantic retrieval fused with graph ranking
- [ ] Benchmark harness: CrossCodeEval / RepoBench retrieval ablations, SWE-bench delta with a fixed agent
- [ ] Graph sharing in CI (index once, distribute to the team)
- [ ] More languages (Go, Rust, C#, Ruby)

## License

MIT
