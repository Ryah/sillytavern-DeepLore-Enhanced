# Contributing to DeepLore Enhanced

## Development Setup

1. Clone the repo into your SillyTavern `data/default-user/extensions/` directory
2. Run tests: `npm test` (unit), `npm run test:integration`, or `npm run test:all`
3. Verify imports after moving files: `npm run test:imports`
4. Lint: `npm run lint`

## Branch Strategy

- **`main`** — stable releases
- **`staging`** — active development (PRs target here)

## The `core/` Directory

`core/` contains shared utility modules (parsing, matching, formatting). It was historically shared with a base DeepLore extension via git subtree, but that project is deprecated. `core/` is now owned entirely by Enhanced.

## Running Tests

Tests run in Node.js with no dependencies — just `node test/unit.mjs`. The test harness mocks SillyTavern globals (jQuery, toastr, etc.) so pure logic can be tested outside the browser.

## Tests

New code should include tests. Add unit tests in `test/unit.mjs` for any new pure functions or logic changes. All tests must pass before submitting a PR.

## Source Directory Structure

The `src/` directory is organized by feature area:

- `pipeline/` — vault file parsing and entry indexing
- `drawer/` — drawer UI panel and entry browser
- `graph/` — relationship graph visualization
- `librarian/` — Librarian AI assistant (Emma) and tool definitions
- `diagnostics/` — health check and debug utilities
- `vault/` — Obsidian vault connection and sync
- `ai/` — AI search, scribe, auto-suggest
- `ui/` — shared UI components and settings panels

## Code Style

- ES modules (`import`/`export`), no bundler
- 4-space indentation, LF line endings
- No TypeScript — use JSDoc annotations for type hints
- Prefer editing existing files over creating new ones
