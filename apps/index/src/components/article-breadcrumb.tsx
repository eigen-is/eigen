// The trail in a public page's toolbar, such as "Support › Sheets" on an article or "Blog" on a post. A crumb with a
// `to` links; a crumb with an icon is a Support section, drawn in medium weight in the page's current color. The
// page's own title is never a crumb. Support articles, sections and blog posts use it.

import { Link } from '@tanstack/react-router';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Fragment } from 'react';

export type Crumb = { label: string; to?: string; icon?: LucideIcon };

type ArticleBreadcrumbProps = {
    trail: Crumb[];
};

export function ArticleBreadcrumb({ trail }: ArticleBreadcrumbProps) {
    return (
        <Breadcrumb>
            <BreadcrumbList className="h-5 flex-nowrap gap-1.5 text-sm sm:gap-1.5">
                {trail.map(({ label, to, icon: Icon }, i) => (
                    <Fragment key={label}>
                        {i > 0 && <BreadcrumbSeparator className="[&>svg]:size-3 [&>svg]:opacity-60" />}
                        <BreadcrumbItem>
                            {to ? (
                                <BreadcrumbLink
                                    asChild
                                    className={cn(
                                        Icon &&
                                            'inline-flex items-center gap-1.5 font-medium text-(--app-current-color) hover:text-(--app-current-color) hover:opacity-75',
                                    )}
                                >
                                    <Link to={to} activeOptions={{ exact: true }}>
                                        {Icon && <Icon className="size-3.5" />}
                                        {label}
                                    </Link>
                                </BreadcrumbLink>
                            ) : (
                                label
                            )}
                        </BreadcrumbItem>
                    </Fragment>
                ))}
            </BreadcrumbList>
        </Breadcrumb>
    );
}
