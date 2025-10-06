import {createFileRoute, Link, useParams} from '@tanstack/react-router'
import {getBlogPost} from '../data/blog-posts';
import ReactMarkdown from 'react-markdown';

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

                <article className="blog-post">
                    <h1 className="text-4xl font-bold mb-2">{post.title}</h1>
                    <p className="text-sm text-gray-500 mb-8">{post.date}</p>
                    
                    <div className="blog-content">
                        <ReactMarkdown
                            components={{
                                h1: ({node, ...props}) => <h1 className="text-3xl font-bold mt-8 mb-4" {...props} />,
                                h2: ({node, ...props}) => <h2 className="text-2xl font-bold mt-8 mb-4" {...props} />,
                                h3: ({node, ...props}) => <h3 className="text-xl font-semibold mt-6 mb-3" {...props} />,
                                p: ({node, ...props}) => <p className="mb-4 leading-7" {...props} />,
                                ul: ({node, ...props}) => <ul className="list-disc list-inside mb-4 space-y-2" {...props} />,
                                ol: ({node, ...props}) => <ol className="list-decimal list-inside mb-4 space-y-2" {...props} />,
                                li: ({node, ...props}) => <li className="leading-7" {...props} />,
                                a: ({node, ...props}) => <a className="text-blue-600 hover:underline" {...props} />,
                                strong: ({node, ...props}) => <strong className="font-semibold" {...props} />,
                                blockquote: ({node, ...props}) => <blockquote className="border-l-4 border-gray-300 pl-4 italic my-4" {...props} />,
                                code: ({node, inline, ...props}) => 
                                    inline 
                                        ? <code className="bg-gray-200 px-1 py-0.5 rounded text-sm" {...props} />
                                        : <code className="block bg-gray-200 p-4 rounded my-4 text-sm overflow-x-auto" {...props} />,
                            }}
                        >
                            {post.content}
                        </ReactMarkdown>
                    </div>
                </article>
            </div>
        </div>
    );
}
