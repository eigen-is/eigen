// The crumb row above a Drive folder or file: the chain from the mount root down to the path, with
// the ancestors as links when the caller can navigate. Callers such as the folder list, the file view
// and the location field fetch the chain with useBreadcrumb. The server cuts another owner's chain at
// the first folder the viewer can't read, so a chain that starts below a root leads with Shared with me.

import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
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
    className?: string;
    itemClassName?: string;
};

export function DriveBreadcrumb({ paths, mountLabel, onNavigate, className, itemClassName }: DriveBreadcrumbProps) {
    const fromRoot = paths.length === 0 || paths[0].parentId === null;
    return (
        <Breadcrumb className={cn('overflow-hidden', className)}>
            <BreadcrumbList>
                {paths.length === 0 && (
                    <BreadcrumbItem>
                        <BreadcrumbPage className={itemClassName}>{mountLabel}</BreadcrumbPage>
                    </BreadcrumbItem>
                )}
                {!fromRoot && (
                    <BreadcrumbItem>
                        <span className={itemClassName}>Shared with me</span>
                    </BreadcrumbItem>
                )}
                {paths.map((path, index) => {
                    const label = index === 0 && fromRoot ? mountLabel : stripEigenExtension(path.name);
                    return (
                        <Fragment key={path.id}>
                            {(index > 0 || !fromRoot) && <BreadcrumbSeparator />}
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
