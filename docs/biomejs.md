# Biome.js for Eigen

## Short answer

Yes, **Biome is a good fit for this repository**, and I think it would add clear value.

For Eigen specifically, I would recommend:

- using **Biome as the primary formatter + linter + import organizer**
- enabling **CSS parsing for Tailwind v4 directives**
- **not relying on Biome as the only Tailwind class sorter at first**
- using **one root config** initially, with only a few targeted overrides
- integrating it into **editor save actions**, **pre-commit hooks**, and **CI**

The most important caveat is this:

- **Biome is very strong as a fast unified toolchain**
- **Biome is not yet as customizable as ESLint + plugins for deep project-specific architecture rules**
- **Biome’s Tailwind class sorting exists, but it is still incomplete compared with `prettier-plugin-tailwindcss`**

So the practical conclusion is:

- **Biome is worth adopting here**
- but it should be adopted for the value it already gives today, not for an idealized “it can replace every custom lint rule we may ever want” story

## Why this repo is a good candidate

Eigen is actually a strong Biome candidate because of the current state of the repo:

- **[No existing formatter/linter stack]**
  There is currently no ESLint, Prettier, Biome, or hook setup to migrate from. That makes adoption much simpler.

- **[Bun monorepo]**
  The repo already uses Bun workspaces from the root `package.json`, and Biome works fine in monorepos.

- **[Mostly TypeScript/TSX/JSON/CSS]**
  That is the exact kind of codebase Biome is best at.

- **[Shared UI with Tailwind + shadcn]**
  The repo uses Tailwind v4 and shadcn conventions in `packages/ui`, which Biome can support reasonably well, with one important limitation around class sorting.

- **[Generated files exist]**
  The repo contains generated route files like `apps/*/src/routeTree.gen.ts`. Biome v2’s ignore model is good enough to handle these cleanly.

## What I found in the repo

Relevant repo details:

- **[Monorepo root]** `package.json` defines Bun workspaces for `packages/*` and `apps/*`
- **[Tailwind v4]** via `@tailwindcss/vite` and `@tailwindcss/postcss`
- **[shadcn]** present in `packages/ui/components.json`
- **[Tailwind CSS source]** `packages/ui/src/styles/globals.css` uses Tailwind v4 directives like `@theme` and `@apply`
- **[No `.editorconfig`]** found
- **[No existing hooks]** found for Husky, lint-staged, Lefthook, or similar
- **[Generated files]** `routeTree.gen.ts` exists across multiple apps

This matters because it means Biome would not be fighting an existing lint/format stack, but it does need to be configured for:

- monorepo root usage
- Tailwind v4 CSS parsing
- generated-file exclusions
- editor + hook workflow

## What Biome would give the project

## 1. One tool for the common quality loop

Biome can cover the main day-to-day workflow in one tool:

- **[Formatting]** TS, TSX, JS, JSON, CSS
- **[Linting]** modern built-in JS/TS/React-style rules
- **[Import organization]** built in
- **[Editor integration]** official VS Code extension
- **[Fast execution]** much faster than traditional ESLint + Prettier stacks in many repos

That is especially valuable in a repo like Eigen, where there are many apps and shared packages and where consistent code shape matters a lot.

## 2. Better baseline enforcement than the repo has today

Right now Eigen has written conventions, but not much automated enforcement.

Biome would immediately improve that by giving you:

- a single formatting standard
- lint diagnostics in editors and CI
- consistent import organization
- a standard pre-commit experience
- less style drift across apps/packages

Even without custom rules, this is already a large upgrade from the current state.

## 3. Good monorepo support

Biome v2 added proper monorepo support, including:

- **[Root config]** one `biome.json` / `biome.jsonc` at repo root
- **[Nested configs]** optional per-package configs when needed
- **[Root extension syntax]** nested configs can use `"extends": "//"`
- **[Package-aware behavior]** rules that consult `package.json` operate against the right package

For Eigen, I would start with **one root config only**. The repo does not look like it needs per-package variation yet.

## Tailwind and shadcn compatibility

## Tailwind v4 CSS support

This part is good news.

Biome v2.3 added support for parsing Tailwind v4 CSS directives when you enable:

- `css.parser.tailwindDirectives: true`

That matters for Eigen because `packages/ui/src/styles/globals.css` already uses:

- `@theme`
- `@apply`

So if you adopt Biome here, **you should enable Tailwind directive parsing from day one**.

I would also enable CSS formatting, because this repo has important shared CSS and design-token files.

## Tailwind class sorting

This is the main limitation.

Biome has a rule called `useSortedClasses`, which is meant to do the same kind of work as `prettier-plugin-tailwindcss`, but it is **not equivalent yet**.

