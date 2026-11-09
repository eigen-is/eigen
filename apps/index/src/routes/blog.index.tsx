// The blog's overview page on the public site: a row for each post with its date in the left gutter, the newest
// post larger and with its cover, the others as list rows. The list comes from the blog's content files, so the
// prerender has all of it, and every row links to its post.

import { createFileRoute, Link } from '@tanstack/react-router';
import { formatDateOnly } from '@workspace/lib/date';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { BlogCover } from '../components/blog-cover';
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
    const [newest, ...older] = getAllBlogPosts();

    return (
        <SitePage>
            <ReadingLayout>
                <h1 className="text-4xl font-medium tracking-tight">Blog</h1>
                <p className="mt-2 text-muted-foreground">Notes from building Eigen.</p>
                {newest && (
                    <PostRow post={newest} className="mt-10" dateClassName="top-1">
                        <Link to="/blog/$id" params={{ id: newest.slug }} className="group block">
                            <PostText post={newest} className="text-3xl group-hover:underline" />
                            {newest.cover && <BlogCover src={newest.cover} className="mt-5" />}
                        </Link>
                    </PostRow>
                )}
                {older.map((post) => (
                    <PostRow key={post.slug} post={post} className="mt-2" dateClassName="top-3.5">
                        <Link
                            to="/blog/$id"
                            params={{ id: post.slug }}
                            className="eigen-list-item -mx-4 block px-4 py-3.5"
                        >
                            <PostText post={post} className="text-[1.375rem]" />
                        </Link>
                    </PostRow>
                ))}
            </ReadingLayout>
        </SitePage>
    );
}

type PostRowProps = {
    post: BlogPost;
    className: string;
    dateClassName: string;
    children: ReactNode;
};

// The date hangs in the left gutter; below 76rem there is none, and PostText shows it above the title instead.
function PostRow({ post, className, dateClassName, children }: PostRowProps) {
    return (
        <div className={cn('relative', className)}>
            {post.date && (
                <time
                    className={cn(
                        'absolute right-full mr-(--site-gap) hidden w-(--site-gutter) text-[0.8125rem] leading-7 text-muted-foreground tabular-nums min-[76rem]:block',
                        dateClassName,
                    )}
                >
                    {formatDateOnly(post.date)}
                </time>
            )}
            {children}
        </div>
    );
}

function PostText({ post, className }: { post: BlogPost; className: string }) {
    return (
        <>
            {post.date && (
                <time className="block text-[0.8125rem] leading-7 text-muted-foreground tabular-nums min-[76rem]:hidden">
                    {formatDateOnly(post.date)}
                </time>
            )}
            <h2 className={cn('leading-tight font-medium tracking-tight', className)}>{post.title}</h2>
            <p className="mt-1.5 text-muted-foreground">{post.description}</p>
        </>
    );
}
