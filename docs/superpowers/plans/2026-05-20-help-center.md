# Help Center Implementation Plan

> **EXECUTION STATUS — paused 2026-05-20 for cross-machine handoff.**
> Phase 1 is complete: Tasks 1.1–1.13 plus an extra prerender rework — the prerender now
> renders through Vite SSR (`ssrLoadModule`) because the plan's original `bun run` prerender
> could not execute Vite-only app code. Phase 2 is in progress: Tasks 2.1–2.5 are implemented
> and committed; **Task 2.5's review is still pending.** Resume by reviewing Task 2.5, then
> executing Tasks 2.6–2.11, then Phase 3 (3.1–3.2) and Phase 4 (4.1–4.2). Every plan task maps
> to one git commit — `git log --oneline` shows exactly what is done. This plan was corrected
> in-flight (article styling via the shared `eigen-prose` stylesheet, task-ordering fixes, the
> Vite-SSR prerender rework, concurrency-scoped verification steps) — follow it as written.
> While this ran, a separate process was performing an unrelated zod v3→v4 upgrade, with
> uncommitted edits to root `package.json`, `bun.lock`, `apps/calendar`, `apps/contacts`, and
> `packages/ui` form files — leave those alone; they are not part of this work. Follow-up:
> after Task 2.10 registers the `/support` route, switch `support-header.tsx`'s logo link from
> `<a href="/support">` back to `<Link to="/support">`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public, build-time-rendered help center at `/support` inside `apps/index`, sharing one Markdown→HTML pipeline with the blog.

**Architecture:** A build-time content pipeline (`scripts/build-content.ts`) parses Markdown + YAML frontmatter, validates it with Zod, renders HTML with `markdown-it`, and emits per-collection manifests + per-article HTML JSON into a gitignored `.generated/` folder. A prerender pass (`scripts/prerender.ts`) renders every index-app route to full static HTML; the client `hydrateRoot`s it. Help pages reuse the apps' `ColumnLayout` / `Column` / `Breadcrumb` via a lightweight public shell that provides `LayoutContext`. Search is client-side via Pagefind over the built HTML.

**Tech Stack:** Bun, Vite (Rolldown), React 19, TanStack Router (file-based), `gray-matter`, `markdown-it`, `markdown-it-anchor`, Zod, Pagefind, Tailwind 4, `@workspace/ui`.

**Reference docs:** `docs/PROPOSAL_HELP_CENTER.md` (the spec), `AGENTS.md`, `docs/CODE-STANDARDS.md`.

---

## Conventions for the engineer

- All paths are relative to the repo root `C:\git\eigen` unless absolute.
- Run all `bun` commands from the repo root unless a step says `cd apps/index`.
- The project's pre-commit hook runs Biome; commit messages end with the `Co-Authored-By` trailer used elsewhere in this repo's history is **not** required for these commits — use plain conventional-commit messages.
- After each task, the listed commit is the checkpoint. Commit only the files that task created/modified.
- Work happens on the existing `feat/help-center` branch.
- `bun test <file>` runs Bun's built-in test runner on one file. The content-build logic is pure and unit-tested; React components and build scripts are verified via `bun run typecheck`, `bun run build`, and manual checks — `apps/index` has no React-component test harness and this plan does not add one.

## File structure

**New — build pipeline (`apps/index/scripts/`):**
- `scripts/lib/content-types.ts` — Zod frontmatter schemas + derived TS types, collection config.
- `scripts/lib/frontmatter.ts` — parse + validate one Markdown file.
- `scripts/lib/render-markdown.ts` — `markdown-it` render + heading/TOC extraction.
- `scripts/lib/related.ts` — related-article resolution (explicit + shared-tags fallback).
- `scripts/build-content.ts` — orchestrator; replaces `generate-blog-meta.ts`.
- `scripts/prerender.ts` — route prerender pass; replaces `post-build.ts`.
- `scripts/lib/*.test.ts` — unit tests for the pure functions above.

**New — app content layer (`apps/index/src/content/`):**
- `src/content/manifest.ts` — loads the generated manifests + per-article HTML; typed accessors.

**New — help center UI (`apps/index/src/components/support/`):**
- `support-shell.tsx`, `support-header.tsx`, `support-landing.tsx`, `support-section.tsx`, `support-article.tsx`, `support-breadcrumb.tsx`, `article-toc.tsx`, `support-search.tsx`, `sections.ts`.
- `src/components/ArticleContent.tsx` — renders built HTML + `<media-grid>` islands (shared by blog + support).

**New — routes (`apps/index/src/routes/`):**
- `support.index.tsx`, `support.$section.tsx`, `support.$section.$article.tsx`.

**New — content + docs:**
- `apps/index/src/data/support/<section>/*.md`, `apps/index/public/data/support/media/**`.
- `docs/HELP_AUTHORING.md` — authoring guide.

**Modified:**
- `apps/index/package.json` — deps + `test` script; `prebuild`/`postbuild` point to the new scripts.
- `apps/index/src/data/blog-posts.ts` — re-implemented over the manifest.
- `apps/index/src/components/BlogPost.tsx` — renders built HTML via `ArticleContent`.
- `apps/index/src/routes/blog.index.tsx`, `blog.$id.tsx` — consume the new loader.
- `apps/index/src/main.tsx` — `hydrateRoot` when prerendered content is present.
- `apps/index/src/data/blog/*.md` — `summary:` frontmatter key renamed to `description:`.
- `packages/lib/src/core/media/hooks/use-media-query.ts` — `useSyncExternalStore`.
- `packages/lib/src/core/api.ts` — `getSupportUrl`, `getHelpUrl`.
- `packages/ui/src/components/layout/app/topbar.tsx` — "Help" menu item.
- `.gitignore` — ignore `apps/index/src/content/.generated/`.

**Deleted:** `apps/index/scripts/generate-blog-meta.ts`, `apps/index/scripts/post-build.ts` (replaced).

---

# Phase 1 — Shared content pipeline + blog migration

Phase 1 delivers the build-time Markdown→HTML pipeline, migrates the blog onto it, makes the index app prerender to static HTML, and fixes `useMediaQuery` for prerendering. At the end of Phase 1 the blog works exactly as before for users, but its post bodies are real static HTML.

### Task 1.1: Install dependencies and add a test script

**Files:**
- Modify: `apps/index/package.json`

- [ ] **Step 1: Install the build-pipeline dependencies**

Run:
```bash
cd apps/index && bun add gray-matter markdown-it markdown-it-anchor zod && bun add -d @types/markdown-it
```

- [ ] **Step 2: Add a `test` script to `apps/index/package.json`**

In the `"scripts"` block, add a `test` entry so it reads:
```json
  "scripts": {
    "dev": "bunx --bun vite",
    "build": "bunx --bun vite build",
    "prebuild": "bun run scripts/build-content.ts",
    "postbuild": "bun run scripts/prerender.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
```

Note this also repoints `prebuild` → `build-content.ts` and `postbuild` → `prerender.ts` (those files are created in Tasks 1.6 and 1.11; the build is not run until Task 1.13).

- [ ] **Step 3: Verify the dependencies installed**

Run: `cd apps/index && bun pm ls | grep -E "markdown-it|gray-matter"`
Expected: lists `gray-matter`, `markdown-it`, `markdown-it-anchor`.

- [ ] **Step 4: Commit**

```bash
git add apps/index/package.json bun.lock
git commit -m "build(index): add markdown pipeline deps and test script"
```

### Task 1.2: Content types and Zod schemas

**Files:**
- Create: `apps/index/scripts/lib/content-types.ts`

- [ ] **Step 1: Export the media types, then write the schemas**

First, in `apps/index/src/components/parse-media-grids.ts`, export the two media types so the
content pipeline reuses them instead of redefining them: change `type MediaItem` to
`export type MediaItem` and `type MediaGridData` to `export type MediaGridData`.

Then create `apps/index/scripts/lib/content-types.ts`:
```typescript
import { z } from 'zod';
import type { MediaGridData } from '../../src/components/parse-media-grids';

// A heading in an article, used to build the on-this-page table of contents.
export type TocEntry = { id: string; text: string; level: 2 | 3 };

// Support article frontmatter — validated at build time.
export const supportFrontmatterSchema = z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    type: z.enum(['overview', 'how-to', 'troubleshooting', 'faq', 'reference']),
    category: z.string().min(1).optional(),
    tags: z.array(z.string()).default([]),
    related: z.array(z.string()).default([]),
    order: z.number().default(100),
    updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'updated must be YYYY-MM-DD').optional(),
    draft: z.boolean().default(false),
});
export type SupportFrontmatter = z.infer<typeof supportFrontmatterSchema>;

// Blog post frontmatter — the blog keeps id-as-slug; date comes from the filename.
export const blogFrontmatterSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
});
export type BlogFrontmatter = z.infer<typeof blogFrontmatterSchema>;

// One article in a generated manifest (metadata only, no body).
export type ArticleMeta = {
    slug: string; // support: "<section>/<file>"; blog: the frontmatter id
    section: string; // support: the folder; blog: "blog"
    title: string;
    description: string;
    type?: SupportFrontmatter['type'];
    category?: string;
    tags: string[];
    order: number;
    updated?: string;
    date?: string; // blog only — YYYY-MM-DD from the filename
    toc: TocEntry[];
    related: string[]; // resolved slugs
};

export type ContentManifest = { articles: ArticleMeta[] };

// The per-article generated body file.
export type ArticleBody = { html: string; mediaGrids: MediaGridData[] };
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd apps/index && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/index/scripts/lib/content-types.ts apps/index/src/components/parse-media-grids.ts
git commit -m "feat(index): add content pipeline types and frontmatter schemas"
```

### Task 1.3: Frontmatter parsing and validation

**Files:**
- Create: `apps/index/scripts/lib/frontmatter.ts`
- Test: `apps/index/scripts/lib/frontmatter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/index/scripts/lib/frontmatter.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import { supportFrontmatterSchema } from './content-types';
import { parseContentFile } from './frontmatter';

describe('parseContentFile', () => {
    test('parses valid frontmatter and returns the body', () => {
        const raw = ['---', 'title: Share a file', 'description: How to share.', 'type: how-to', 'tags: [sharing]', '---', '', '# Body'].join('\n');
        const result = parseContentFile(raw, supportFrontmatterSchema);
        expect(result.data.title).toBe('Share a file');
        expect(result.data.type).toBe('how-to');
        expect(result.data.tags).toEqual(['sharing']);
        expect(result.body.trim()).toBe('# Body');
    });

    test('applies schema defaults', () => {
        const raw = ['---', 'title: T', 'description: D', 'type: faq', '---', 'body'].join('\n');
        const result = parseContentFile(raw, supportFrontmatterSchema);
        expect(result.data.draft).toBe(false);
        expect(result.data.order).toBe(100);
        expect(result.data.tags).toEqual([]);
    });

    test('throws a readable error on a missing required field', () => {
        const raw = ['---', 'description: D', 'type: faq', '---', 'body'].join('\n');
        expect(() => parseContentFile(raw, supportFrontmatterSchema)).toThrow(/title/);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/index && bun test scripts/lib/frontmatter.test.ts`
