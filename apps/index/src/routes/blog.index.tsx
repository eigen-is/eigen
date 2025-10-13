import {createFileRoute, Link} from '@tanstack/react-router'
import {getAllBlogPosts, getLatestBlogPost} from '../data/blog-posts';
import {BlogPost} from '../components/BlogPost';

export const Route = createFileRoute('/blog/')({
    component: BlogOverviewComponent,
})

function BlogOverviewComponent() {
    const latestPost = getLatestBlogPost();
    const allPosts = getAllBlogPosts();
    const otherPosts = allPosts.slice(1);

    return (
        <div className="min-h-screen bg-gray-50">
            <div className="container mx-auto px-4 py-8 max-w-3xl">
                <div className="mb-8">
                    <Link to="/" className="text-blue-600 hover:text-blue-800 hover:underline">
                        ← Back to home
                    </Link>
                </div>

                {latestPost && (
                    <BlogPost post={latestPost} />
                )}

                {otherPosts.length > 0 && (
                    <div className="mt-16 pt-8 border-t border-gray-300">
                        <h2 className="text-2xl font-bold mb-6">Other Posts</h2>
                        <div className="space-y-8">
                            {otherPosts.map(post => (
                                <article key={post.id}>
                                    <h3 className="text-xl font-semibold mb-1">
                                        <Link 
                                            to="/blog/$id" 
                                            params={{id: post.id}}
                                            className="hover:text-blue-600"
                                        >
                                            {post.title}
                                        </Link>
                                    </h3>
                                    <p className="text-sm text-gray-500 mb-2">{post.date}</p>
                                    <p className="text-gray-700 leading-7">{post.summary}</p>
                                </article>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
