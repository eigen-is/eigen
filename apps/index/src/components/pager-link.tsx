// One side of the pager at the end of a reading page: a small label such as "Older" or "Next" over the title of the
// page it leads to. Reading pages such as a blog post end with a pair of them.

import type { RegisteredRouter, ValidateLinkOptions } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';

type PagerLinkProps<TOptions = unknown> = {
    label: string;
    title: string;
    link: ValidateLinkOptions<RegisteredRouter, TOptions>;
    className?: string;
};

// The generic signature checks the caller's route and params; the body sees them as any link.
export function PagerLink<TOptions>(props: PagerLinkProps<TOptions>): ReactNode;
export function PagerLink({ label, title, link, className }: PagerLinkProps) {
    return (
        <Link {...link} className={cn('group block', className)}>
            <span className="eigen-section-label mb-1 block">{label}</span>
            <span className="font-medium underline-offset-4 group-hover:underline">{title}</span>
        </Link>
    );
}
