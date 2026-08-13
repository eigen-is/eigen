import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
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
    return (
        <Breadcrumb className={cn('overflow-hidden', className)}>
            <BreadcrumbList>
                {paths.length === 0 && (
                    <BreadcrumbItem>
                        <BreadcrumbPage className={itemClassName}>{mountLabel}</BreadcrumbPage>
                    </BreadcrumbItem>
                )}
                {paths.map((path, index) => {
                    const label = index === 0 ? mountLabel : stripEigenExtension(path.name);
                    return (
                        <Fragment key={path.id}>
                            {index > 0 && <BreadcrumbSeparator />}
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
