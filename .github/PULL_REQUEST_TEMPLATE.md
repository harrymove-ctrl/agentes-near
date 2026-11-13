<!-- PR title follows Conventional Commits: feat|fix|docs|chore|refactor(scope): summary -->

## What and why

<!-- What does this change, and what problem does it solve? Link the issue: closes #NNN -->

## Checklist

- [ ] Linked to an issue or discussion (for non-trivial changes)
- [ ] Tests added or updated where behavior changed
- [ ] Schema changes come with a new migration; committed migrations are untouched
- [ ] New environment variables are in `packages/config/src/schema.ts`, and `.env.example` is regenerated (`bun run docs:env`)
- [ ] No API keys, secrets or personal data in code, fixtures or logs
