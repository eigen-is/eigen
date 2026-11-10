// The blog's overview page on the public site: a list row for each post, newest first, with its date in the left
// gutter. The list comes from the blog's content files, so the prerender has all of it, and every row links to its
// post.

import { createFileRoute, Link } from '@tanstack/react-router';
import { formatDateOnly } from '@workspace/lib/date';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { ReadingLayout } from '../components/reading-layout';
import { SitePage } from '../components/site-page';
import type { BlogPost } from '../data/blog-posts';
import { getAllBlogPosts } from '../data/blog-posts';

export const Route = createFileRoute('/blog/')({
    component: BlogOverviewComponent,
    head: () => ({
        meta: [
            { title: 'Blog - eigen' },
            {
                name: 'description',
                content:
                    'Read about the development of Eigen, a self-hosted alternative to Google Workspace where you control your data.',
            },
            { property: 'og:title', content: 'Blog - eigen' },
            {
                property: 'og:description',
                content:
                    'Read about the development of Eigen, a self-hosted alternative to Google Workspace where you control your data.',
            },
            { property: 'og:type', content: 'website' },
        ],
    }),
});

function BlogOverviewComponent() {
    const posts = getAllBlogPosts();

    return (
        <SitePage>
            <ReadingLayout>
                <h1 className="site-title">Blog</h1>
                <p className="mt-2 text-sm text-muted-foreground">Notes from building Eigen.</p>
                <div className="mt-6">
                    {posts.map((post, index) => (
                        <PostRow key={post.slug} post={post}>
                            <Link
                                to="/blog/$id"
                                params={{ id: post.slug }}
                                className={cn(
                                    'eigen-list-item -mx-(--app-gutter-x) block px-(--app-gutter-x) py-3.5',
                                    index > 0 && 'border-t',
                                )}
                            >
                                <PostText post={post} />
                            </Link>
                        </PostRow>
                    ))}
                </div>
            </ReadingLayout>
        </SitePage>
    );
}

// The date hangs in the left gutter; below 76rem there is none, and PostText shows it above the title instead.
function PostRow({ post, children }: { post: BlogPost; children: ReactNode }) {
    return (
        <div className="relative">
            {post.date && (
                <time className="absolute top-3.5 right-full mr-(--site-gap) hidden w-(--site-gutter) text-sm leading-7 text-muted-foreground tabular-nums min-[76rem]:block">
                    {formatDateOnly(post.date)}
                </time>
            )}
            {children}
        </div>
    );
}

function PostText({ post }: { post: BlogPost }) {
    return (
        <>
            {post.date && (
                <time className="block text-sm leading-7 text-muted-foreground tabular-nums min-[76rem]:hidden">
                    {formatDateOnly(post.date)}
                </time>
            )}
            <h2 className="text-xl leading-tight font-medium tracking-tight">{post.title}</h2>
            <p className="mt-1.5 text-muted-foreground">{post.description}</p>
        </>
    );
}
