# gitatlas

**The code graph that lives in your git history — built once, correct at every commit, shared by every human, agent, and bot on the team.**

`gitatlas` indexes your repository into a symbol graph (functions, classes, methods, calls, inheritance, type usage, imports), keeps that graph in lock-step with your commits via git hooks, and serves it to any MCP-capable AI tool — Claude Code, Cursor, Codex, Antigravity, Windsurf, Copilot — through a standard [Model Context Protocol](https://modelcontextprotocol.io) server.

```
┌─────────────┐   tree-sitter    ┌──────────────────┐    MCP (stdio)    ┌──────────────┐
│  your repo  │ ───────────────► │ .gitatlas/       │ ────────────────► │ Claude Code  │
│             │                  │   graph.db       │                   │ Cursor       │
│  git commit │ ── post-commit ─►│  (SQLite, local) │                   │ Codex, ...   │
└─────────────┘   incremental    └──────────────────┘                   └──────────────┘
```

## Why git-native instead of file watchers?

Most code-intelligence tools watch your editor session: OS file watchers, debounce timers, reconciliation on connect. That works on your laptop — and nowhere else. `gitatlas` keys everything to git instead: the graph is a pure function of a commit, updated by hooks, keyed by content hash. That buys you what watchers can't:

- **CI and cloud agents.** File watchers are useless in CI and to cloud coding agents. A commit-pinned graph can be built once in CI, cached by SHA, and pulled by every teammate and bot.
- **Correct across branch switches and rebases** — content-hash keying means a checkout is just a cache lookup, not a re-index.
- **History** (roadmap): because the graph is a function of a commit, "what did the callers of X look like two releases ago?" is an answerable question. Watcher-based tools have no past.

And the practical basics:

- **Zero infrastructure.** One SQLite file in `.gitatlas/` next to `.git/`. No daemon, no docker, no service.
- **Fast.** Full index of a multi-service repo in ~150ms; no-op incremental update ~50ms.
- **Languages:** TypeScript, JavaScript, JSX/TSX, Java, Python — via tree-sitter WASM grammars, so installation never needs a C++ toolchain.
- **Respects .gitignore.** Discovery uses `git ls-files`; build output never pollutes the graph.

## Token-frugal by design

AI agents answer repo questions by grepping and reading whole files. On a real repo (Java Spring microservices + a Chrome extension), answering 8 typical developer questions cost:

| Metric | With gitatlas | grep + read files |
|---|---|---|
| Context tokens the agent must read | **3,241** | 57,882 |
| Tool invocations | **8** | 23 |
| Dead-end searches | **0** | 1 |

That is a **17.9× context reduction** — which converts directly to cost, latency, and freed-up model attention. How:

- Real tasks embed identifiers — "handle the case where `checkIsFse` returns false". `find_context` detects them as **anchors** and returns the definition plus a ±4-line window around **every** reference site, instead of whole enclosing functions (~945 → ~354 tokens on a representative query, with *better* coverage).
- **Paraphrases anchor too**: developers paraphrase identifiers by splitting them into words, so symbols match by subtoken coverage — "the FSE check" finds `checkIsFse`, "the perplexity configured check" finds `isConfigured`. No embeddings, no model downloads.
- List results group by file and collapse repeated prefixes; long lists cap with `+N more`; generic task words ("handle", "cases", "false") are stopworded.
- `repo_map` orients an agent in an unfamiliar repo — most central symbols (PageRank), signatures only — for a few hundred tokens.

## Installation

```bash
npm install -g gitatlas
```

Or from source:

```bash
git clone https://github.com/bajpayeeritik/gitatlas.git
cd gitatlas && npm install && npm run build && npm link
```

Requires Node.js ≥ 20.

## Quick start

```bash
cd your-repo

gitatlas index          # build the graph → .gitatlas/graph.db
gitatlas install-hook   # auto-update on every commit / merge / branch switch
gitatlas stats          # see what got indexed

echo ".gitatlas/" >> .gitignore
```

## Connect your AI tool

**Claude Code** — `.mcp.json` in the repo root:

```json
{
  "mcpServers": {
    "gitatlas": {
      "command": "gitatlas",
      "args": ["serve", "--root", "."]
    }
  }
}
```

**Cursor** — same JSON shape in `.cursor/mcp.json`.

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.gitatlas]
command = "gitatlas"
args = ["serve", "--root", "."]
```

Any other stdio MCP client works with the same `command` + `args`.

## PR blast radius (GitHub Action)

Put the graph in front of your whole team — no installs required. One workflow file and every pull request gets a sticky comment: which symbols the PR touches, and everything elsewhere that depends on them.

```yaml
# .github/workflows/blast-radius.yml
name: blast radius
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: blast-radius-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  impact:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bajpayeeritik/gitatlas@main
```

Debounced at every layer, because a noisy PR bot gets uninstalled:

1. **One sticky comment per PR**, updated in place — never a new comment per push.
2. **Fingerprint skip** — if a push doesn't change the impact analysis, the comment isn't even edited (no notification churn).
3. **Concurrency cancel** — rapid pushes cancel superseded runs.
4. **Relevance gate** — docs-only PRs exit before indexing anything.
5. **Event + draft filtering** — runs only on `opened`/`synchronize`/`reopened`/`ready_for_review`, skips drafts.

The same report is available locally: `gitatlas impact-report <changed files...>`.

### MCP tools

| Tool | What it answers |
|---|---|
| `repo_map` | One-shot orientation: the most central symbols in the repo, grouped by file, signatures only |
| `find_context` | Most relevant code for a task — identifiers (and paraphrases of them) are anchored with definition + usage windows; the rest ranked by lexical match × PageRank under a token budget |
| `usages` | Definition of a symbol plus a ±4-line window around every reference site — the cheapest complete answer to "change how X is used everywhere" |
| `who_calls` / `what_it_calls` | Reverse / forward dependencies of a symbol |
| `impact_of_change` | Blast radius of editing a file (direct + 1-hop transitive dependents) |
| `file_outline` | All symbols in a file with line ranges — structure without reading it |
| `get_symbol` / `search_symbols` | Exact and fuzzy lookup |
| `graph_stats` / `reindex` | Freshness, size, forced refresh |

### CLI

Every tool is also a CLI command — usable with no AI client at all:

```bash
gitatlas symbol AnalysisService        # where is this defined?
gitatlas callers UserCodingData        # who uses it?
gitatlas callees AnalysisController    # what does it depend on?
gitatlas usages isConfigured           # def + code window at every usage site
gitatlas outline src/service/Foo.java  # file structure without reading it
gitatlas impact src/service/Foo.java   # what breaks if I change this?
gitatlas repo-map --budget 1200        # whole-repo orientation map
gitatlas context "how does retry work" # ranked snippets under a token budget
```

All commands take `--root <path>` (defaults to the current directory).

## How it works

1. **Parse** — tree-sitter (WASM) extracts definitions, references (calls, `extends`, `implements`, type usage — Spring-style DI included), and imports.
2. **Store** — SQLite (WAL), keyed by content hash; removing a file cascades; an extractor-version stamp auto-invalidates stale parses.
3. **Link** — references resolve to definitions across the repo, producing the edge table.
4. **Update** — git hooks (`post-commit`, `post-merge`, `post-checkout`) re-parse only changed files. Existing hooks are appended to, never clobbered.
5. **Serve** — structural queries straight from SQLite; ranking fuses lexical match with PageRank centrality.

## Comparison, honestly

If you want 30-language editor-session indexing with a bundled binary and file watchers, [CodeGraph](https://github.com/colbymchenry/codegraph) is excellent and more mature. `gitatlas` is for the git-shaped half of the problem: a commit-pinned graph that CI, cloud agents, and whole teams can share, with token cost as a first-class metric. Small repo, small tool, deliberately boring internals.

## Limitations (honest ones)

- **Name-based linking.** References resolve by identifier name, not full type resolution — same-named symbols each receive edges. SCIP-precision resolution is the top roadmap item.
- Dynamic dispatch, reflection, and metaprogramming are invisible, as in every static index.
- `who_calls` on an interface returns implementors and users together (edge kinds are stored but not yet filterable).

## Roadmap

- [x] PR blast-radius GitHub Action (impact analysis as a sticky PR comment)
- [ ] Graph-by-SHA caching in CI: build once, distribute to the team
- [ ] SCIP/LSP-based precise symbol resolution
- [ ] Graph time-travel: query the graph at any commit; semantic changelogs
- [ ] Embedding fusion for true-synonym queries (paraphrases already work via subtokens)
- [ ] More languages (Go, Rust, C#, Ruby)

## Contributing

Issues and PRs welcome. `src/indexer/` (tree-sitter extraction), `src/graph/` (SQLite store, ranking, formatting), `src/mcp/` (server), `src/cli.ts`. `npm run build` then `node dist/cli.js index --root <some-repo>` is the whole dev loop.

## License

MIT

<!-- test: docs-only change should skip the action -->
