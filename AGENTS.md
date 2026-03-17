# Repository Guidelines

## Project Structure & Module Organization
This monorepo uses `pnpm` workspaces and Turborepo. Product code lives in `apps/*` and reusable packages live in `packages/*`.

- `apps/web`: Next.js 16 app, UI components, App Router pages, API routes, Vitest tests in `src/__tests__`, Playwright tests in `tests/e2e`
- `packages/core`: graph, rollup, and query engine
- `packages/inference`: relation/domain inference pipelines
- `packages/db`, `packages/shared`, `packages/ui`, `packages/cli`: schema, shared utilities, UI exports, and CLI
- `docs`: versioned design, spec, roadmap, and verification docs
- `local-only-docs`: local-only plans and gap analysis; never commit these files

## Build, Test, and Development Commands
Use Node `>=22` and `pnpm >=10`.

- `pnpm install`: install workspace dependencies
- `pnpm dev`: start the web app through Turbo
- `pnpm build`: build all packages and the web app
- `pnpm lint`: run package lint/type checks
- `pnpm test`: run the workspace test pipeline
- `pnpm test:coverage`: run per-package coverage checks
- `pnpm test:e2e`: run Playwright end-to-end tests
- `pnpm db:migrate` / `pnpm db:studio`: manage the Drizzle database workflow

## Coding Style & Naming Conventions
TypeScript is the default across apps and packages. Prettier enforces `tabWidth: 2`, semicolons, single quotes, trailing commas, and `printWidth: 100`; run `pnpm format` before large reviews. `apps/web` uses the Next.js ESLint config.

Use `PascalCase` for React components, `camelCase` for functions and variables, and descriptive kebab-case for docs such as `docs/spec/29-approval-mapping-ui-consistency-spec.md`. Keep modules small and colocate tests with the owning package.

## Testing Guidelines
Develop new features with SDD and TDD. Vitest covers unit tests, and Playwright covers UI flows. Name tests `*.test.ts`, `*.test.tsx`, or `*.spec.ts`. Coverage targets are 80% for lines, functions, branches, statements, and per-file thresholds; do not merge code that drops below that bar.

## Commit & Pull Request Guidelines
Create a feature branch before starting work, even for documentation updates. Recent history mixes concise imperative subjects and optional prefixes, for example `docs: align P2 status with implementation` and `Fix bearer token parsing to be case-insensitive`. Keep commits focused and scoped to one change.

PRs should explain the problem, summarize the solution, link the relevant issue or SPEC, and include verification steps. Add screenshots or screen recordings for UI changes, and update `docs` when behavior or architecture changes.

## Documentation & Agent Notes
Check existing plans in `local-only-docs/plans` before starting. Write new planning or gap-analysis notes only under `local-only-docs`, and keep repository-facing guidance in `docs`.
