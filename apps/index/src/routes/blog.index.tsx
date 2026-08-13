import { createFileRoute, Link } from '@tanstack/react-router';
import { formatDateOnly } from '@workspace/lib/date';
import { Column, ColumnLayout } from '@workspace/ui';
import { BlogPost } from '../components/blog-post';
import { useArticleBody } from '../content/use-article-body';
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
        ],
    }),
});

function BlogOverviewComponent() {
    const [latestPost, ...otherPosts] = getAllBlogPosts();
    const body = useArticleBody('blog', latestPost?.slug ?? '');

    return (
        <ColumnLayout>
            <Column id="blog" width="flex">
                <div className="h-full overflow-y-auto">
                    <div className="mx-auto w-full max-w-[70ch] px-6 py-10">
                        {latestPost && body && <BlogPost post={latestPost} body={body} />}

                        {otherPosts.length > 0 && (
                            <div className="mt-16 pt-8 border-t border-border">
                                <h2 className="text-2xl font-medium mb-6">Other Posts</h2>
                                <div className="space-y-8">
                                    {otherPosts.map((post) => (
                                        <article key={post.slug}>
                                            <h3 className="text-xl font-medium mb-1">
                                                <Link
                                                    to="/blog/$id"
                                                    params={{ id: post.slug }}
                                                    className="hover:text-link"
                                                >
                                                    {post.title}
                                                </Link>
                                            </h3>
                                            {post.date && (
                                                <p className="text-sm text-muted-foreground mb-2">
                                                    {formatDateOnly(post.date)}
                                                </p>
                                            )}
                                            <p className="text-foreground leading-7">{post.description}</p>
                                        </article>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
