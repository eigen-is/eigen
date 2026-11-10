// A blog post page: the date under a link back to the blog, the title, the cover, the body with a larger first
// paragraph, and a pager to the older and the newer post. It sits in the site's reading column with the table
// of contents in the gutter.

import { Link } from '@tanstack/react-router';
import { formatDateOnly } from '@workspace/lib/date';
import { cn } from '@workspace/ui/lib/utils';
import type { ArticleBody } from '../content/manifest';
import type { BlogPost as BlogPostType } from '../data/blog-posts';
import { ArticleBreadcrumb } from './article-breadcrumb';
import { ArticleContent } from './article-content';
import { ArticleToc } from './article-toc';
import { BlogCover } from './blog-cover';
import { ReadingLayout } from './reading-layout';
import { SitePage } from './site-page';

type BlogPostProps = {
    post: BlogPostType;
    body: ArticleBody;
    older?: BlogPostType;
    newer?: BlogPostType;
};

export function BlogPost({ post, body, older, newer }: BlogPostProps) {
    return (
        <SitePage toolbar={<ArticleBreadcrumb trail={[{ label: 'Blog', to: '/blog' }]} />}>
            <ReadingLayout aside={<ArticleToc toc={post.toc} />}>
                <article>
                    <h1 className="site-title">{post.title}</h1>
                    {post.date && <p className="mt-2 text-sm text-muted-foreground">{formatDateOnly(post.date)}</p>}
                    {post.cover && <BlogCover src={post.cover} className="mt-7" />}
                    <ArticleContent body={body} className="site-lead mt-8" />
                </article>
                <nav className="mt-14 grid grid-cols-2 gap-6 border-t pt-6">
                    {older ? <PagerLink label="Older" post={older} /> : <span />}
                    {newer ? <PagerLink label="Newer" post={newer} className="text-right" /> : <span />}
                </nav>
            </ReadingLayout>
        </SitePage>
    );
}

function PagerLink({ label, post, className }: { label: string; post: BlogPostType; className?: string }) {
    return (
        <Link to="/blog/$id" params={{ id: post.slug }} className={cn('group block', className)}>
            <span className="eigen-section-label mb-1 block">{label}</span>
            <span className="font-medium underline-offset-4 group-hover:underline">{post.title}</span>
        </Link>
    );
}
