// The crumb row above a Drive folder or file: the chain from the mount root down to the path, with
// the ancestors as links when the caller can navigate. Callers such as the folder list, the file view
// and the location field fetch the chain with useBreadcrumb. The server cuts another owner's chain at
// the first folder the viewer can't read. Such a chain leads with Shared with me when the viewer's
// Shared with me feed holds a path in it, and starts at its first folder when a public link opened it.

import { useAuth } from '@workspace/lib/auth';
import { useSharedPaths } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { sharedChainHead, stripEigenExtension } from '@workspace/lib/types/drive';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { cn } from '@workspace/ui/lib/utils';
import { Fragment } from 'react';

type DriveBreadcrumbProps = {
    paths: DrivePath[];
    mountLabel: string;
    onNavigate?: (path: DrivePath) => void;
    // Set where the app has a Shared with me page; elsewhere the crumb is plain text.
    onOpenSharedWithMe?: () => void;
    className?: string;
    itemClassName?: string;
};

export function DriveBreadcrumb({
    paths,
    mountLabel,
    onNavigate,
    onOpenSharedWithMe,
    className,
    itemClassName,
}: DriveBreadcrumbProps) {
    const { user } = useAuth();
    const head = sharedChainHead(paths);
    const { data: sharedWithMe = [] } = useSharedPaths(head ? (user?.id ?? '') : '', 'with-me');
    const sharedIds = new Set(sharedWithMe.map((shared) => shared.id));
    const viaShare = !!head && paths.some((path) => sharedIds.has(path.id));
    return (
        <Breadcrumb className={cn('overflow-hidden', className)}>
            <BreadcrumbList>
                {paths.length === 0 && (
                    <BreadcrumbItem>
                        <BreadcrumbPage className={itemClassName}>{mountLabel}</BreadcrumbPage>
                    </BreadcrumbItem>
                )}
                {viaShare && (
                    <BreadcrumbItem>
                        {onOpenSharedWithMe ? (
                            <BreadcrumbLink
                                onClick={onOpenSharedWithMe}
                                className={cn('cursor-pointer', itemClassName)}
                            >
                                Shared with me
                            </BreadcrumbLink>
                        ) : (
                            <span className={itemClassName}>Shared with me</span>
                        )}
                    </BreadcrumbItem>
                )}
                {paths.map((path, index) => {
                    const label = index === 0 && !head ? mountLabel : stripEigenExtension(path.name);
                    return (
                        <Fragment key={path.id}>
                            {(index > 0 || viaShare) && <BreadcrumbSeparator />}
                            <BreadcrumbItem>
                                {index === paths.length - 1 || !onNavigate ? (
                                    <BreadcrumbPage className={itemClassName}>{label}</BreadcrumbPage>
                                ) : (
                                    <BreadcrumbLink
                                        onClick={() => onNavigate(path)}
                                        className={cn('cursor-pointer', itemClassName)}
                                    >
                                        {label}
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
