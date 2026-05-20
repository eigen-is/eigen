import { createFileRoute, Link } from '@tanstack/react-router';
import { BlogPost } from '../components/BlogPost';
import { getArticleBody } from '../content/manifest';
import { getAllBlogPosts } from '../data/blog-posts';

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
    const [latestPost, ...otherPosts] = getAllBlogPosts();
    const body = latestPost ? getArticleBody('blog', latestPost.slug) : undefined;

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
