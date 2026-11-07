# Contributing to ChatGPT Gateway

Thanks for your interest! The project is at an early stage, so please open an issue to discuss a
change before starting significant work.

## Setup

Node 26 (LTS) runs the TypeScript sources directly; there is no build step.

```sh
npm ci
```

## Checks

All of these run in CI and must pass:

```sh
npm run lint        # Biome: lint and formatting (npm run format fixes what it can)
npm run typecheck   # tsc, type check only
npm test            # node:test
```

Tests run without a network and without a ChatGPT account: OpenAI's endpoints are replaced by
local fake servers.

## Conventions

- Code, identifiers, comments and repository docs are in English; the app page and its options
  are translated to Russian too (`addon/translations/`).
- Only erasable TypeScript syntax (no enums, no parameter properties): Node strips the types.
- Keep dependencies few and pinned by `package-lock.json`.
- Never log, print or commit tokens, API keys or what users ask.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`,
  `fix: ...`, `docs: ...`, `chore: ...`, `ci: ...`.

## License of contributions

By submitting a contribution you agree that it is licensed under the
[Apache License 2.0](LICENSE), the same license as the project (inbound = outbound).
