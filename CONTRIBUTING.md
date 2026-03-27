# Contributing to DeepLore Enhanced

## Development Setup

1. Clone the repo into your SillyTavern `extensions/third-party/` directory
2. Run tests: `npm test` (unit), `npm run test:integration`, or `npm run test:all`
3. Verify imports after moving files: `npm run test:imports`

## Branch Strategy

- **`main`** — stable releases
- **`staging`** — active development (PRs target here)

## The `core/` Subtree

`core/` is shared with the base DeepLore extension via git subtree. Changes to `core/` files must be compatible with both repositories. Do not restructure `core/` without coordinating with the base repo.

## Running Tests

Tests run in Node.js with no dependencies — just `node test/unit.mjs`. The test harness mocks SillyTavern globals (jQuery, toastr, etc.) so pure logic can be tested outside the browser.

## Code Style

- ES modules (`import`/`export`), no bundler
- 4-space indentation, LF line endings
- No TypeScript — use JSDoc annotations for type hints
- Prefer editing existing files over creating new ones
