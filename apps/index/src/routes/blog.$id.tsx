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
