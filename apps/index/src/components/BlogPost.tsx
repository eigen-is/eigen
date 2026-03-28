import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { BlogPost as BlogPostType } from '../data/blog-posts';
import { MediaGrid } from './MediaGrid';
import { parseMediaGrids } from './parse-media-grids';

interface BlogPostProps {
    post: BlogPostType;
}

export function BlogPost({ post }: BlogPostProps) {
    const { content, mediaGrids } = useMemo(() => parseMediaGrids(post.content), [post.content]);

    return (
        <article className="blog-post">
            <h1 className="text-4xl font-bold mb-2">{post.title}</h1>

            <p className="text-sm text-muted-foreground mb-6">{post.date}</p>

            <div className="blog-content">
                <ReactMarkdown
                    components={{
                        p: ({ node, children, ...props }) => {
                            const text = children?.toString() || '';
                            const gridMatch = text.match(/^\[MEDIAGRID:(\d+)\]$/);
                            if (gridMatch) {
                                const gridIndex = parseInt(gridMatch[1], 10);
                                const gridData = mediaGrids[gridIndex];
                                if (gridData) {
                                    return <MediaGrid columns={gridData.columns} items={gridData.items} />;
                                }
                            }
                            return (
                                <p className="mb-4 leading-7" {...props}>
                                    {children}
                                </p>
                            );
                        },
                        h1: ({ node, ...props }) => <h1 className="text-3xl font-bold mt-8 mb-4" {...props} />,
                        h2: ({ node, ...props }) => <h2 className="text-2xl font-bold mt-8 mb-4" {...props} />,
                        h3: ({ node, ...props }) => <h3 className="text-xl font-semibold mt-6 mb-3" {...props} />,
                        ul: ({ node, ...props }) => (
                            <ul className="list-disc list-outside mb-4 space-y-2 pl-5" {...props} />
                        ),
                        ol: ({ node, ...props }) => (
                            <ol className="list-decimal list-outside mb-4 space-y-2 pl-5" {...props} />
                        ),
                        li: ({ node, ...props }) => <li className="leading-7" {...props} />,
                        a: ({ node, ...props }) => <a className="text-blue-600 hover:underline" {...props} />,
                        strong: ({ node, ...props }) => <strong className="font-semibold" {...props} />,
                        blockquote: ({ node, ...props }) => (
                            <blockquote className="border-l-4 border-border pl-4 italic my-4" {...props} />
                        ),
                        code: ({ node, ...props }) => {
                            const { inline, ...codeProps } = props as typeof props & { inline?: boolean };
                            return inline ? (
                                <code className="bg-muted px-1 py-0.5 rounded text-sm" {...codeProps} />
                            ) : (
                                <code
                                    className="block bg-muted p-4 rounded my-4 text-sm overflow-x-auto"
                                    {...codeProps}
                                />
                            );
                        },
                    }}
                >
                    {content}
                </ReactMarkdown>
            </div>
        </article>
    );
}
