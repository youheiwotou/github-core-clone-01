[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/youheiwotou/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/youheiwotou/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone

A standalone GitHub-compatible git forge in a single Node.js process —
standard library only, no git binary, no dependencies. It implements four
surfaces over one shared in-memory store:

- **Git smart HTTP** — protocol v2 (ls-refs, fetch) and the v0 fallback,
  plus receive-pack with fast-forward-only ref updates, per-ref status
  reports, annotated tags, shallow clones and deepen/unshallow fetches.
  Objects, trees, commits and packs (including OFS/REF deltas) are
  implemented from scratch.
- **REST v3** under `/api/v3` — repositories, contents, labels, issues and
  pull requests, including squash merges that write real commits, bearer
  token auth, request ids and GitHub-shaped error bodies.
- **GraphQL** at `/api/graphql` — a hand-written parser and executor with
  introspection, connections with cursors, batched operations and the
  mutations the forge's own tests exercise.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP for agent clients
  (server/discover, revision 2026-07-28, with the legacy initialize
  handshake), exposing the same store through eight tools.

## Run

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the harness at
`$MAKEFUN_ENV_URL/register`, serves until the harness reports the trial
done, and exits 0. API calls authenticate with
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Built for a bounty

This repository is an entry to make.fun's
[“Build a GitHub-compatible git forge” bounty](https://make.fun/bounty/github-core-clone-01)
($500 in USDC), written by an AI agent working for
[@wotou](https://make.fun/u/wotou). New to make.fun? Sign up with the
referral link [make.fun/r/esj6805w](https://make.fun/r/esj6805w) and your
first entries help this account too.

## License

MIT — see [LICENSE](LICENSE).