Important limitations from the official Biome docs:

- **[Still a work in progress]**
- **[Implemented as a linter rule, not formatter behavior]**
- **[Fix is currently unsafe]**
- **[Not applied automatically on save by default]**
- **[Does not execute `tailwind.config.js`]**
- **[Does not fully support custom utilities/variants/plugins]**
- **[Does not support some screen variant sorting]**
- **[Does not support object properties in `clsx`]**

That means Biome is **not yet a drop-in replacement** for Tailwind’s Prettier plugin if exact Tailwind class ordering is a hard requirement.

## What that means for Eigen

For Eigen specifically, this limitation is real, but not fatal.

Reasons:

- **[Tailwind v4 style]** this repo is not depending on a big JavaScript `tailwind.config.js` story
- **[shadcn defaults]** shadcn components mostly use standard Tailwind utility strings and `cn()`-style composition
- **[User preference]** you said you are okay with some defaults being less tweakable if the tool adds value

So I would treat Tailwind class sorting like this:

- **Use Biome for everything else immediately**
- **Do not make class sorting a blocker for adoption**
- optionally test `useSortedClasses` later in a smaller scope
- if exact Tailwind ordering becomes very important, reconsider whether to keep a tiny Prettier-only Tailwind step for that one concern

## My recommendation for Tailwind/shadcn

### Recommended default

- **[Adopt Biome]** yes
- **[Enable Tailwind CSS directive parsing]** yes
- **[Enable CSS formatting]** yes
- **[Enable Tailwind class sorting rule globally]** no, not initially

### Why

Because this gets you most of the value with very little risk.

### Optional later step

If you want to experiment, enable `useSortedClasses` as:

- informational first
- then maybe warning/error in selected folders
- but **not** as an always-on unsafe fix in pre-commit on day one

## What Biome cannot fully replace here

This is the most important strategic limitation.

Biome is great for general linting and formatting, but Eigen also has some **project-specific architectural rules**, for example:

- `packages/lib` should not depend on UI concerns
- apps should not directly use raw `useQuery` / `useMutation`
- certain import directions should be forbidden
- `type` is preferred over `interface`

Biome can help with some of this, but today it is **not as strong as ESLint’s mature plugin ecosystem for highly custom architectural enforcement**.

Important official caveat:

- Biome has a plugin system in v2, but it is still limited in scope
- it is not yet equivalent to the broader ESLint plugin ecosystem

So if Eigen eventually wants very deep architecture policing, you have two realistic options:

- **[Option A]** accept Biome as the main tool and keep some architecture rules social/manual for now
- **[Option B]** use Biome for formatting/general linting and add a second enforcement layer later for custom boundaries

For the current repo, I think **Option A is perfectly reasonable to start with**.

## Recommended setup for Eigen

## Version choice

Use **Biome v2.3+**, not v1.

Reason:

- better monorepo support
- nested config support
- Tailwind v4 CSS directive support
- newer ignore behavior

## Installation

At the repo root:

```bash
bun add -d -E @biomejs/biome
```

## Root config

I would use a single root `biome.jsonc` first.

Suggested starting point:

```json
{
    "$schema": "https://biomejs.dev/schemas/2.3.11/schema.json",
    "vcs": {
        "enabled": true,
        "clientKind": "git",
        "useIgnoreFile": true,
        "defaultBranch": "main"
    },
    "files": {
        "includes": [
            "**",
            "!**/routeTree.gen.ts",
            "!!dist/**",
            "!!coverage/**"
        ]
    },
    "formatter": {
        "enabled": true,
        "indentStyle": "space",
        "indentWidth": 4,
        "lineEnding": "lf",
        "lineWidth": 120
    },
    "linter": {
        "enabled": true,
        "rules": {
            "recommended": true
        }
    },
    "css": {
        "parser": {
            "tailwindDirectives": true
        },
        "formatter": {
            "enabled": true
        }
    },
    "javascript": {
        "formatter": {
            "quoteStyle": "single",
            "jsxQuoteStyle": "double"
        }
    },
    "json": {
        "formatter": {
            "indentWidth": 2
        }
    }
}
```

## Why this config

- **[Use Git ignore files]** so Biome respects repo ignores naturally
- **[Ignore generated route trees with `!`]** so they are not linted/formatted, but are still visible to type-aware analysis if needed
- **[Ignore build output with `!!`]** so dist/coverage are not indexed at all
- **[Use spaces]** because the repo already appears to be space-indented
- **[Use 4-space code indentation]** because that matches most current TS/TSX source better than Biome’s default tabs
- **[Use 2-space JSON indentation]** because your JSON files already look like that
- **[Enable Tailwind v4 CSS parsing]** because the repo actively uses it

