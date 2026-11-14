// A blog post page: the title with its date, the cover, the body and a pager to the older and the newer post, under
// a breadcrumb back to the blog. It sits in the site's reading column with the table of contents in the gutter.

import { formatDateOnly } from '@workspace/lib/date';
import type { ArticleBody } from '../content/manifest';
import type { BlogPost as BlogPostType } from '../data/blog-posts';
import { ArticleBreadcrumb } from './article-breadcrumb';
import { ArticleContent } from './article-content';
import { ArticleToc } from './article-toc';
import { BlogCover } from './blog-cover';
import { PagerLink } from './pager-link';
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
        <SitePage toolbar={<ArticleBreadcrumb trail={[{ label: 'Blog', to: '/blog' }]} page={post.title} />}>
            <ReadingLayout aside={<ArticleToc toc={post.toc} />}>
                <article>
                    <h1 className="site-title">{post.title}</h1>
                    {post.date && <p className="mt-2 text-sm text-muted-foreground">{formatDateOnly(post.date)}</p>}
                    {post.cover && <BlogCover src={post.cover} className="mt-7" />}
                    <ArticleContent body={body} className="mt-8" />
                </article>
                <nav className="mt-14 grid grid-cols-2 gap-6 border-t pt-6">
                    {older ? (
                        <PagerLink
                            label="Older"
                            title={older.title}
                            link={{ to: '/blog/$id', params: { id: older.slug } }}
                        />
                    ) : (
                        <span />
                    )}
                    {newer ? (
                        <PagerLink
                            label="Newer"
                            title={newer.title}
                            link={{ to: '/blog/$id', params: { id: newer.slug } }}
                            className="text-right"
                        />
                    ) : (
                        <span />
                    )}
                </nav>
            </ReadingLayout>
        </SitePage>
    );
}