Expected: FAIL — cannot resolve `./frontmatter`.

- [ ] **Step 3: Write the implementation**

Create `apps/index/scripts/lib/frontmatter.ts`:
```typescript
import matter from 'gray-matter';
import type { z } from 'zod';

// Parse a Markdown file's YAML frontmatter and validate it against `schema`.
// Throws with a readable message listing the offending fields if invalid.
export function parseContentFile<T extends z.ZodTypeAny>(
    raw: string,
    schema: T,
): { data: z.infer<T>; body: string } {
    const parsed = matter(raw);
    const result = schema.safeParse(parsed.data);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        throw new Error(`Invalid frontmatter: ${issues}`);
    }
    return { data: result.data, body: parsed.content };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/index && bun test scripts/lib/frontmatter.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/index/scripts/lib/frontmatter.ts apps/index/scripts/lib/frontmatter.test.ts
git commit -m "feat(index): add frontmatter parsing and validation"
```

### Task 1.4: Markdown rendering and TOC extraction

**Files:**
- Create: `apps/index/scripts/lib/render-markdown.ts`
- Test: `apps/index/scripts/lib/render-markdown.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/index/scripts/lib/render-markdown.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from './render-markdown';

describe('renderMarkdown', () => {
    test('renders Markdown to HTML', () => {
        const { html } = renderMarkdown('# Hi\n\nA **paragraph**.');
        expect(html).toContain('<h1');
        expect(html).toContain('<strong>paragraph</strong>');
    });

    test('extracts h2/h3 headings into the TOC with slug ids', () => {
        const { toc } = renderMarkdown('## Permission levels\n\ntext\n\n### Shared links');
        expect(toc).toEqual([
            { id: 'permission-levels', text: 'Permission levels', level: 2 },
            { id: 'shared-links', text: 'Shared links', level: 3 },
        ]);
    });

    test('headings in the HTML carry the matching id', () => {
        const { html } = renderMarkdown('## Permission levels');
        expect(html).toContain('id="permission-levels"');
    });

    test('h1 is not included in the TOC', () => {
        const { toc } = renderMarkdown('# Title\n\n## Section');
        expect(toc.map((t) => t.level)).toEqual([2]);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/index && bun test scripts/lib/render-markdown.test.ts`
Expected: FAIL — cannot resolve `./render-markdown`.

- [ ] **Step 3: Write the implementation**

Create `apps/index/scripts/lib/render-markdown.ts`:
```typescript
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import type { TocEntry } from './content-types';

// A GitHub-style slugifier so heading ids are stable and human-readable.
function slugify(text: string): string {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
}

// Render Markdown to HTML and collect the h2/h3 headings for the on-this-page TOC.
// `html: true` keeps trusted inline HTML in articles (content is authored in-repo).
export function renderMarkdown(markdown: string): { html: string; toc: TocEntry[] } {
    const toc: TocEntry[] = [];
    const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
    md.use(anchor, { slugify, level: [2, 3] });

    const tokens = md.parse(markdown, {});
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type !== 'heading_open') continue;
        const level = token.tag === 'h2' ? 2 : token.tag === 'h3' ? 3 : 0;
        if (level === 0) continue;
        const inline = tokens[i + 1];
        const text = inline?.content ?? '';
        toc.push({ id: slugify(text), text, level });
    }

    return { html: md.render(markdown), toc };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/index && bun test scripts/lib/render-markdown.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/index/scripts/lib/render-markdown.ts apps/index/scripts/lib/render-markdown.test.ts
git commit -m "feat(index): add markdown rendering and TOC extraction"
```

### Task 1.5: Related-article resolution

**Files:**
- Create: `apps/index/scripts/lib/related.ts`
- Test: `apps/index/scripts/lib/related.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/index/scripts/lib/related.test.ts`:
```typescript
import { describe, expect, test } from 'bun:test';
import type { ArticleMeta } from './content-types';
import { resolveRelated } from './related';

function meta(slug: string, section: string, tags: string[], related: string[] = []): ArticleMeta {
    return { slug, section, title: slug, description: '', tags, order: 100, toc: [], related };
}

describe('resolveRelated', () => {
    test('keeps explicit related slugs that exist', () => {
        const a = meta('drive/share', 'drive', [], ['drive/stop-sharing']);
        const all = [a, meta('drive/stop-sharing', 'drive', [])];
        expect(resolveRelated(a, all)).toEqual(['drive/stop-sharing']);
    });

    test('drops explicit related slugs that do not exist', () => {
        const a = meta('drive/share', 'drive', [], ['drive/ghost']);
        expect(resolveRelated(a, [a])).toEqual([]);
    });

    test('falls back to shared tags within the same section, ranked by overlap', () => {
        const a = meta('drive/share', 'drive', ['sharing', 'links']);
        const b = meta('drive/links', 'drive', ['sharing', 'links']);
        const c = meta('drive/upload', 'drive', ['sharing']);
        const d = meta('mail/share', 'mail', ['sharing', 'links']);
        const result = resolveRelated(a, [a, b, c, d]);
        expect(result).toEqual(['drive/links', 'drive/upload']);
    });

    test('returns at most 4 related articles', () => {
        const a = meta('drive/a', 'drive', ['t']);
        const others = ['b', 'c', 'd', 'e', 'f'].map((s) => meta(`drive/${s}`, 'drive', ['t']));
        expect(resolveRelated(a, [a, ...others]).length).toBe(4);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/index && bun test scripts/lib/related.test.ts`
Expected: FAIL — cannot resolve `./related`.

- [ ] **Step 3: Write the implementation**

Create `apps/index/scripts/lib/related.ts`:
```typescript
import type { ArticleMeta } from './content-types';

const MAX_RELATED = 4;

// Resolve an article's related list: explicit `related` slugs that exist, else
// the same-section articles with the most shared tags. Computed at build time.
export function resolveRelated(article: ArticleMeta, all: ArticleMeta[]): string[] {
    const bySlug = new Set(all.map((a) => a.slug));

    if (article.related.length > 0) {
        return article.related.filter((slug) => slug !== article.slug && bySlug.has(slug)).slice(0, MAX_RELATED);
    }

    const tags = new Set(article.tags);
    if (tags.size === 0) return [];

    return all
        .filter((a) => a.slug !== article.slug && a.section === article.section)
        .map((a) => ({ slug: a.slug, overlap: a.tags.filter((t) => tags.has(t)).length, order: a.order }))
        .filter((a) => a.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap || a.order - b.order || a.slug.localeCompare(b.slug))
        .slice(0, MAX_RELATED)
        .map((a) => a.slug);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/index && bun test scripts/lib/related.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/index/scripts/lib/related.ts apps/index/scripts/lib/related.test.ts
git commit -m "feat(index): add related-article resolution"
```

### Task 1.6: The content-build orchestrator

**Files:**
- Create: `apps/index/scripts/build-content.ts`
- Reused: `apps/index/src/components/parse-media-grids.ts` (already exists; Task 1.2 exported its media types).
- Delete: `apps/index/scripts/generate-blog-meta.ts`

- [ ] **Step 1: Write the orchestrator**

Create `apps/index/scripts/build-content.ts`:
```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMediaGrids } from '../src/components/parse-media-grids';
import type { ArticleBody, ArticleMeta, ContentManifest } from './lib/content-types';
import { blogFrontmatterSchema, supportFrontmatterSchema } from './lib/content-types';
import { parseContentFile } from './lib/frontmatter';
import { renderMarkdown } from './lib/render-markdown';
import { resolveRelated } from './lib/related';

const ROOT = process.cwd(); // apps/index
const DATA = join(ROOT, 'src', 'data');
const OUT = join(ROOT, 'src', 'content', '.generated');

// Recursively list every .md file under `dir`, returning paths relative to `dir`.
function listMarkdown(dir: string, base = ''): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listMarkdown(join(dir, entry.name), rel));
        else if (entry.name.endsWith('.md')) out.push(rel);
    }
    return out;
}

function writeArticle(collection: string, slug: string, body: ArticleBody) {
    const file = join(OUT, collection, `${slug}.json`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
}

function buildSupport(): ArticleMeta[] {
    const dir = join(DATA, 'support');
    const draft: ArticleMeta[] = [];
    for (const rel of listMarkdown(dir)) {
        const slug = rel.replace(/\.md$/, '');
        const section = slug.split('/')[0];
        const { data, body } = parseContentFile(readFileSync(join(dir, rel), 'utf-8'), supportFrontmatterSchema);
        if (data.draft) continue;
        const { content, mediaGrids } = parseMediaGrids(body);
        const { html, toc } = renderMarkdown(content);
        writeArticle('support', slug, { html, mediaGrids });
        draft.push({
            slug, section, title: data.title, description: data.description, type: data.type,
            category: data.category, tags: data.tags, order: data.order, updated: data.updated,
            toc, related: data.related,
        });
    }
    return draft.map((a) => ({ ...a, related: resolveRelated(a, draft) }));
}

function buildBlog(): ArticleMeta[] {
    const dir = join(DATA, 'blog');
    const articles: ArticleMeta[] = [];
    for (const rel of listMarkdown(dir)) {
        const dateMatch = rel.match(/^(\d{4}-\d{2}-\d{2})-/);
        const { data, body } = parseContentFile(readFileSync(join(dir, rel), 'utf-8'), blogFrontmatterSchema);
        const { content, mediaGrids } = parseMediaGrids(body);
        const { html, toc } = renderMarkdown(content);
        writeArticle('blog', data.id, { html, mediaGrids });
        articles.push({
            slug: data.id, section: 'blog', title: data.title, description: data.description,
            tags: [], order: 100, date: dateMatch ? dateMatch[1] : '', toc, related: [],
        });
    }
    return articles.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

function writeManifest(name: string, articles: ArticleMeta[]) {
    const manifest: ContentManifest = { articles };
    writeFileSync(join(OUT, `${name}.manifest.json`), JSON.stringify(manifest, null, 2));
}

function main() {
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const blog = buildBlog();
    const support = buildSupport();
    writeManifest('blog', blog);
    writeManifest('support', support);
    console.log(`Content build: ${blog.length} blog posts, ${support.length} support articles`);
}

main();
```

- [ ] **Step 2: Delete the old script**

Run: `git rm apps/index/scripts/generate-blog-meta.ts`

- [ ] **Step 3: Prepare the content — blog frontmatter + support seed article**

The blog posts must satisfy `blogFrontmatterSchema` (which requires a `description` field)
before the build can process them. In each of the two `.md` files under
`apps/index/src/data/blog/`, rename the frontmatter key `summary:` to `description:`
(leave `id:` and `title:` unchanged).

Then create `apps/index/src/data/support/getting-started/welcome-to-eigen.md`:
```markdown
---
title: "Welcome to Eigen"
description: "What Eigen is, how the apps fit together, and where to go next."
type: overview
order: 1
updated: 2026-05-20
---

Eigen is a self-hosted workspace: mail, files, documents, calendar, and more, all
under your own control.

## The apps

Each Eigen app handles one part of your workspace. Use the app switcher in the top
bar to move between them.

## Getting help

Every section of this help center covers one app. Use the search box at the top of
any page to jump straight to an answer.
```

