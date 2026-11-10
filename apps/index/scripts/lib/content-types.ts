// The shapes of the site's generated content: the frontmatter a help article or a blog post must have, and the
// manifests, bodies, changelog and license lists the build writes. The build scripts and the pages share them,
// so a field added here reaches both.

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
    // Extra section ids this article is also listed in (without changing its canonical URL).
    crossSections: z.array(z.string()).default([]),
    order: z.number().default(100),
    updated: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'updated must be YYYY-MM-DD')
        .optional(),
    draft: z.boolean().default(false),
});
export type SupportFrontmatter = z.infer<typeof supportFrontmatterSchema>;

// Blog post frontmatter — the blog keeps id-as-slug; date comes from the filename.
export const blogFrontmatterSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    // A path under public/ such as /data/blog/media/<folder>/<image>.webp, shown big on the post and the overview.
    cover: z.string().startsWith('/').optional(),
    draft: z.boolean().default(false),
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
    cover?: string; // blog only — the post's cover image
    toc: TocEntry[];
    related: string[]; // resolved slugs
    crossSections: string[]; // support: extra sections this article is also listed in
};

export type ContentManifest = { articles: ArticleMeta[] };

// The per-article generated body file.
export type ArticleBody = { html: string; mediaGrids: MediaGridData[] };

// The changelog body, plus one entry per release for the page's table of contents. The date is a short
// day and month such as "3 Nov", and Unreleased has none.
export type ChangelogVersion = { id: string; version: string; date?: string };
export type ChangelogBody = ArticleBody & { versions: ChangelogVersion[] };

// The generated open-source license list (one entry per package), written by build-licenses.ts.
export type LicensePackage = { name: string; version: string; license: string; url: string };

// Projects eigen ports or forks code from without depending on them, so the dependency walk
// cannot find them. Hardcoded in build-licenses.ts; `note` says what was taken.
export type LicenseVendored = { name: string; license: string; url: string; note: string };

// The fonts packages/ui bundles. Each folder under packages/ui/src/assets/fonts holds its OFL.txt.
export type LicenseFont = Omit<LicenseVendored, 'note'>;
