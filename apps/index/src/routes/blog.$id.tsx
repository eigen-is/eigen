// A blog post's page. It finds the post and its body, and hands them with the older and the newer post to the page
// that draws them. The prerender has the body inlined, so the first client render matches the server's. Each post
// mounts its own page, so the next one opens at the top.

import { createFileRoute, useParams } from '@tanstack/react-router';
import { ErrorState, LoadingState, useLayout } from '@workspace/ui/components/layout/app';
import { useEffect } from 'react';
import { BlogPost } from '../components/blog-post';
import { SitePage } from '../components/site-page';
import { useArticleBody } from '../content/use-article-body';
import { getAllBlogPosts, getBlogPost } from '../data/blog-posts';

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

    if (!post || !body) {
        return <SitePage>{post ? <LoadingState /> : <ErrorState />}</SitePage>;
    }

    // The posts run newest first, so the newer one stands before this post and the older one after.
    const posts = getAllBlogPosts();
    const index = posts.indexOf(post);
    return <BlogPost key={id} post={post} body={body} newer={posts[index - 1]} older={posts[index + 1]} />;
}
