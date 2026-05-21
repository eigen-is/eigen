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

export type Crumb = { label: string; to?: string };

// Toolbar breadcrumb shared by the support and blog article layouts.
export function ArticleBreadcrumb({ trail }: { trail: Crumb[] }) {
    return (
        <Breadcrumb className="overflow-hidden">
            <BreadcrumbList>
                {trail.map((crumb, i) => {
                    const isLast = i === trail.length - 1;
                    return (
                        <Fragment key={crumb.label}>
                            {i > 0 && <BreadcrumbSeparator />}
                            <BreadcrumbItem>
                                {isLast || !crumb.to ? (
                                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                                ) : (
                                    <BreadcrumbLink asChild>
                                        <Link to={crumb.to}>{crumb.label}</Link>
                                    </BreadcrumbLink>
                                )}
                            </BreadcrumbItem>
                        </Fragment>
                    );
                })}
            </BreadcrumbList>
        </Breadcrumb>
    );
}
