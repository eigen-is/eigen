// The trail in a public page's toolbar, such as "Support › Sheets › Get started with Sheets" on an article or
// "Blog › Eigen: Vector" on a post. Each crumb links up the tree, and the last one names the page you are reading.
// Support articles, sections and blog posts use it.

import { Link } from '@tanstack/react-router';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { Fragment } from 'react';

type ArticleBreadcrumbProps = {
    trail: { label: string; to: string }[];
    page: string;
};

export function ArticleBreadcrumb({ trail, page }: ArticleBreadcrumbProps) {
    return (
        <Breadcrumb>
            <BreadcrumbList className="h-5 flex-nowrap gap-1.5 text-sm sm:gap-1.5">
                {trail.map(({ label, to }) => (
                    <Fragment key={to}>
                        <BreadcrumbItem className="shrink-0">
                            <BreadcrumbLink asChild>
                                <Link to={to} activeOptions={{ exact: true }}>
                                    {label}
                                </Link>
                            </BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator className="[&>svg]:size-3 [&>svg]:opacity-60" />
                    </Fragment>
                ))}
                <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate">{page}</BreadcrumbPage>
                </BreadcrumbItem>
            </BreadcrumbList>
        </Breadcrumb>
    );
}