- [ ] **Step 4: Run the content build**

Run: `cd apps/index && bun run scripts/build-content.ts`
Expected: prints `Content build: 2 blog posts, 1 support articles`; creates `apps/index/src/content/.generated/` with `blog.manifest.json`, `support.manifest.json`, `support/getting-started/welcome-to-eigen.json`, and `blog/<id>.json` files.

- [ ] **Step 5: Commit**

```bash
git add apps/index/scripts/build-content.ts apps/index/src/data/support apps/index/src/data/blog
git commit -m "feat(index): add content-build orchestrator, replace blog-meta script"
```

### Task 1.7: The app-side content loader

**Files:**
- Create: `apps/index/src/content/manifest.ts`

- [ ] **Step 1: Write the loader**

Create `apps/index/src/content/manifest.ts`:
```typescript
import type { ArticleBody, ArticleMeta, ContentManifest } from '../../scripts/lib/content-types';
import blogManifest from './.generated/blog.manifest.json';
import supportManifest from './.generated/support.manifest.json';

export type { ArticleBody, ArticleMeta };

const blog = (blogManifest as ContentManifest).articles;
const support = (supportManifest as ContentManifest).articles;

// Article bodies, eager-imported so they resolve synchronously — this keeps the
// prerender and client hydration in lockstep (no async loader data to rehydrate).
// At v1's article count the bundle cost is negligible; switch to a lazy glob with
// loader-data dehydration only if the library grows into the hundreds.
const bodies = import.meta.glob<ArticleBody>('./.generated/**/*.json', { eager: true, import: 'default' });

export function getBlogArticles(): ArticleMeta[] {
    return blog;
}
export function getSupportArticles(): ArticleMeta[] {
    return support;
}
export function getSupportArticle(section: string, file: string): ArticleMeta | undefined {
    return support.find((a) => a.slug === `${section}/${file}`);
}
export function getBlogArticle(id: string): ArticleMeta | undefined {
    return blog.find((a) => a.slug === id);
}

// Get one article's rendered body. Synchronous (bodies are eager-imported), so
// route components read it directly with no loader — prerender and hydration agree.
export function getArticleBody(collection: 'blog' | 'support', slug: string): ArticleBody | undefined {
    return bodies[`./.generated/${collection}/${slug}.json`];
}
```

Note: `.generated/` does not exist until Task 1.6's build has run — keep that order.

- [ ] **Step 2: Verify it type-checks**

Run: `cd apps/index && bunx tsc --noEmit`
Expected: no errors (the `.generated` JSON imports resolve because the build ran in Task 1.6).

- [ ] **Step 3: Commit**

```bash
git add apps/index/src/content/manifest.ts
git commit -m "feat(index): add app-side content manifest loader"
```

### Task 1.8: The ArticleContent component

**Files:**
- Create: `apps/index/src/components/ArticleContent.tsx`

- [ ] **Step 1: Write the component**

Create `apps/index/src/components/ArticleContent.tsx`. It renders build-time HTML and swaps the `[MEDIAGRID:N]` placeholders (which `markdown-it` wrapped in `<p>` tags) for interactive `<MediaGrid>` islands:
```typescript
import { useMemo } from 'react';
import type { ArticleBody } from '../content/manifest';
import { MediaGrid } from './MediaGrid';

type ArticleContentProps = { body: ArticleBody; className?: string };

// Splits rendered HTML on the <p>[MEDIAGRID:N]</p> markers left by the build,
// rendering the HTML chunks statically and the grids as hydrated islands.
export function ArticleContent({ body, className }: ArticleContentProps) {
    const parts = useMemo(() => {
        const segments: Array<{ html: string } | { grid: number }> = [];
        const regex = /<p>\[MEDIAGRID:(\d+)\]<\/p>/g;
        let last = 0;
        let match: RegExpExecArray | null;
        match = regex.exec(body.html);
        while (match !== null) {
            segments.push({ html: body.html.slice(last, match.index) });
            segments.push({ grid: Number(match[1]) });
            last = match.index + match[0].length;
            match = regex.exec(body.html);
        }
        segments.push({ html: body.html.slice(last) });
        return segments;
    }, [body.html]);

    return (
        <div className={className}>
            {parts.map((part, i) => {
                if ('grid' in part) {
                    const grid = body.mediaGrids[part.grid];
                    return grid ? <MediaGrid key={i} columns={grid.columns} items={grid.items} /> : null;
                }
                if (!part.html) return null;
                // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time-rendered trusted Markdown
                return <div key={i} dangerouslySetInnerHTML={{ __html: part.html }} />;
            })}
        </div>
    );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd apps/index && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/index/src/components/ArticleContent.tsx
git commit -m "feat(index): add ArticleContent renderer with media-grid islands"
```

### Task 1.9: Migrate the blog onto the pipeline

**Files:**
- Modify: `apps/index/src/data/blog/2025-10-03-eigen-proof-of-concept.md` and `apps/index/src/data/blog/2026-04-11-eigen-six-months-later.md`
- Rewrite: `apps/index/src/data/blog-posts.ts`
- Rewrite: `apps/index/src/components/BlogPost.tsx`
- Modify: `apps/index/src/routes/blog.index.tsx`, `apps/index/src/routes/blog.$id.tsx`

- [ ] **Step 1: Confirm the blog frontmatter is migrated**

Task 1.6 already renamed the blog frontmatter key `summary:` to `description:`. Verify both
files under `apps/index/src/data/blog/` have a `description:` key — no change needed here.

- [ ] **Step 2: Re-implement `blog-posts.ts` over the manifest**

Replace the entire contents of `apps/index/src/data/blog-posts.ts`:
```typescript
import { type ArticleMeta, getBlogArticle, getBlogArticles } from '../content/manifest';

export type BlogPost = ArticleMeta;

export function getAllBlogPosts(): BlogPost[] {
    return getBlogArticles();
}
export function getLatestBlogPost(): BlogPost | undefined {
    return getBlogArticles()[0];
}
export function getBlogPost(id: string): BlogPost | undefined {
    return getBlogArticle(id);
}
```

- [ ] **Step 3: Rewrite `BlogPost.tsx` to render the built body**

The blog routes load the body in a route loader (Step 4); `BlogPost` receives the meta and the body. Replace the entire contents of `apps/index/src/components/BlogPost.tsx`:
```typescript
import type { ArticleBody } from '../content/manifest';
import type { BlogPost as BlogPostType } from '../data/blog-posts';
import { ArticleContent } from './ArticleContent';

type BlogPostProps = { post: BlogPostType; body: ArticleBody };

export function BlogPost({ post, body }: BlogPostProps) {
    return (
        <article className="blog-post">
            <h1 className="text-4xl font-bold mb-2">{post.title}</h1>
            <p className="text-sm text-muted-foreground mb-6">{post.date}</p>
            <ArticleContent body={body} className="eigen-prose" />
        </article>
    );
}
```

`react-markdown` is now unused. Confirm no file under `apps/index/src` still imports it,
then remove it from `apps/index/package.json` by deleting its line from the `dependencies`
block. Do NOT run `bun remove` or `bun install` — that rewrites the shared `bun.lock`,
which a concurrent process is editing. Edit only `package.json`; leave `bun.lock` alone.

- [ ] **Step 4: Update `blog.$id.tsx` to load the body**

Replace the entire contents of `apps/index/src/routes/blog.$id.tsx`:
```typescript
import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { BlogPost } from '../components/BlogPost';
import { getArticleBody } from '../content/manifest';
import { getBlogPost } from '../data/blog-posts';

export const Route = createFileRoute('/blog/$id')({
    component: BlogPostComponent,
    head: ({ params }) => {
        const post = getBlogPost(params.id);
        if (!post) return { meta: [{ title: 'Post not found - eigen blog' }] };
        const url = `https://eigen.is/blog/${post.slug}`;
        return {
            meta: [
                { title: `${post.title} - eigen blog` },
                { name: 'description', content: post.description },
                { property: 'og:title', content: post.title },
                { property: 'og:description', content: post.description },
                { property: 'og:type', content: 'article' },
                { property: 'og:url', content: url },
                { property: 'article:published_time', content: post.date },
            ],
        };
    },
});

