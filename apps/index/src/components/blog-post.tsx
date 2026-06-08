import { formatDate } from '@workspace/lib/date';
import type { ArticleBody } from '../content/manifest';
import type { BlogPost as BlogPostType } from '../data/blog-posts';
import { ArticleContent } from './article-content';

type BlogPostProps = { post: BlogPostType; body: ArticleBody };

export function BlogPost({ post, body }: BlogPostProps) {
    return (
        <article className="blog-post">
            <h1 className="text-4xl font-medium mb-2">{post.title}</h1>
            {post.date && (
                <p className="text-sm text-muted-foreground mb-6">last updated at: {formatDate(post.date)}</p>
            )}
            <ArticleContent body={body} className="eigen-prose" />
        </article>
    );
}
