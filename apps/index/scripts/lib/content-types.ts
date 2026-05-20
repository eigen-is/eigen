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
