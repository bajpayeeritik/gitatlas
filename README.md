# codegraph

**A living knowledge graph of your codebase, served to every AI coding tool as a source of truth.**

`codegraph` indexes your repository into a symbol graph (functions, classes, methods, calls, inheritance, type usage, imports), keeps that graph up to date automatically on every commit via git hooks, and exposes it to any MCP-capable AI tool — Claude Code, Cursor, Codex, Antigravity, Windsurf, Copilot — through a standard [Model Context Protocol](https://modelcontextprotocol.io) server.

```
┌─────────────┐   tree-sitter    ┌──────────────────┐    MCP (stdio)    ┌──────────────┐
│  your repo  │ ───────────────► │ .codegraph/      │ ────────────────► │ Claude Code  │
│             │                  │   graph.db       │                   │ Cursor       │
│  git commit │ ── post-commit ─►│  (SQLite, local) │                   │ Codex, ...   │
└─────────────┘   incremental    └──────────────────┘                   └──────────────┘
```

- **Zero infrastructure.** The graph is a single SQLite file in `.codegraph/` next to `.git/`. No Neo4j, no docker, no server to babysit.
- **Incremental by content hash.** Every file's parse is keyed by its content hash — unchanged files cost nothing. A no-op update takes ~50ms; indexing a multi-service repo from scratch takes ~150ms.
- **Languages:** TypeScript, JavaScript, JSX/TSX, Java, Python — via tree-sitter WASM grammars, so `npm install` never needs a C++ toolchain.
- **Respects .gitignore.** File discovery uses `git ls-files`, so build output and vendored code never pollute the graph.

## Why

AI coding agents answer questions about your repo by grepping and reading whole files. That works, but it is expensive: in [a benchmark on a real repo](#does-it-actually-help) the grep-and-read workflow needed **12.9× more context tokens** and **3× more tool calls** than one graph query to answer the same eight questions — and hit a dead end on one of them. Context tokens are money, latency, and crowded model attention. A pre-built graph answers structural questions ("who calls this?", "what breaks if I change this file?") in one shot, pre-structured.

## Installation

```bash
git clone https://github.com/bajpayeeritik/codegraph.git
cd codegraph
npm install
npm run build
npm link          # puts the `codegraph` command on your PATH
```

Requires Node.js ≥ 20. (npm registry publication is planned; then this becomes `npm install -g codegraph`.)

## Quick start

```bash
cd your-repo

codegraph index          # build the graph → .codegraph/graph.db
codegraph install-hook   # auto-update on every commit / merge / branch switch
codegraph stats          # see what got indexed

echo ".codegraph/" >> .gitignore
```

That's it. From now on, every `git commit` re-indexes only the files that changed.

## Connect your AI tool

The MCP server runs over stdio: `codegraph serve --root <repo>`. Register it once per repo:

**Claude Code** — create `.mcp.json` in the repo root:

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

**Cursor** — same JSON shape in `.cursor/mcp.json`.

**Codex CLI** — in `~/.codex/config.toml`:

```toml
[mcp_servers.codegraph]
command = "codegraph"
args = ["serve", "--root", "."]
```

**Antigravity / Windsurf / other MCP clients** — any client that can launch a stdio MCP server works with the same `command` + `args`.

Once connected, the agent gets these tools:

| Tool | What it answers |
|---|---|
| `repo_map` | One-shot orientation: the most central symbols in the repo, grouped by file, signatures only |
| `find_context` | "Give me the most relevant code for this task" — identifiers in the query are detected as anchors and answered with definition + usage windows; the rest is ranked by lexical match × graph centrality (PageRank), packed under a token budget |
| `usages` | Definition of a symbol plus a ±4-line code window around every reference site — the cheapest complete answer to "change how X is used everywhere" |
| `who_calls` | Reverse dependencies: everything that calls/references a symbol |
| `what_it_calls` | Forward dependencies of a symbol |
| `impact_of_change` | Blast radius of editing a file (direct + 1-hop transitive dependents) |
| `file_outline` | All symbols in a file with line ranges — structure without reading the file |
| `get_symbol` / `search_symbols` | Exact and fuzzy symbol lookup |
| `graph_stats` | Index freshness and size |
| `reindex` | Force an incremental refresh |

## CLI reference

Every MCP tool is also a CLI command, so you can use the graph without any AI tool:

```bash
codegraph index [--root <path>]        # build / refresh the graph
codegraph update [--quiet]             # incremental update (what the git hook runs)
codegraph serve                        # MCP server on stdio
codegraph install-hook                 # add post-commit/merge/checkout hooks
codegraph uninstall-hook               # remove them cleanly
codegraph stats                        # graph size + last-indexed time

codegraph symbol AnalysisService       # where is this symbol defined?
codegraph callers UserCodingData       # who uses it?
codegraph callees AnalysisController   # what does it depend on?
codegraph outline src/service/Foo.java # file structure without reading it
codegraph impact src/service/Foo.java  # what breaks if I change this file?
codegraph repo-map --budget 1200       # whole-repo orientation map
codegraph usages isConfigured          # def + code window at every usage site
codegraph context "how does retry work" --budget 3000   # ranked snippets
```

All commands take `--root <path>` (defaults to the current directory).

## Does it actually help?

Benchmark on a real repo (a Java Spring microservice + Chrome extension): 8 developer questions, each answered via one codegraph query vs the grep-then-read-matched-files workflow an AI agent otherwise performs.

| Metric | With codegraph | Without |
|---|---|---|
| Context tokens the agent must read | **3,241** | 57,882 |
| Tool invocations | **8** | 23 |
| Dead ends (search term had zero hits) | **0** | 1 |

Highlights: "who uses this DTO?" was 248 tokens vs 10,515 (results are grouped by file, so paths and class prefixes appear once); a 629-line service file's structure was 758 tokens vs 7,452; and where `grep retry` returned nothing, ranked graph retrieval still surfaced the right methods. The gap grows with repo size — grep-and-read cost scales with the codebase, graph query cost doesn't.

Output is token-frugal by design: `find_context` returns full source only for the top hits and one-line signatures for runners-up; list-returning tools group by file and collapse repeated prefixes; `repo_map` gives an agent a whole-repo orientation (most central symbols, signatures only) for a few hundred tokens.

Real tasks usually embed an identifier — "handle the case where `checkIsFse` returns false". `find_context` detects such anchors and answers with the definition plus a ±4-line window around every reference site instead of whole enclosing functions: on a representative query this cut output from ~945 to ~354 tokens while *increasing* coverage (every call site, not just the top-ranked three). Generic task words ("handle", "cases", "false") are stopworded so they can't drag in irrelevant code.

Paraphrases anchor too: developers paraphrase identifiers by splitting them into words, so symbols are matched by subtoken coverage — "the FSE check" finds `checkIsFse`, "the perplexity configured check" finds `isConfigured` — with no embeddings and no extra dependencies. Embedding fusion (on the roadmap) is then only needed for true synonyms, e.g. "auth" → `login`.

## How it works

1. **Parse** — tree-sitter (WASM) turns each source file into an AST; we extract definitions (functions, classes, methods, interfaces, enums), references (calls, `extends`, `implements`, type usage — so Spring-style DI is captured), and imports.
2. **Store** — everything lands in SQLite (WAL mode) keyed by the file's content hash. Removing a file cascades to its symbols and references. An extractor-version stamp auto-invalidates cached parses when extraction logic changes.
3. **Link** — a second phase resolves references to definitions by name across the repo, producing the edge table.
4. **Update** — git hooks (`post-commit`, `post-merge`, `post-checkout`) run `codegraph update`: hashes are compared and only changed files are re-parsed before re-linking. Existing hooks are appended to, never clobbered.
5. **Serve** — the MCP server answers structural queries straight from SQLite and ranks context with PageRank centrality (the same insight behind Aider's repo map: what everything points at is what the model most needs to see).

## Honest limitations (MVP)

- **Name-based linking.** References resolve by identifier name, not type-aware resolution — same-named symbols in different files all receive edges. SCIP-precision resolution is the top roadmap item.
- Dynamic dispatch, reflection, and metaprogramming are invisible, as in every static index.
- Common builtin names (`map`, `get`, `toString`, …) are deliberately not linked to avoid mega-hub noise.
- `who_calls` on an interface returns implementors *and* users together (the `implements`/`use` edge kinds are stored but not yet filterable from the CLI).

## Roadmap

- [ ] SCIP/LSP-based precise symbol resolution (per-language)
- [ ] Embedding-based semantic retrieval fused with graph ranking
- [ ] Benchmark harness: CrossCodeEval / RepoBench retrieval ablations, SWE-bench delta with a fixed agent
- [ ] npm registry publication (`npm install -g codegraph`)
- [ ] Graph sharing in CI (index once, distribute to the team)
- [ ] More languages (Go, Rust, C#, Ruby)

## Contributing

Issues and PRs welcome. The codebase is small and deliberately boring: `src/indexer/` (tree-sitter extraction), `src/graph/` (SQLite store + ranking), `src/mcp/` (server), `src/cli.ts`. `npm run build` then `node dist/cli.js index --root <some-repo>` is the whole dev loop.

## License

MIT
