import { createFileRoute, useParams } from '@tanstack/react-router';
import { Column, ColumnLayout, useLayout } from '@workspace/ui';
import { useEffect } from 'react';
import { ArticleBreadcrumb } from '../components/article-breadcrumb';
import { BlogPost } from '../components/blog-post';
import { useArticleBody } from '../content/use-article-body';
import { getBlogPost } from '../data/blog-posts';

export const Route = createFileRoute('/blog/$id')({
    component: BlogPostComponent,
    head: ({ params }) => {
        const post = getBlogPost(params.id);
        if (!post) return { meta: [{ title: 'Post not found - eigen blog' }] };
        return {
            meta: [
                { title: `${post.title} - eigen blog` },
                { name: 'description', content: post.description },
                { property: 'og:title', content: post.title },
                { property: 'og:description', content: post.description },
                { property: 'og:type', content: 'article' },
                { property: 'article:published_time', content: post.date },
            ],
        };
    },
});

function BlogPostComponent() {
    const { id } = useParams({ from: '/blog/$id' });
    const post = getBlogPost(id);
    const body = useArticleBody('blog', id);
    const { setDocumentTitle } = useLayout();

    useEffect(() => {
        setDocumentTitle(post?.title ?? '');
        return () => setDocumentTitle('');
    }, [post?.title, setDocumentTitle]);

    if (!post) {
        return <div className="p-8 text-muted-foreground">Post not found.</div>;
    }
    if (!body) {
        return <div className="p-8 text-muted-foreground">Loading…</div>;
    }

    return (
        <ColumnLayout>
            <Column
                id="post"
                width="flex"
                toolbar={
                    <div className="mx-auto w-full max-w-[70ch]">
                        <ArticleBreadcrumb trail={[{ label: 'Blog', to: '/blog' }, { label: post.title }]} />
                    </div>
                }
            >
                <div className="h-full overflow-y-auto">
                    <div className="mx-auto w-full max-w-[70ch] px-6 py-10">
                        <BlogPost post={post} body={body} />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
