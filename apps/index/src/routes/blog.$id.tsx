import {createFileRoute, Link, useParams} from '@tanstack/react-router'
import {getBlogPost} from '../data/blog-posts';
import {BlogPost} from '../components/BlogPost';

export const Route = createFileRoute('/blog/$id')({
    component: BlogPostComponent,
})

function BlogPostComponent() {
    const {id} = useParams({from: '/blog/$id'});
    const post = getBlogPost(id);

    if (!post) {
        return (
            <div className="min-h-screen bg-gray-50">
                <div className="container mx-auto px-4 py-8 max-w-3xl">
                    <div className="mb-8">
                        <Link to="/blog" className="text-blue-600 hover:text-blue-800 hover:underline">
                            ← Back to blog
                        </Link>
                    </div>
                    <h1 className="text-3xl font-bold mb-4">Post not found</h1>
                    <p className="text-gray-600">The blog post you're looking for doesn't exist.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50">
            <div className="container mx-auto px-4 py-8 max-w-3xl">
                <div className="mb-8">
                    <Link to="/blog" className="text-blue-600 hover:text-blue-800 hover:underline">
                        ← Back to blog
                    </Link>
                </div>

                <BlogPost post={post} />
            </div>
        </div>
    );
}