function BlogPostComponent() {
    const { id } = useParams({ from: '/blog/$id' });
    const post = getBlogPost(id);
    const body = post ? getArticleBody('blog', post.slug) : undefined;

    if (!post || !body) {
        return (
            <div className="min-h-screen bg-muted/50">
                <div className="container mx-auto px-4 py-8 max-w-3xl">
                    <div className="mb-8">
                        <Link to="/blog" className="text-link hover:text-link/80 hover:underline">
                            ← Back to blog
                        </Link>
                    </div>
                    <h1 className="text-3xl font-bold mb-4">Post not found</h1>
                    <p className="text-muted-foreground">The blog post you're looking for doesn't exist.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-muted/50">
            <div className="container mx-auto px-4 py-8 max-w-3xl">
                <div className="mb-8">
                    <Link to="/blog" className="text-link hover:text-link/80 hover:underline">
                        ← Back to blog
                    </Link>
                </div>
                <BlogPost post={post} body={body} />
            </div>
        </div>
    );
}
```

- [ ] **Step 5: Update `blog.index.tsx` to load the latest post's body**

In `apps/index/src/routes/blog.index.tsx`: add a `loader` that loads the latest post's body, and pass it to `BlogPost`. Change the route definition and component:
```typescript
import { createFileRoute, Link } from '@tanstack/react-router';
import { BlogPost } from '../components/BlogPost';
import { getArticleBody } from '../content/manifest';
import { getAllBlogPosts, getLatestBlogPost } from '../data/blog-posts';

export const Route = createFileRoute('/blog/')({
    component: BlogOverviewComponent,
    head: () => ({
        meta: [
            { title: 'Blog - eigen' },
            {
                name: 'description',
                content:
                    'Read about the development of eigen, a minimal and secure workspace in the cloud where you control your own data.',
            },
            { property: 'og:title', content: 'Blog - eigen' },
            {
                property: 'og:description',
                content:
                    'Read about the development of eigen, a minimal and secure workspace in the cloud where you control your own data.',
            },
            { property: 'og:type', content: 'website' },
            { property: 'og:url', content: 'https://eigen.is/blog' },
        ],
    }),
});

function BlogOverviewComponent() {
    const latestPost = getLatestBlogPost();
    const body = latestPost ? getArticleBody('blog', latestPost.slug) : undefined;
    const otherPosts = getAllBlogPosts().slice(1);

    return (
        <div className="min-h-screen bg-muted/50">
            <div className="container mx-auto px-4 py-8 max-w-3xl">
                <div className="mb-8">
                    <Link to="/" className="text-link hover:text-link/80 hover:underline">
                        ← Back to home
                    </Link>
                </div>

                {latestPost && body && <BlogPost post={latestPost} body={body} />}

                {otherPosts.length > 0 && (
                    <div className="mt-16 pt-8 border-t border-border">
                        <h2 className="text-2xl font-bold mb-6">Other Posts</h2>
                        <div className="space-y-8">
                            {otherPosts.map((post) => (
                                <article key={post.slug}>
                                    <h3 className="text-xl font-semibold mb-1">
                                        <Link to="/blog/$id" params={{ id: post.slug }} className="hover:text-link">
                                            {post.title}
                                        </Link>
                                    </h3>
                                    <p className="text-sm text-muted-foreground mb-2">{post.date}</p>
                                    <p className="text-foreground leading-7">{post.description}</p>
                                </article>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 6: Verify the dev server renders the blog**

Run: `cd apps/index && bun run scripts/build-content.ts && bun run dev`
Open `http://localhost:3000/blog` and a post. Expected: posts render with full content and media grids; no console errors. Stop the dev server.

- [ ] **Step 7: Verify type-check passes**

Run: `cd apps/index && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/index/src/data/blog-posts.ts apps/index/src/components/BlogPost.tsx apps/index/src/routes/blog.index.tsx apps/index/src/routes/blog.$id.tsx apps/index/package.json
git commit -m "feat(index): migrate blog onto the build-time content pipeline"
```

### Task 1.10: Make `useMediaQuery` prerender-safe

**Files:**
- Modify: `packages/lib/src/core/media/hooks/use-media-query.ts`

- [ ] **Step 1: Rewrite the hook with `useSyncExternalStore`**

Replace the entire contents of `packages/lib/src/core/media/hooks/use-media-query.ts`:
```typescript
import { useSyncExternalStore } from 'react';

// Prerender-safe media query hook. `getServerSnapshot` returns false (desktop
// default) so a build-time render and the first client render agree — no
// hydration mismatch. On the client `getSnapshot` reads the real value
// synchronously, so client-only apps see no first-render flash.
export function useMediaQuery(query: string): boolean {
    return useSyncExternalStore(
        (onChange) => {
            if (typeof window === 'undefined') return () => {};
            const media = window.matchMedia(query);
            media.addEventListener('change', onChange);
            return () => media.removeEventListener('change', onChange);
        },
        () => (typeof window === 'undefined' ? false : window.matchMedia(query).matches),
        () => false,
    );
}

export function useIsMobile() {
    return useMediaQuery('(max-width: 768px)');
}

export function useIsTablet() {
    return useMediaQuery('(min-width: 769px) and (max-width: 1024px)');
}

export function useIsDesktop() {
    return useMediaQuery('(min-width: 1025px)');
}
```

- [ ] **Step 2: Type-check the whole workspace** (the hook is used across apps)

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/src/core/media/hooks/use-media-query.ts
git commit -m "fix(lib): make useMediaQuery prerender-safe via useSyncExternalStore"
```

### Task 1.11: The prerender pass

**Files:**
- Modify: `apps/index/src/routes/__root.tsx`
- Create: `apps/index/scripts/prerender.ts`
- Delete: `apps/index/scripts/post-build.ts`

This task prerenders `/blog/*` and `/support/*` only — not `/`. The home page stays a client-rendered SPA (its `createRoot` path in Task 1.12). Prerendering `/` would require making the auth/query provider tree SSR-safe; it is the documented fallback in `docs/PROPOSAL_HELP_CENTER.md` §Resolved questions and is deferred.

- [ ] **Step 0: Make the root redirect prerender-safe**

In `apps/index/src/routes/__root.tsx`, the `beforeLoad` reads `window`. Guard it so it is inert during the build-time prerender — replace the `beforeLoad`:
```typescript
    beforeLoad: ({ context }) => {
        if (
            typeof window !== 'undefined' &&
            context.auth?.isAuthenticated &&
            window.location.pathname === '/'
        ) {
            window.location.href = getSpaceAppUrl();
            return new Promise(() => {});
        }
    },
```

- [ ] **Step 1: Write the prerender script**

Create `apps/index/scripts/prerender.ts`. It enumerates the `/blog` and `/support` routes from the generated manifests, renders each to full static HTML with a TanStack Router memory history, and writes per-route `index.html` files with route-specific `<title>`/meta and JSON-LD:
```typescript
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from '@workspace/lib/html';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from '../src/routeTree.gen';
import type { ContentManifest } from './lib/content-types';

const ROOT = process.cwd(); // apps/index
const DIST = join(ROOT, '..', '..', 'dist', 'index');
const GEN = join(ROOT, 'src', 'content', '.generated');
const BASE_URL = 'https://eigen.is';
const DEFAULT_DESCRIPTION =
    'Eigen is your minimal, secure workspace in the cloud. Simple and secure. You control your data.';

function manifest(name: string): ContentManifest {
    return JSON.parse(readFileSync(join(GEN, `${name}.manifest.json`), 'utf-8'));
}

type PageMeta = { title: string; description: string; url: string; type: 'website' | 'article'; updated?: string };

// Build the route list: the /blog and /support trees (not "/", which stays SPA).
function routes(): Array<{ path: string; meta: PageMeta }> {
    const list: Array<{ path: string; meta: PageMeta }> = [
        { path: '/blog', meta: { title: 'Blog - eigen', description: DEFAULT_DESCRIPTION, url: `${BASE_URL}/blog`, type: 'website' } },
        { path: '/support', meta: { title: 'Help Center - eigen', description: 'Help and documentation for Eigen.', url: `${BASE_URL}/support`, type: 'website' } },
    ];
    for (const a of manifest('blog').articles) {
        list.push({ path: `/blog/${a.slug}`, meta: { title: `${a.title} - eigen blog`, description: a.description, url: `${BASE_URL}/blog/${a.slug}`, type: 'article', updated: a.date } });
    }
    const support = manifest('support').articles;
    for (const section of new Set(support.map((a) => a.section))) {
        list.push({ path: `/support/${section}`, meta: { title: `${section} - Eigen Help`, description: `Help articles for ${section}.`, url: `${BASE_URL}/support/${section}`, type: 'website' } });
    }
    for (const a of support) {
        list.push({ path: `/support/${a.slug}`, meta: { title: `${a.title} - Eigen Help`, description: a.description, url: `${BASE_URL}/support/${a.slug}`, type: 'article', updated: a.updated } });
    }
    return list;
}

function withMeta(html: string, m: PageMeta): string {
    const t = escapeHtml(m.title);
    const d = escapeHtml(m.description);
    return html
        .replace('<title>eigen</title>', `<title>${t}</title>`)
        .replace('property="og:title" content="eigen"', `property="og:title" content="${t}"`)
        .replaceAll(`content="${DEFAULT_DESCRIPTION}"`, `content="${d}"`)
        .replace('content="website"', `content="${m.type}"`)
        .replace(`content="${BASE_URL}"`, `content="${escapeHtml(m.url)}"`);
}

// Minimal Article JSON-LD for article pages (SEO). A safe, always-valid schema.
function jsonLd(m: PageMeta): string {
    if (m.type !== 'article') return '';
    const data = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: m.title,
        description: m.description,
        url: m.url,
    };
    return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

async function renderRoute(path: string): Promise<string> {
    // `auth: undefined!` mirrors main.tsx — __root.tsx's beforeLoad short-circuits
    // on a falsy `context.auth?.isAuthenticated`, so no real auth is needed here.
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [path] }),
        context: { auth: undefined! },
    });
    await router.load();
    return renderToString(<RouterProvider router={router} />);
}

// dist/index/index.html for "/"; dist/index/<path>/index.html for the rest.
function outFile(path: string): string {
    if (path === '/') return join(DIST, 'index.html');
    const dir = join(DIST, ...path.split('/').filter(Boolean));
    mkdirSync(dir, { recursive: true });
    return join(dir, 'index.html');
}

function sitemap(routeList: Array<{ path: string; meta: PageMeta }>): string {
    const urls = routeList
        .map((r) => {
            const loc = escapeHtml(BASE_URL + (r.path === '/' ? '' : r.path));
            const lastmod = r.meta.updated ? `<lastmod>${escapeHtml(r.meta.updated)}</lastmod>` : '';
            return `  <url><loc>${loc}</loc>${lastmod}</url>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

async function main() {
    const shell = readFileSync(join(DIST, 'index.html'), 'utf-8');
    const all = routes();
    for (const route of all) {
        const appHtml = await renderRoute(route.path);
        const page = withMeta(shell, route.meta)
            .replace('</head>', `<link rel="canonical" href="${escapeHtml(route.meta.url)}"/>${jsonLd(route.meta)}</head>`)
            .replace('<div id="app"></div>', `<div id="app">${appHtml}</div>`);
        writeFileSync(outFile(route.path), page);
        console.log(`Prerendered ${route.path}`);
    }
    writeFileSync(join(DIST, 'sitemap.xml'), sitemap(all));
    console.log(`Prerender complete: ${all.length} routes + sitemap.xml`);
}

main();
```

- [ ] **Step 2: Rename the script to `.tsx` (it contains JSX) and repoint `postbuild`**

The file uses JSX, so it must be `apps/index/scripts/prerender.tsx`. Save it (or `git mv`) as `prerender.tsx`, and set `apps/index/package.json`'s `postbuild` to `bun run scripts/prerender.tsx`.

- [ ] **Step 3: Delete the old post-build script**

Run: `git rm apps/index/scripts/post-build.ts`

- [ ] **Step 4: Verify the script type-checks** (full build verification happens in Task 1.13)

Run: `cd apps/index && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/index/scripts/prerender.tsx apps/index/package.json apps/index/src/routes/__root.tsx
git commit -m "feat(index): add route prerender pass, replace post-build script"
```

### Task 1.12: Switch the client entry to hydration

**Files:**
- Modify: `apps/index/src/main.tsx`

- [ ] **Step 1: Use `hydrateRoot` when prerendered content is present**

Replace the bottom block of `apps/index/src/main.tsx` (the `rootElement` mount) with:
```typescript
const rootElement = document.getElementById('app')!;

if (rootElement.hasChildNodes()) {
    ReactDOM.hydrateRoot(rootElement, <App />);
} else {
    ReactDOM.createRoot(rootElement).render(<App />);
}
```

The `createRoot` branch keeps `bun run dev` working (dev has no prerendered HTML); the `hydrateRoot` branch adopts the prerendered content in production.

- [ ] **Step 2: Verify dev still works**

Run: `cd apps/index && bun run dev`
Open `http://localhost:3000/` and `/blog` — both render, no console errors. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add apps/index/src/main.tsx
git commit -m "feat(index): hydrate prerendered HTML, fall back to createRoot in dev"
```

### Task 1.13: Ignore generated artifacts and verify the full build

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Gitignore the generated content**

Append to `.gitignore`:
```
/apps/index/src/content/.generated/
```

- [ ] **Step 2: Run the full production build for the index app**

Run: `cd apps/index && bun run build`
Expected: `prebuild` runs the content build, `vite build` succeeds, `postbuild` runs the prerender. Note: the `/support` routes are added in Phase 2, so this Phase 1 build prerenders `/support/*` paths to a not-found page — that is expected and harmless (those files are regenerated correctly once Phase 2 adds the routes). The build must still exit 0. Check that the prerendered blog file `dist/index/blog/eigen-six-months-later/index.html` exists and contains the post's real rendered HTML inside `<div id="app">` (not an empty `<div id="app"></div>`).

- [ ] **Step 3: Verify a prerendered file contains real content**

Run: `grep -c "I kept building" ../../dist/index/blog/eigen-six-months-later/index.html`
Expected: `1` or more — the blog post body text is in the static HTML, proving the prerender embedded real rendered content.

- [ ] **Step 4: Run the scoped checks**

A concurrent process has other apps mid-edit, so the full-workspace `bun run check` would
report unrelated failures. Verify only the packages this plan has touched:
- `cd apps/index && bunx tsc --noEmit` — clean.
- `cd apps/index && bun test` — all content-pipeline tests pass.
- `cd packages/lib && bun run typecheck` — clean.
- `bunx --bun @biomejs/biome check apps/index packages/lib/src/core/media` — lint clean for the touched files.

(The full `bun run check` is deferred to a final verification once the concurrent work settles.)

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "build(index): gitignore generated content artifacts"
```

---

# Phase 2 — Help center pages

Phase 2 builds the public help center UI at `/support`: the shell, landing, section, and article pages, the avatar-menu "Help" link, and seed content. Search is added in Phase 3.

### Task 2.1: Cross-app URL helpers

**Files:**
- Modify: `packages/lib/src/core/api.ts`
- Modify: the env files (`.env.development` and any sibling env files — gitignored, edit in place)

- [ ] **Step 1: Add the index-app env var**

In `.env.development` (repo root; gitignored — follow the existing `VITE_APP_*_URL` lines), add:
```
VITE_APP_INDEX_URL=http://localhost:3000
```
Add the equivalent to any other env files that define `VITE_APP_*_URL` (e.g. a production env file), pointing at the root domain.

- [ ] **Step 2: Add the helpers to `api.ts`**

In `packages/lib/src/core/api.ts`, after the `ADMIN_APP_URL` line (~line 74) add:
```typescript
export const INDEX_APP_URL = import.meta.env.VITE_APP_INDEX_URL as string;
```
After the `getAdminAppUrl` line (~line 94) add:
```typescript
export const getSupportUrl = (path?: string) => joinAppUrl(INDEX_APP_URL, path ? `support/${path}` : 'support');
export const getHelpUrl = (section: string, slug: string) => getSupportUrl(`${section}/${slug}`);
```

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/lib/src/core/api.ts
git commit -m "feat(lib): add getSupportUrl and getHelpUrl helpers"
```

### Task 2.2: "Help" item in the avatar menu

**Files:**
- Modify: `packages/ui/src/components/layout/app/topbar.tsx`

- [ ] **Step 1: Add the imports**

In `topbar.tsx`, change the lucide import (line 8) to include `LifeBuoy`:
```typescript
import { Grip, LifeBuoy, LogOut, Menu, Palette, Settings, Shield, UserRound } from 'lucide-react';
```
Change the api import (line 3) to include `getSupportUrl`:
```typescript
import { getAdminAppUrl, getSpacePasswordUrl, getSpaceProfileUrl, getSupportUrl } from '@workspace/lib/api.ts';
```

- [ ] **Step 2: Add the Help item to `UserDropdown`**

In `UserDropdown`, immediately before the `<DropdownMenuSeparator />` that precedes the "About Eigen" item (line 229), insert:
```typescript
                    <DropdownMenuItem asChild>
                        <a href={getSupportUrl()}>
                            <LifeBuoy />
                            Help
                        </a>
                    </DropdownMenuItem>
```

- [ ] **Step 3: Add the Help item to `GuestUserDropdown`**

In `GuestUserDropdown`, immediately before the `<DropdownMenuSeparator />` that precedes the "About Eigen" item (line 154), insert the same block:
```typescript
                    <DropdownMenuItem asChild>
                        <a href={getSupportUrl()}>
                            <LifeBuoy />
                            Help
                        </a>
                    </DropdownMenuItem>
```

- [ ] **Step 4: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/layout/app/topbar.tsx
git commit -m "feat(ui): add Help item to the avatar menu"
```

### Task 2.3: Section configuration

**Files:**
- Create: `apps/index/src/components/support/sections.ts`

- [ ] **Step 1: Write the section config**

Create `apps/index/src/components/support/sections.ts`:
```typescript
import {
    Calendar,
    Contact,
    FileText,
    FolderOpen,
    type LucideIcon,
    Mail,
    MessageSquare,
    Plug,
    Presentation,
    Rocket,
    Settings,
    Shield,
    StickyNote,
    Table,
} from 'lucide-react';

export type SectionConfig = { id: string; title: string; description: string; icon: LucideIcon };

// Display order, titles, and icons for help center sections. The `id` matches
// the folder name under src/data/support/.
export const SECTIONS: SectionConfig[] = [
    { id: 'getting-started', title: 'Getting started', description: 'New to Eigen — start here.', icon: Rocket },
    { id: 'mail', title: 'Mail', description: 'Reading, composing, filters.', icon: Mail },
    { id: 'drive', title: 'Drive', description: 'Files, folders, sharing.', icon: FolderOpen },
    { id: 'docs', title: 'Docs', description: 'Editing and collaboration.', icon: FileText },
    { id: 'sheets', title: 'Sheets', description: 'Spreadsheets and formulas.', icon: Table },
    { id: 'slides', title: 'Slides', description: 'Building and presenting decks.', icon: Presentation },
    { id: 'calendar', title: 'Calendar', description: 'Events, invites, sharing.', icon: Calendar },
    { id: 'contacts', title: 'Contacts', description: 'Managing people and groups.', icon: Contact },
    { id: 'chat', title: 'Chat', description: 'Messages and spaces.', icon: MessageSquare },
    { id: 'stickies', title: 'Stickies', description: 'Notes and boards.', icon: StickyNote },
    { id: 'connect', title: 'Connecting external apps', description: 'Use Eigen with other apps.', icon: Plug },
    { id: 'account', title: 'Account & settings', description: 'Profile, security, appearance.', icon: Settings },
    { id: 'admin', title: 'Admin', description: 'Organisations, teams, the server.', icon: Shield },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

export function getSection(id: string): SectionConfig | undefined {
    return BY_ID.get(id);
}
```

- [ ] **Step 2: Type-check and commit**

Run: `cd apps/index && bunx tsc --noEmit` (expected: no errors), then:
```bash
git add apps/index/src/components/support/sections.ts
git commit -m "feat(index): add help center section config"
```

### Task 2.4: Support breadcrumb

**Files:**
- Create: `apps/index/src/components/support/support-breadcrumb.tsx`

- [ ] **Step 1: Write the component**

Create `apps/index/src/components/support/support-breadcrumb.tsx`:
```typescript
import { Link } from '@tanstack/react-router';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { Fragment } from 'react';

export type Crumb = { label: string; to?: string };

// The toolbar breadcrumb for section and article pages. The last crumb is the
// current page (BreadcrumbPage); earlier crumbs link.
export function SupportBreadcrumb({ trail }: { trail: Crumb[] }) {
    return (
        <Breadcrumb className="overflow-hidden">
            <BreadcrumbList>
                {trail.map((crumb, i) => {
                    const isLast = i === trail.length - 1;
                    return (
                        <Fragment key={crumb.label}>
                            {i > 0 && <BreadcrumbSeparator />}
                            <BreadcrumbItem>
                                {isLast || !crumb.to ? (
                                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                                ) : (
                                    <BreadcrumbLink asChild>
                                        <Link to={crumb.to}>{crumb.label}</Link>
                                    </BreadcrumbLink>
                                )}
                            </BreadcrumbItem>
                        </Fragment>
                    );
                })}
            </BreadcrumbList>
        </Breadcrumb>
    );
}
```

- [ ] **Step 2: Type-check and commit**

Run: `cd apps/index && bunx tsc --noEmit`, then:
```bash
git add apps/index/src/components/support/support-breadcrumb.tsx
git commit -m "feat(index): add support breadcrumb component"
```

### Task 2.5: The help center shell

**Files:**
- Create: `apps/index/src/components/support/support-header.tsx`
- Create: `apps/index/src/components/support/support-shell.tsx`

- [ ] **Step 1: Write the public header**

Create `apps/index/src/components/support/support-header.tsx`:
```typescript
import { Link } from '@tanstack/react-router';
import { getSpaceAppUrl } from '@workspace/lib/api';
import { Button } from '@workspace/ui/components/button';

// The help center's own public header — no app topbar (no avatar / app switcher).
export function SupportHeader() {
    return (
        <header className="bg-app text-white shrink-0">
            <div className="flex h-12 items-center px-4 gap-3">
                <Link to="/support" className="font-semibold">
                    eigen · Help Center
                </Link>
                <div className="flex-1" />
                <Button asChild variant="ghost" size="sm" className="text-white hover:bg-primary/20 hover:text-white">
                    <a href={getSpaceAppUrl()}>Sign in</a>
                </Button>
            </div>
        </header>
    );
}
```

- [ ] **Step 2: Write the shell**

Create `apps/index/src/components/support/support-shell.tsx`. It supplies `LayoutContext` so `ColumnLayout`/`Column` work without `AppShell`:
```typescript
import { useIsMobile, useIsTablet } from '@workspace/lib/media';
import { LayoutContext } from '@workspace/ui/components/layout/app/layout-context';
import { type ReactNode, useMemo } from 'react';
import { SupportHeader } from './support-header';

// The help center's analogue of AppShell: a public header plus a LayoutContext
// provider, so ColumnLayout/Column render exactly as they do inside the apps.
export function SupportShell({ children }: { children: ReactNode }) {
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    const layout = useMemo(
        () => ({
            appName: 'support',
            setAppName: () => {},
            documentTitle: '',
            setDocumentTitle: () => {},
            sidebarOpen: false,
            setSidebarOpen: () => {},
            sidebarMode: 'none' as const,
            sidebarHidden: true,
            setSidebarHidden: () => {},
            isMobile,
            isTablet,
        }),
        [isMobile, isTablet],
    );

    return (
        <LayoutContext.Provider value={layout}>
            <div className="flex flex-col h-dvh">
                <SupportHeader />
                <div className="flex flex-1 overflow-hidden">{children}</div>
            </div>
        </LayoutContext.Provider>
    );
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/index && bunx tsc --noEmit`
Expected: no errors. If the `LayoutContext` import path differs, locate it: `grep -rl "export const LayoutContext\|export.*LayoutContext" packages/ui/src` and use that path.

- [ ] **Step 4: Commit**

```bash
git add apps/index/src/components/support/support-header.tsx apps/index/src/components/support/support-shell.tsx
git commit -m "feat(index): add help center shell with LayoutContext provider"
```

### Task 2.6: The landing page

**Files:**
- Create: `apps/index/src/components/support/support-landing.tsx`

- [ ] **Step 1: Write the landing page**

Create `apps/index/src/components/support/support-landing.tsx`:
```typescript
import { Link } from '@tanstack/react-router';
import { getSupportArticles } from '../../content/manifest';
import { SECTIONS } from './sections';

// The help center front door: a hero, a browse-by-app grid, and popular links.
// Full-width and centred — not the column layout. (Search is added in Phase 3.)
export function SupportLanding() {
    const popular = getSupportArticles()
        .filter((a) => a.type === 'overview' || a.type === 'how-to')
        .slice(0, 6);

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-4xl px-6 py-12">
                <h1 className="text-3xl font-bold text-center mb-10">How can we help?</h1>

                <h2 className="text-sm font-medium text-muted-foreground mb-3">Browse by topic</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-12">
                    {SECTIONS.map((section) => {
                        const Icon = section.icon;
                        return (
                            <Link
                                key={section.id}
                                to="/support/$section"
                                params={{ section: section.id }}
                                className="eigen-list-item flex flex-col gap-1 rounded-lg border p-4 hover:bg-muted"
                            >
                                <Icon className="h-5 w-5 text-muted-foreground" />
                                <span className="font-medium">{section.title}</span>
                                <span className="text-sm text-muted-foreground">{section.description}</span>
                            </Link>
                        );
                    })}
                </div>

                {popular.length > 0 && (
                    <>
                        <h2 className="text-sm font-medium text-muted-foreground mb-3">Popular articles</h2>
                        <ul className="space-y-1">
                            {popular.map((article) => {
                                const [section, file] = article.slug.split('/');
                                return (
                                    <li key={article.slug}>
                                        <Link
                                            to="/support/$section/$article"
                                            params={{ section, article: file }}
                                            className="text-link hover:underline"
                                        >
                                            {article.title}
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Type-check and commit**

Run: `cd apps/index && bunx tsc --noEmit`, then:
```bash
git add apps/index/src/components/support/support-landing.tsx
git commit -m "feat(index): add help center landing page"
```

### Task 2.7: The section page

**Files:**
- Create: `apps/index/src/components/support/section-nav.tsx`
- Create: `apps/index/src/components/support/support-section.tsx`

- [ ] **Step 1: Write the section nav (the left column, shared by section + article pages)**

Create `apps/index/src/components/support/section-nav.tsx`:
```typescript
import { Link } from '@tanstack/react-router';
import { cn } from '@workspace/ui/lib/utils';
import type { ArticleMeta } from '../../content/manifest';

// The left-column list of a section's articles, grouped by `category`.
export function SectionNav({ section, articles, activeSlug }: { section: string; articles: ArticleMeta[]; activeSlug?: string }) {
    const groups = new Map<string, ArticleMeta[]>();
    for (const article of [...articles].sort((a, b) => a.order - b.order)) {
        const key = article.category ?? '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(article);
    }

    return (
        <nav className="h-full overflow-y-auto p-3 text-sm">
            {[...groups.entries()].map(([category, items]) => (
                <div key={category} className="mb-4">
                    {category && (
                        <div className="px-2 mb-1 text-xs font-medium uppercase text-muted-foreground">{category}</div>
                    )}
                    {items.map((article) => {
                        const file = article.slug.split('/')[1];
                        return (
                            <Link
                                key={article.slug}
                                to="/support/$section/$article"
                                params={{ section, article: file }}
                                className={cn(
                                    'block rounded px-2 py-1 hover:bg-muted',
                                    article.slug === activeSlug && 'bg-muted font-medium',
                                )}
                            >
                                {article.title}
                            </Link>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}
```

- [ ] **Step 2: Write the section page**

Create `apps/index/src/components/support/support-section.tsx`:
```typescript
import { Link } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import type { ArticleMeta } from '../../content/manifest';
import { getSection } from './sections';
import { SectionNav } from './section-nav';
import { SupportBreadcrumb } from './support-breadcrumb';

// A section landing page: section nav + the section's articles.
export function SupportSection({ section, articles }: { section: string; articles: ArticleMeta[] }) {
    const { isMobile } = useLayout();
    const config = getSection(section);
    const title = config?.title ?? section;
    const sorted = [...articles].sort((a, b) => a.order - b.order);

    return (
        <ColumnLayout mobileColumn={isMobile ? 'list' : 'nav'}>
            <Column id="nav" width="260px" toolbar={<span className="text-sm">Help Center</span>}>
                <SectionNav section={section} articles={articles} />
            </Column>
            <Column
                id="list"
                width="flex"
                onBack={() => history.back()}
                toolbar={
                    <SupportBreadcrumb trail={[{ label: 'Help Center', to: '/support' }, { label: title }]} />
                }
            >
                <div className="h-full overflow-y-auto px-6 py-6 max-w-2xl">
                    <h1 className="text-2xl font-bold mb-1">{title}</h1>
                    {config && <p className="text-muted-foreground mb-6">{config.description}</p>}
                    <ul className="space-y-1">
                        {sorted.map((article) => {
                            const file = article.slug.split('/')[1];
                            return (
                                <li key={article.slug}>
                                    <Link
                                        to="/support/$section/$article"
                                        params={{ section, article: file }}
                                        className="text-link hover:underline"
                                    >
                                        {article.title}
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </Column>
        </ColumnLayout>
    );
}
```

- [ ] **Step 3: Type-check and commit**

Run: `cd apps/index && bunx tsc --noEmit`, then:
```bash
git add apps/index/src/components/support/section-nav.tsx apps/index/src/components/support/support-section.tsx
git commit -m "feat(index): add help center section page"
```

### Task 2.8: The article TOC

**Files:**
- Create: `apps/index/src/components/support/article-toc.tsx`

- [ ] **Step 1: Write the component**

Create `apps/index/src/components/support/article-toc.tsx`:
```typescript
import { cn } from '@workspace/ui/lib/utils';
import type { TocEntry } from '../../content/manifest';

// The on-this-page list. Rendered only when there are 2+ headings.
export function ArticleToc({ toc }: { toc: TocEntry[] }) {
    return (
        <nav className="h-full overflow-y-auto p-3 text-sm">
            {toc.map((entry) => (
                <a
                    key={entry.id}
                    href={`#${entry.id}`}
                    className={cn(
                        'block rounded px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-muted',
                        entry.level === 3 && 'pl-5',
                    )}
                >
                    {entry.text}
                </a>
            ))}
        </nav>
    );
}
```

Note: `TocEntry` is re-exported from `manifest.ts` — add it there. In `apps/index/src/content/manifest.ts`, change the type re-export line to:
```typescript
import type { ArticleBody, ArticleMeta, ContentManifest, TocEntry } from '../../scripts/lib/content-types';
export type { ArticleBody, ArticleMeta, TocEntry };
```

- [ ] **Step 2: Type-check and commit**

Run: `cd apps/index && bunx tsc --noEmit`, then:
```bash
git add apps/index/src/components/support/article-toc.tsx apps/index/src/content/manifest.ts
git commit -m "feat(index): add article table-of-contents component"
```

### Task 2.9: The article page

**Files:**
- Create: `apps/index/src/components/support/support-article.tsx`

- [ ] **Step 1: Write the article page**

Create `apps/index/src/components/support/support-article.tsx`:
```typescript
import { Link } from '@tanstack/react-router';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import type { ArticleBody, ArticleMeta } from '../../content/manifest';
import { ArticleContent } from '../ArticleContent';
import { ArticleToc } from './article-toc';
import { getSection } from './sections';
import { SectionNav } from './section-nav';
import { SupportBreadcrumb } from './support-breadcrumb';

// A full article: section nav + body + on-this-page TOC, in ColumnLayout so the
// toolbars/breadcrumb match Drive exactly. TOC column hidden below 2 headings.
export function SupportArticle({
    article,
    body,
    siblings,
    related,
}: {
    article: ArticleMeta;
    body: ArticleBody;
    siblings: ArticleMeta[];
    related: ArticleMeta[];
}) {
    const { isMobile } = useLayout();
    const section = article.section;
    const config = getSection(section);
    const sectionTitle = config?.title ?? section;
    const showToc = article.toc.length >= 2;

    return (
        <ColumnLayout mobileColumn={isMobile ? 'article' : 'nav'}>
            <Column id="nav" width="260px" toolbar={<span className="text-sm">{sectionTitle}</span>}>
                <SectionNav section={section} articles={siblings} activeSlug={article.slug} />
            </Column>
            <Column
                id="article"
                width="flex"
                onBack={() => history.back()}
                toolbar={
                    <SupportBreadcrumb
                        trail={[
                            { label: 'Help Center', to: '/support' },
                            { label: sectionTitle, to: `/support/${section}` },
                            { label: article.title },
                        ]}
                    />
                }
            >
                <div className="h-full overflow-y-auto">
                    <div className="mx-auto max-w-[70ch] px-6 py-8">
                        <h1 className="text-3xl font-bold mb-1">{article.title}</h1>
                        {article.updated && (
                            <p className="text-sm text-muted-foreground mb-6">Updated {article.updated}</p>
                        )}
                        <ArticleContent body={body} className="eigen-prose" />

                        {related.length > 0 && (
                            <div className="mt-12 pt-6 border-t">
                                <h2 className="text-sm font-medium text-muted-foreground mb-2">Related</h2>
                                <ul className="space-y-1">
                                    {related.map((r) => {
                                        const [s, f] = r.slug.split('/');
                                        return (
                                            <li key={r.slug}>
                                                <Link
                                                    to="/support/$section/$article"
                                                    params={{ section: s, article: f }}
                                                    className="text-link hover:underline"
                                                >
                                                    {r.title}
                                                </Link>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        )}
                    </div>
                </div>
            </Column>
            {showToc && !isMobile && (
                <Column id="toc" width="260px" toolbar={<span className="text-sm">On this page</span>}>
                    <ArticleToc toc={article.toc} />
                </Column>
            )}
        </ColumnLayout>
    );
}
```

- [ ] **Step 2: Type-check and commit**

Run: `cd apps/index && bunx tsc --noEmit`, then:
```bash
git add apps/index/src/components/support/support-article.tsx
git commit -m "feat(index): add help center article page"
```

### Task 2.10: The support routes

**Files:**
- Create: `apps/index/src/routes/support.tsx`
- Create: `apps/index/src/routes/support.index.tsx`
- Create: `apps/index/src/routes/support.$section.tsx`
- Create: `apps/index/src/routes/support.$section.$article.tsx`

- [ ] **Step 1: Create the layout route**

Create `apps/index/src/routes/support.tsx`:
```typescript
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SupportShell } from '../components/support/support-shell';

export const Route = createFileRoute('/support')({
    component: () => (
        <SupportShell>
            <Outlet />
        </SupportShell>
    ),
});
```

- [ ] **Step 2: Create the landing route**

Create `apps/index/src/routes/support.index.tsx`:
```typescript
import { createFileRoute } from '@tanstack/react-router';
import { SupportLanding } from '../components/support/support-landing';

export const Route = createFileRoute('/support/')({
    component: SupportLanding,
    head: () => ({
        meta: [
            { title: 'Help Center - eigen' },
            { name: 'description', content: 'Help and documentation for Eigen.' },
        ],
    }),
});
```

- [ ] **Step 3: Create the section route**

Create `apps/index/src/routes/support.$section.tsx`:
```typescript
import { createFileRoute, useParams } from '@tanstack/react-router';
import { getSupportArticles } from '../content/manifest';
import { SupportSection } from '../components/support/support-section';
import { getSection } from '../components/support/sections';

export const Route = createFileRoute('/support/$section')({
    component: SectionComponent,
    head: ({ params }) => {
        const section = getSection(params.section);
        return { meta: [{ title: `${section?.title ?? params.section} - Eigen Help` }] };
    },
});

function SectionComponent() {
    const { section } = useParams({ from: '/support/$section' });
    const articles = getSupportArticles().filter((a) => a.section === section);
    return <SupportSection section={section} articles={articles} />;
}
```

- [ ] **Step 4: Create the article route**

Create `apps/index/src/routes/support.$section.$article.tsx`:
```typescript
import { createFileRoute, useParams } from '@tanstack/react-router';
import { getArticleBody, getSupportArticle, getSupportArticles } from '../content/manifest';
import { SupportArticle } from '../components/support/support-article';

export const Route = createFileRoute('/support/$section/$article')({
    component: ArticleComponent,
    head: ({ params }) => {
        const article = getSupportArticle(params.section, params.article);
        if (!article) return { meta: [{ title: 'Article not found - Eigen Help' }] };
        return {
            meta: [
                { title: `${article.title} - Eigen Help` },
                { name: 'description', content: article.description },
                { property: 'og:title', content: article.title },
                { property: 'og:description', content: article.description },
                { property: 'og:type', content: 'article' },
            ],
        };
    },
});

function ArticleComponent() {
    const { section, article: file } = useParams({ from: '/support/$section/$article' });
    const article = getSupportArticle(section, file);
    const body = article ? getArticleBody('support', article.slug) : undefined;

    if (!article || !body) {
        return <div className="p-8 text-muted-foreground">Article not found.</div>;
    }

    const siblings = getSupportArticles().filter((a) => a.section === article.section);
    const bySlug = new Map(getSupportArticles().map((a) => [a.slug, a]));
    const related = article.related.map((slug) => bySlug.get(slug)).filter((a) => a !== undefined);

    return <SupportArticle article={article} body={body} siblings={siblings} related={related} />;
}
```

- [ ] **Step 5: Build content, type-check, and verify in the dev server**

Run:
```bash
cd apps/index && bun run scripts/build-content.ts && bunx tsc --noEmit && bun run dev
```
Open `http://localhost:3000/support`, click into `Getting started`, open the welcome article. Expected: landing grid renders, section page renders with the nav column + breadcrumb toolbar, article page renders with 3 columns matching the app layout. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add apps/index/src/routes/support.tsx apps/index/src/routes/support.index.tsx apps/index/src/routes/support.$section.tsx apps/index/src/routes/support.$section.$article.tsx
git commit -m "feat(index): add help center routes"
```

### Task 2.11: Seed content

**Files:**
- Create: `apps/index/src/data/support/drive/share-a-file.md`
- Create: `apps/index/src/data/support/drive/stop-sharing.md`
- Create: `apps/index/src/data/support/mail/filters-and-labels.md`
- Create: `apps/index/src/data/support/connect/mount-drive-on-your-computer.md`
- Create: `apps/index/src/data/support/connect/use-another-mail-app.md`
- Create: `apps/index/src/data/support/connect/use-another-calendar-app.md`

- [ ] **Step 1: Create the Drive articles**

`apps/index/src/data/support/drive/share-a-file.md`:
```markdown
---
title: "Share a file or folder in Drive"
description: "Share Drive items with people and teams, and choose their permission level."
type: how-to
category: Sharing
tags: [sharing, permissions, links]
related: [drive/stop-sharing]
order: 10
updated: 2026-05-20
---

You can share any file or folder in Drive with other people in your organisation.

## Share an item

1. Open Drive and find the file or folder.
2. Hover the row and click the **Share** icon.
3. Enter the person or team to share with.
4. Choose a permission level and confirm.

## Permission levels

- **Viewer** — can open and download, but not change.
- **Editor** — can open, change, and re-share.

Shared items appear for the other person under **Shared with me**.
```

`apps/index/src/data/support/drive/stop-sharing.md`:
```markdown
---
title: "Stop sharing a file"
description: "Remove someone's access to a file or folder you previously shared."
type: how-to
category: Sharing
tags: [sharing, permissions]
related: [drive/share-a-file]
order: 20
updated: 2026-05-20
---

When you no longer want someone to have access to an item, remove them from its
share list.

## Remove access

1. Open the file or folder's **Share** dialog.
2. Find the person or team in the list.
3. Remove them and confirm.

The item immediately disappears from their **Shared with me**.
```

- [ ] **Step 2: Create the Mail article**

`apps/index/src/data/support/mail/filters-and-labels.md`:
```markdown
---
title: "Set up email filters and labels"
description: "Automatically sort incoming mail with filters and organise it with labels."
type: how-to
category: Organising
tags: [filters, labels, organising]
order: 10
updated: 2026-05-20
---

Filters move, label, or flag incoming messages automatically so your inbox stays
organised.

## Create a filter

1. Open Mail settings and go to **Filters**.
2. Add a filter and set its conditions (sender, subject, and so on).
3. Choose what the filter does — apply a label, move the message, or mark it read.

## Labels

Labels are tags you can apply to messages. A message can carry several labels and
still stay in your inbox.
```

- [ ] **Step 3: Create the Connect articles**

`apps/index/src/data/support/connect/mount-drive-on-your-computer.md`:
```markdown
---
title: "Mount your Drive on your computer"
description: "Access your Eigen Drive files from your computer's file manager over WebDAV."
type: how-to
tags: [webdav, drive, desktop]
related: [connect/use-another-mail-app, connect/use-another-calendar-app]
order: 10
updated: 2026-05-20
---

Eigen Drive speaks WebDAV, so you can mount it as a network location on your
computer and use your files from Finder, File Explorer, or any WebDAV client.

## Connect

1. In Drive, open the mount you want and copy its WebDAV address.
2. In your file manager, add a network location and paste the address.
3. Sign in with your Eigen email and an app password.

## App passwords

Create an app password in your account security settings rather than using your
main password — you can revoke it independently at any time.
```

`apps/index/src/data/support/connect/use-another-mail-app.md`:
```markdown
---
title: "Use Eigen Mail with another mail app"
description: "Connect Apple Mail, Thunderbird, or any IMAP client to your Eigen mailbox."
type: how-to
tags: [imap, smtp, mail, desktop]
related: [connect/mount-drive-on-your-computer, connect/use-another-calendar-app]
order: 20
updated: 2026-05-20
---

Eigen Mail works with any standard mail app over IMAP (for reading) and SMTP
(for sending).

## Connect

1. In your mail app, add an account and choose manual / IMAP setup.
2. Enter your Eigen email address and an app password.
3. Use your Eigen server's IMAP and SMTP host names and standard secure ports.

Your folders and messages sync both ways — changes in the external app appear in
Eigen Mail and vice versa.
```

`apps/index/src/data/support/connect/use-another-calendar-app.md`:
```markdown
---
title: "Use Eigen Calendar with another calendar app"
description: "Connect an external calendar app to your Eigen calendars over CalDAV."
type: how-to
tags: [caldav, calendar, desktop]
related: [connect/use-another-mail-app, connect/mount-drive-on-your-computer]
order: 30
updated: 2026-05-20
---

Eigen Calendar speaks CalDAV, so your events stay in sync with any CalDAV-capable
calendar app.

## Connect

1. In your calendar app, add a CalDAV account.
2. Enter your Eigen CalDAV address, your email, and an app password.
3. Choose which calendars to sync.

Events you create or change in either place sync automatically.
```

- [ ] **Step 4: Build content and verify**

Run: `cd apps/index && bun run scripts/build-content.ts`
Expected: prints `Content build: 2 blog posts, 7 support articles`.

- [ ] **Step 5: Verify in the dev server**

Run: `cd apps/index && bun run dev` — open `/support`, check the Drive and Connecting-external-apps sections, open an article, confirm related links and the TOC work. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add apps/index/src/data/support
git commit -m "feat(index): add help center seed content"
```

---

# Phase 3 — Search (Pagefind)

Phase 3 adds client-side search over the built HTML. Pagefind runs after the prerender pass, indexes the static article pages, and ships a sharded index served as static files. **Search works only in a production build** (`bun run build`), not `bun run dev` — the search UI degrades gracefully when the index is absent.

### Task 3.1: Add Pagefind to the build

**Files:**
- Modify: `apps/index/package.json`
- Modify: `apps/index/src/components/support/support-article.tsx`

- [ ] **Step 1: Install Pagefind**

Run: `cd apps/index && bun add -d pagefind`

- [ ] **Step 2: Run Pagefind after the prerender pass**

In `apps/index/package.json`, change the `postbuild` script to:
```json
    "postbuild": "bun run scripts/prerender.tsx && bunx pagefind --site ../../dist/index",
```

- [ ] **Step 3: Mark the article body as the search target**

In `apps/index/src/components/support/support-article.tsx`, add `data-pagefind-body` to the inner content wrapper so Pagefind indexes article bodies only (not the nav/landing chrome). Change the content `<div>` inside the `article` Column:
```typescript
                    <div className="mx-auto max-w-[70ch] px-6 py-8" data-pagefind-body>
```

- [ ] **Step 4: Verify the build produces a Pagefind index**

Run: `cd apps/index && bun run build`
Expected: after the build, `dist/index/pagefind/pagefind.js` and `dist/index/pagefind/` index files exist.

- [ ] **Step 5: Commit**

```bash
git add apps/index/package.json apps/index/src/components/support/support-article.tsx bun.lock
git commit -m "build(index): index the help center with Pagefind"
```

### Task 3.2: The search dialog

**Files:**
- Create: `apps/index/src/components/support/support-search.tsx`
- Modify: `apps/index/src/components/support/support-shell.tsx`
- Modify: `apps/index/src/components/support/support-header.tsx`
- Modify: `apps/index/src/components/support/support-landing.tsx`

- [ ] **Step 1: Write the search component**

Create `apps/index/src/components/support/support-search.tsx`:
```typescript
import { Search } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

type PagefindHit = { url: string; meta: { title?: string }; excerpt: string };

const SearchContext = createContext<{ open: () => void }>({ open: () => {} });
export function useSupportSearch() {
    return useContext(SearchContext);
}

// Lazily load the Pagefind runtime. It only exists in a production build; in dev
// this import 404s and search reports itself unavailable.
let pagefindPromise: Promise<{ search: (q: string) => Promise<{ results: { data: () => Promise<PagefindHit> }[] }> }> | null = null;
async function getPagefind() {
    if (!pagefindPromise) {
        pagefindPromise = import(/* @vite-ignore */ `${import.meta.env.BASE_URL}pagefind/pagefind.js`);
    }
    return pagefindPromise;
}

export function SupportSearchProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState<PagefindHit[]>([]);
    const [unavailable, setUnavailable] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setIsOpen(true);
            }
            if (e.key === 'Escape') setIsOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => {
        if (isOpen) inputRef.current?.focus();
    }, [isOpen]);

    useEffect(() => {
        if (!query.trim()) {
            setHits([]);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const pagefind = await getPagefind();
                const result = await pagefind.search(query);
                const data = await Promise.all(result.results.slice(0, 8).map((r) => r.data()));
                if (!cancelled) setHits(data);
            } catch {
                if (!cancelled) setUnavailable(true);
            }
        }, 150);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query]);

    return (
        <SearchContext.Provider value={{ open: () => setIsOpen(true) }}>
            {children}
            {isOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
                    onClick={() => setIsOpen(false)}
                >
                    <div
                        className="w-full max-w-xl rounded-lg border bg-background shadow-lg"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center gap-2 border-b px-3">
                            <Search className="h-4 w-4 text-muted-foreground" />
                            <input
                                ref={inputRef}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search help articles…"
                                className="h-12 flex-1 bg-transparent outline-none"
                            />
                        </div>
                        <div className="max-h-[50vh] overflow-y-auto p-2">
                            {unavailable && (
                                <p className="p-3 text-sm text-muted-foreground">
                                    Search is available in the built site.
                                </p>
                            )}
                            {!unavailable && query.trim() && hits.length === 0 && (
                                <p className="p-3 text-sm text-muted-foreground">No results.</p>
                            )}
                            {hits.map((hit) => (
                                <a
                                    key={hit.url}
                                    href={hit.url}
                                    className="block rounded px-3 py-2 hover:bg-muted"
                                >
                                    <div className="font-medium">{hit.meta.title ?? hit.url}</div>
                                    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Pagefind excerpt */}
                                    <div
                                        className="text-sm text-muted-foreground line-clamp-2"
                                        dangerouslySetInnerHTML={{ __html: hit.excerpt }}
                                    />
                                </a>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </SearchContext.Provider>
    );
}

// A search-box-styled button that opens the dialog.
export function SearchTrigger({ className }: { className?: string }) {
    const { open } = useSupportSearch();
    return (
        <button
            type="button"
            onClick={open}
            className={className ?? 'flex items-center gap-2 text-sm text-muted-foreground'}
        >
            <Search className="h-4 w-4" />
            Search help articles…
        </button>
    );
}
```

- [ ] **Step 2: Wrap the shell with the search provider**

In `apps/index/src/components/support/support-shell.tsx`, import the provider and wrap the content. Add the import:
```typescript
import { SupportSearchProvider } from './support-search';
```
Wrap the existing `<div className="flex flex-col h-dvh">…</div>` so the return becomes:
```typescript
    return (
        <LayoutContext.Provider value={layout}>
            <SupportSearchProvider>
                <div className="flex flex-col h-dvh">
                    <SupportHeader />
                    <div className="flex flex-1 overflow-hidden">{children}</div>
                </div>
            </SupportSearchProvider>
        </LayoutContext.Provider>
    );
```

- [ ] **Step 3: Add a search trigger to the header**

In `apps/index/src/components/support/support-header.tsx`, import `SearchTrigger` and place it before the `flex-1` spacer. Add:
```typescript
import { SearchTrigger } from './support-search';
```
Replace the header's inner row content so it reads:
```typescript
            <div className="flex h-12 items-center px-4 gap-4">
                <Link to="/support" className="font-semibold">
                    eigen · Help Center
                </Link>
                <SearchTrigger className="flex items-center gap-2 rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/80 hover:bg-white/20" />
                <div className="flex-1" />
                <Button asChild variant="ghost" size="sm" className="text-white hover:bg-primary/20 hover:text-white">
                    <a href={getSpaceAppUrl()}>Sign in</a>
                </Button>
            </div>
```

- [ ] **Step 4: Add a hero search box to the landing page**

In `apps/index/src/components/support/support-landing.tsx`, import `SearchTrigger` and render it under the hero heading. Add the import:
```typescript
import { SearchTrigger } from './support-search';
```
Immediately after the `<h1>How can we help?</h1>`, add:
```typescript
                <div className="mx-auto max-w-md mb-12">
                    <SearchTrigger className="flex w-full items-center gap-2 rounded-lg border px-4 py-3 text-muted-foreground hover:bg-muted" />
                </div>
```
Remove the `mb-10` from the `<h1>` (the search box now provides the spacing) — change it to `mb-6`.

- [ ] **Step 5: Type-check**

Run: `cd apps/index && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify search in a built preview**

Run: `cd apps/index && bun run build && bunx vite preview --outDir ../../dist/index`
Open the preview URL, go to `/support`, press `Cmd/Ctrl+K`, search for "share". Expected: results list links to the Drive sharing article. Stop the preview.

- [ ] **Step 7: Commit**

```bash
git add apps/index/src/components/support/support-search.tsx apps/index/src/components/support/support-shell.tsx apps/index/src/components/support/support-header.tsx apps/index/src/components/support/support-landing.tsx
git commit -m "feat(index): add help center search dialog"
```

---

# Phase 4 — Contextual help and the authoring guide

Phase 4 adds the reusable in-product help link, wires one example, and writes the authoring guide. `getHelpUrl` already exists (Task 2.1).

### Task 4.1: The `HelpLink` component and an example link

**Files:**
- Create: `packages/ui/src/components/help-link.tsx`
- Modify: one in-app location (the Drive share dialog — located in Step 2)

- [ ] **Step 1: Create the `HelpLink` component**

Create `packages/ui/src/components/help-link.tsx`:
```typescript
import { getHelpUrl } from '@workspace/lib/api';
import { CircleHelp } from 'lucide-react';

// A small contextual "Learn more" link from inside an app into a help article.
// `section` and `slug` map to /support/[section]/[slug].
export function HelpLink({ section, slug, label = 'Learn more' }: { section: string; slug: string; label?: string }) {
    return (
        <a
            href={getHelpUrl(section, slug)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
            <CircleHelp className="h-3.5 w-3.5" />
            {label}
        </a>
    );
}
```

- [ ] **Step 2: Wire one example into the Drive share dialog**

Locate the Drive share dialog: `grep -rl "withWritePermission\|Share with\|shareDialog\|ShareDialog" packages/ui/src apps/drive/src` and find the component that renders the share UI (a dialog letting the user pick people/permissions).

In that component's JSX, near the dialog's title or footer, add:
```typescript
import { HelpLink } from '@workspace/ui/components/help-link';
```
and render:
```typescript
<HelpLink section="drive" slug="share-a-file" />
```

If no clear share dialog is found, instead add the `HelpLink` to the Drive list toolbar in `packages/ui/src/components/layout/drive/drive-list.tsx` near the breadcrumb — the goal of this step is one working, visible example of the pattern.

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/help-link.tsx
git add -A  # the one modified app file located in Step 2
git commit -m "feat(ui): add HelpLink component and a contextual help example"
```

### Task 4.2: The authoring guide

**Files:**
- Create: `docs/HELP_AUTHORING.md`

- [ ] **Step 1: Write the authoring guide**

Create `docs/HELP_AUTHORING.md`:
```markdown
# Authoring Help Center Articles

Help center articles live in `apps/index/src/data/support/` and are published at
`/support` when the `index` app is built. This guide explains how to add and edit them.

## Where files go

- One Markdown file per article: `apps/index/src/data/support/<section>/<slug>.md`.
- The **folder** is the section (`drive`, `mail`, `connect`, …). See the section list
  in `apps/index/src/components/support/sections.ts`.
- The **filename** is the article's permanent slug — its URL is
  `/support/<section>/<slug>`. Never rename a published file; it breaks deep links.
- Images go in `apps/index/public/data/support/media/<section>/<slug>/`.

## Frontmatter

Every article starts with a YAML frontmatter block. It is validated at build time —
a missing or malformed field fails the build.

| Field | Required | Notes |
|-------|----------|-------|
| `title` | yes | The H1, page title, and search result title. |
| `description` | yes | One-sentence answer; meta description and search snippet. |
| `type` | yes | `overview`, `how-to`, `troubleshooting`, `faq`, or `reference`. |
| `category` | no | Groups articles in the section sidebar. |
| `tags` | no | Used for the related-articles fallback. |
| `related` | no | Explicit related article paths, e.g. `[drive/stop-sharing]`. |
| `order` | no | Sort weight within the section (default 100). |
| `updated` | no | `YYYY-MM-DD`; shown on the page. |
| `draft` | no | `true` excludes the article from the build. |

Example:

\`\`\`yaml
---
title: "Share a file or folder in Drive"
description: "Share Drive items with people and teams, and choose their permission level."
type: how-to
category: Sharing
tags: [sharing, permissions]
related: [drive/stop-sharing]
order: 10
updated: 2026-05-20
---
\`\`\`

## Writing the body

- Use `##` and `###` headings — they build the on-this-page table of contents.
- Keep paragraphs short; turn sequences into numbered lists.
- Related articles are the explicit `related` list, or — if omitted — the
  same-section articles that share the most `tags`.

## Media

Embed images and video with the media-grid syntax:

\`\`\`html
<media-grid columns="2">
  <media src="/data/support/media/drive/share-a-file/dialog.webp" type="image" caption="The share dialog" />
</media-grid>
\`\`\`

## Building and previewing

- `cd apps/index && bun run scripts/build-content.ts` regenerates the content.
- `bun run dev` previews the help center at `http://localhost:3000/support`.
- Search requires a production build (`bun run build`); it does not run under `dev`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/HELP_AUTHORING.md
git commit -m "docs: add help center authoring guide"
```

---

# Done criteria

Run from the repo root unless noted.

- [ ] **Full check passes:** `bun run check` — lint, typecheck, and tests all pass.
- [ ] **Content build works:** `cd apps/index && bun run scripts/build-content.ts` prints the blog + support counts and creates `src/content/.generated/`.
- [ ] **Production build works:** `cd apps/index && bun run build` completes; `dist/index/` contains prerendered `index.html` files whose `<div id="app">` holds real article HTML, plus `dist/index/pagefind/` and `dist/index/sitemap.xml`.
- [ ] **Blog still works:** `/blog` and individual posts render with full content and media grids.
- [ ] **Help center works:** `/support` shows the landing grid; section and article pages render with the `ColumnLayout` toolbars/breadcrumb matching Drive; related articles and the TOC work.
- [ ] **Search works** in a built preview: `Cmd/Ctrl+K` opens the dialog and returns article results.
- [ ] **Avatar menu:** the "Help" item appears in both `UserDropdown` and `GuestUserDropdown` and links to `/support`.
- [ ] **No regressions:** every app still type-checks (the `useMediaQuery` change is workspace-wide).

## Notes for the executor

- **Task order matters in Phase 1:** the content build (1.6) must run before the manifest loader (1.7) type-checks, because `manifest.ts` imports generated JSON.
- **The prerender (1.11) is the most integration-heavy task.** `renderToString` does not run effects, so no data fetching fires — the build renders the static view, which is correct. The plan prerenders `/blog/*` and `/support/*` only; `/` stays a client-rendered SPA, so the auth/query provider tree never has to be SSR-safe. If a `/blog` or `/support` component touches `window`/`document` *during render* (not in an effect), the prerender will throw — fix that component to be render-safe. Article bodies are eager-imported (synchronous), so there is no loader data to dehydrate and no hydration mismatch.
- **Search is production-only.** `bun run dev` has no Pagefind index; the dialog reports "available in the built site" — this is expected, not a bug.