## Notes about the schema version

You can pin the schema URL to the Biome version you install. The exact patch number is not important for the plan, but you should keep the schema and package version aligned.

## Optional overrides later

You may later want overrides or nested configs for:

- generated code
- vendored code
- third-party-derived packages like `packages/fortune-sheet` if you want a softer policy there
- app-specific exceptions

I would **not** start there. Start simple.

## Suggested package scripts

At the root `package.json`, I would add these scripts:

```json
{
    "scripts": {
        "lint": "biome lint .",
        "format": "biome format --write .",
        "biome:check": "biome check .",
        "biome:write": "biome check --write ."
    }
}
```

Possible integration with your existing scripts:

- keep `typecheck` as is
- keep `test` as is
- add a new combined quality command, for example:

```json
{
    "scripts": {
        "quality": "biome check . && bun run typecheck && bun run test"
    }
}
```

## Workflow integration

## Editor workflow

Use the official **Biome VS Code extension**.

Recommended settings:

```json
{
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
        "source.fixAll.biome": "explicit",
        "source.organizeImports.biome": "explicit"
    }
}
```

What this gives you:

- formatting on save
- safe fixes on save
- import organization on save

This is probably the highest-value part of the adoption, because it changes daily ergonomics immediately.

## Pre-commit hooks

Because there is no existing hook manager in this repo, I would choose **Lefthook** if you want hooks.

Why Lefthook:

- fast
- cross-platform
- works well in monorepos
- officially documented by Biome
- cleaner staged-file handling than a naive custom script

Recommended pre-commit behavior:

- run **format + lint + safe fixes** on staged supported files
- do **not** run unsafe Tailwind class sorting automatically at first

Example direction:

```yaml
pre-commit:
  commands:
    biome:
      run: bunx --bun @biomejs/biome check --write --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}
      stage_fixed: true
```

If you prefer Husky/lint-staged, that also works, but Lefthook is the cleaner default for a repo that currently has no hook system.

## Pre-push or CI

I would use Biome in both places:

- **[Pre-push]** optional fast local gate
- **[CI]** required project gate

Recommended CI order:

1. `biome check .`
2. `bun run typecheck`
3. `bun run test`

That keeps style/lint failures fast and cheap, while preserving your current type/test discipline.

## What value it would add

## Clear value

I think Biome would add real value here in five ways:

- **[Consistency]** much more uniform code formatting across many apps/packages
- **[Speed]** faster local checks than a traditional ESLint + Prettier stack
- **[Simplicity]** one tool instead of building a lint/format toolchain from scratch
- **[Workflow quality]** better save-time fixing and import organization
- **[Baseline enforcement]** written conventions become at least partially executable

For Eigen, this is meaningful because the repo is already large enough that “we just remember the rules” is no longer enough.

## Consequences and tradeoffs

## Positive consequences

- fewer style debates
- easier onboarding
- faster review of code shape issues
- cleaner diffs over time
- easier future CI standardization

## Negative consequences

- **[Initial churn]** first formatting pass will touch many files
- **[Opinionated defaults]** Biome is less infinitely configurable than ESLint + Prettier
- **[Tailwind sorting gap]** not full parity with the Tailwind Prettier plugin yet
- **[Custom architecture lint gap]** deep project-specific rules are harder than in ESLint today

## How I would adopt it in practice

## Recommended rollout

### Phase 1

- install Biome
- add root config
- add scripts
- enable editor extension locally
- run `biome check .` and inspect the result

### Phase 2

- enable format-on-save for the team
- add pre-commit hook with safe fixes only
- add CI job for `biome check .`

### Phase 3

- review whether any noisy rules should be tuned
- decide whether `useSortedClasses` is worth piloting
- decide whether any nested configs or overrides are necessary

## Final recommendation

My recommendation is:

- **Adopt Biome**
- **Use it as the main formatter/linter/import organizer**
- **Enable Tailwind v4 CSS parsing and CSS formatting**
- **Do not block adoption on Tailwind class sorting parity**
- **Use Lefthook or a similar staged-file hook for pre-commit**
- **Run Biome in CI before typecheck and test**

If you want a very concise verdict:

- **Is it possible?** Yes.
- **Is it a good fit?** Yes.
- **Should it fully replace every possible custom lint rule?** Not necessarily.
- **Should Eigen adopt it anyway?** Yes, I think so.

## Sources used

Primary sources used for this research:

- Biome configuration reference
- Biome migration guide from ESLint/Prettier
- Biome big-project/monorepo guide
- Biome `useSortedClasses` rule docs
- Biome git hooks docs
- Biome v2 and v2.3 release notes
- Biome VS Code extension docs
