# Contributing to Utopia

[中文](CONTRIBUTING.zh-CN.md)

Welcome. This file covers what is specific to this repository. It assumes you already know general open-source etiquette.

## Branches and how changes land

| Branch | What it is |
|---|---|
| `main` | Stable. Matches the released version. Only maintainers merge into it, from `dev`. |
| `dev` | The integration branch. Every contribution lands here first. |

Your path as a contributor:

```bash
git switch dev && git pull
git switch -c fix/some-thing        # branch off dev, not main
# make changes, commit with -s (see DCO below)
git push -u origin fix/some-thing
```

Open a pull request with **base `dev`, not `main`**. A maintainer merges it once CI and review pass.

Maintainers merge `dev` into `main` on their own schedule. Contributors do not need to think about this. Two rules keep the branches from drifting apart. Both apply to maintainers only:

- **Back-merge `main` into `dev` right after a release.** The `dev → main` merge commit lives only on `main`. Without this back-merge, `main` looks ahead of `dev` even though the trees match, and the gap grows with every release.
- **Send urgent fixes through `dev` too.** A pull request opened straight against `main` is the one thing that makes the two branches genuinely diverge. Someone then has to reconcile them by hand.

Both branches are protected. A pull request is required. CI (the `backend` and `web` jobs) must pass. Force pushes and branch deletion are blocked. Admins follow the same rules.

## Open an issue first, or go straight to a pull request

| Change | What to do |
|---|---|
| Bug fixes, docs, i18n strings, tests | Open a pull request directly |
| New features, dependency changes | Open an [issue](https://github.com/deeplethe/utopia/issues) first and describe the use case |
| Data model, ontology contract, public API | Discuss it in an issue, then write an [ADR](docs/decisions/) before you write code |

`docs/decisions/` holds this project's reasoning. An ADR (architecture decision record) states **why we chose this and not that**, including approaches we tried and rejected. For a change of any size, this document outlives the code.

## Local setup

Requirements: Docker, Bun 1.1+.

```bash
docker compose up -d db                       # Postgres with pgvector
cd server && bun run src/index.ts             # runs migrations, listens on :1516
cd web && bun install && bun run dev          # listens on :5173, proxies /api to the backend
```

## Before you push

CI runs exactly these checks. If they pass locally, they pass in CI:

```bash
bun test
bun run typecheck
cd web && bun install && bun run build   # build also runs the type checker
```

### A database-backed test skips without the right environment variable

This is the easiest mistake to make here. A green test run does not mean every test ran. Some tests start like this:

```typescript
const url = process.env.UTOPIA_DATABASE_URL;
if (!url) {
  console.warn("skipping: UTOPIA_DATABASE_URL not set");
  return;
}
```

These tests check what a type checker cannot see. Examples include a table alias inside a SQL string, how `NULL` behaves in a comparison, a row an `INNER JOIN` silently drops, and whether a recursive query visits the same ancestor twice under diamond inheritance. Type checking and linting say nothing about any of this.

If you changed SQL under `server/src/store/`, set the variable and run the tests again:

```bash
export UTOPIA_DATABASE_URL=postgres://utopia:utopia@localhost:5432/utopia
bun test
```

## Things review will send back

**Do not collide on migration numbers.** Files under `migrations/` apply in numeric order. Check the latest number on `main` before you open a pull request. Two branches have each added an `0011_` file before, and after the merge, neither one ran.

**Put UI strings in i18n.** Add each string to both `web/src/i18n/en.ts` and `zh.ts`. Do not hard-code strings inside components.

**Write comments that explain why.** This repository comments densely and records traps it fell into on purpose. For example: "the first version used OR, and one large document then produced a snapshot every 6KB." Follow this pattern. A comment that only restates what the code does will come back in review.

**Write one commit message per commit, in English, stating the motivation.** Keep it to one sentence, with no long body. Skim `git log` to see the style we use.

**Give every workflow its own `permissions:` block.** The repository default is read-and-write, because one workflow commits a generated chart. A workflow with no `permissions:` block inherits that default and silently gets write access it does not need. Declare only what the job actually needs. Use `contents: read` for a job that only builds or tests.

## DCO: sign off every commit

We use the [DCO](https://developercertificate.org/), not a CLA. You keep the copyright on your code. You certify that you have the right to submit it under Apache-2.0.

Commit with `-s` and git adds the line for you:

```bash
git commit -s -m "Fix the thing"
```

This appends:

```
Signed-off-by: Your Name <your@email>
```

Forgot to sign off? Run `git commit --amend -s` for the last commit, or `git rebase --signoff HEAD~3` for several commits (adjust the count). Then run `git push -f`.

Use a real name and a reachable email address.

## License

By contributing, you agree that your work is released under [Apache-2.0](LICENSE).
