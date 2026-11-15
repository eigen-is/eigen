// The shapes of the site's generated content: the frontmatter a help article, a blog post or an About page must
// have, and the manifests, bodies, changelog and license lists the build writes. The build scripts and the pages
// share them, so a field added here reaches both.

import { z } from 'zod';

// A heading in an article, used to build the on-this-page table of contents.
export type TocEntry = { id: string; text: string; level: number };

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

// Blog post frontmatter. The id is the post's slug, and its date comes from the file name.
export const blogFrontmatterSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    // A path under public/ such as /data/blog/media/<folder>/<image>.webp, shown big on the post and the overview.
    cover: z.string().startsWith('/').optional(),
    draft: z.boolean().default(false),
});

// About page frontmatter. The app comes from the file name and the order from the app registry, so a field such as
// `order` or `draft` is refused rather than ignored.
export const aboutFrontmatterSchema = z
    .object({
        title: z.string().min(1),
        description: z.string().min(1),
        // The overview's one line per app, keyed by the app's slug, such as `sheets`.
        rows: z.record(z.string(), z.string().min(1)).optional(),
    })
    .strict();

// One article in a generated manifest (metadata only, no body).
export type ArticleMeta = {
    slug: string;
    section: string;
    title: string;
    description: string;
    type?: string;
    category?: string;
    tags: string[];
    order: number;
    updated?: string;
    // A blog post's date and cover, and the About overview's line per app.
    date?: string;
    cover?: string;
    rows?: Record<string, string>;
    toc: TocEntry[];
    related: string[];
    crossSections: string[];
};

export type ContentManifest = { articles: ArticleMeta[] };

// A picture or a film of a media grid. The grid shows `thumbnail`, or a film's `poster`, and the lightbox the `src`.
export type MediaItem = {
    src: string;
    type: 'image' | 'video';
    caption?: string;
    thumbnail?: string;
    poster?: string;
};

export const gridColumns = ['1', '2', '3', '4', '5', '6'] as const;

export type MediaGridData = { columns: (typeof gridColumns)[number]; items: MediaItem[] };

// A caption as the Markdown renders it, and as the plain text an alt text, a label and the lightbox take.
export type MediaCaption = { html: string; text: string };

// A looping video's `src` names its files without their endings, and so does a video slide's.
export type MediaVideoData = { src: string; caption?: MediaCaption };

export type MediaCarouselData = {
    slides: { type: 'image' | 'video'; src: string; caption?: MediaCaption }[];
    autoplay: boolean;
    caption?: MediaCaption;
};

export type MediaBlock =
    | ({ kind: 'grid' } & MediaGridData)
    | ({ kind: 'video' } & MediaVideoData)
    | ({ kind: 'carousel' } & MediaCarouselData);

// The per-article generated body file. A `[BLOCK:n]` marker in the HTML stands where the page draws `media[n]`.
export type ArticleBody = { html: string; media: MediaBlock[] };

// The changelog body, plus one entry per release for the page's table of contents. The date is a short
// day and month such as "3 Nov", and Unreleased has none.
export type ChangelogVersion = { id: string; version: string; date?: string };
export type ChangelogBody = ArticleBody & { versions: ChangelogVersion[] };

// One package in the generated open-source license list.
export type LicensePackage = { name: string; version: string; license: string; url: string };

// A project eigen ports or forks code from without depending on it, which the dependency walk cannot find. `note`
// says what was taken.
export type LicenseVendored = { name: string; license: string; url: string; note: string };

// A font the UI package bundles, each with its OFL.txt beside it.
export type LicenseFont = Omit<LicenseVendored, 'note'>;
