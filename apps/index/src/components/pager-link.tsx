// One side of the pager at the end of a reading page: a small label such as "Older" or "Next" over the title of the
// page it leads to. Blog posts and the About pages end with a pair of them.

import { Link } from '@tanstack/react-router';
import { cn } from '@workspace/ui/lib/utils';

type PagerLinkProps = {
    label: string;
    title: string;
    to: string;
    className?: string;
};

export function PagerLink({ label, title, to, className }: PagerLinkProps) {
    return (
        <Link to={to} className={cn('group block', className)}>
            <span className="eigen-section-label mb-1 block">{label}</span>
            <span className="font-medium underline-offset-4 group-hover:underline">{title}</span>
        </Link>
    );
}
