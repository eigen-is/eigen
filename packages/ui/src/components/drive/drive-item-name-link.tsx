import { stripEigenExtension } from '@workspace/lib/types';
import { cn } from '@workspace/ui/lib/utils';

type DriveItemNameLinkProps = {
    name: string;
    href?: string;
    className?: string;
};

// Real anchor so cmd/middle-click opens in a new tab; plain clicks defer to the row/tile handler.
export function DriveItemNameLink({ name, href, className }: DriveItemNameLinkProps) {
    const label = stripEigenExtension(name);
    if (!href) return <span className={cn('truncate', className)}>{label}</span>;
    return (
        <a
            href={href}
            className={cn('truncate', className)}
            draggable={false}
            tabIndex={-1}
            onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                    e.stopPropagation();
                    return;
                }
                e.preventDefault();
            }}
            onAuxClick={(e) => {
                if (e.button === 1) e.stopPropagation();
            }}
        >
            {label}
        </a>
    );
}
