// The Location field of a folder picker, such as Save to Drive or a chat's new room: a bar that shows the chosen
// folder as a crumb row, with a Drive browser under it to pick another. The host owns the value and whether the
// browser is open. Open, the crumbs and New folder act on the browser, and the bar's toggle closes it. A folder the
// host refuses shows the reason under the bar.

import { useBreadcrumb, useResolvedDriveLocation } from '@workspace/lib/drive';
import type { DriveLocationValue } from '@workspace/lib/types/drive-view';
import { Field, FieldError, FieldLabel } from '@workspace/ui/components/field';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, FolderPlus } from 'lucide-react';
import { useId, useState } from 'react';
import { InfoBlock, STRETCHED_TRIGGER_CLASS } from '../info-block';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { DriveBreadcrumb } from './drive-breadcrumb';
import { DriveBrowser } from './drive-browser';
import { useMountLabel } from './drive-mount-list';
import type { DriveSortControl } from './drive-table';

// Folders first, then by name, A to Z. The header that would change the sort is hidden.
const BY_NAME: DriveSortControl = { value: { key: 'name', dir: 'asc' }, onChange: () => {} };

type DriveLocationFieldProps = {
    value: DriveLocationValue;
    onChange: (value: DriveLocationValue) => void;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    // Shows only the user's own drive, without team or shared mounts.
    ownMountsOnly?: boolean;
    error?: string;
};

export function DriveLocationField({
    value,
    onChange,
    expanded,
    onExpandedChange,
    ownMountsOnly,
    error,
}: DriveLocationFieldProps) {
    const errorId = useId();
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const { ownerId, mountId, folderId } = useResolvedDriveLocation(value);
    const mountLabel = useMountLabel(ownerId, mountId);
    const { data: breadcrumbPaths = [] } = useBreadcrumb(ownerId, mountId, folderId);

    return (
        <>
            <Field className="px-6 pb-2">
                <FieldLabel>Location</FieldLabel>
                {/* Collapsed, the toggle's hit area stretches over the whole bar. Open, it shrinks to its own box,
                    so the crumbs before it stay clickable. */}
                <InfoBlock className="relative w-full gap-1.5 text-sm hover:bg-muted">
                    <div className="flex-1 min-w-0">
                        <DriveBreadcrumb
                            paths={breadcrumbPaths}
                            mountLabel={mountLabel}
                            onNavigate={
                                expanded
                                    ? (path) => onChange({ ownerId: path.ownerId, mountId, folderId: path.id })
                                    : undefined
                            }
                            itemClassName="text-xs"
                        />
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                        {expanded && (
                            <TooltipButton
                                icon={FolderPlus}
                                tooltipText="New folder"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => setCreateFolderOpen(true)}
                            />
                        )}
                        <button
                            type="button"
                            aria-label="Change location"
                            aria-expanded={expanded}
                            aria-invalid={!!error || undefined}
                            aria-describedby={error ? errorId : undefined}
                            className={cn(STRETCHED_TRIGGER_CLASS, 'flex items-center gap-0.5', expanded && 'relative')}
                            onClick={() => onExpandedChange(!expanded)}
                        >
                            {!expanded && <span className="text-xs text-muted-foreground mr-1">Change</span>}
                            <ChevronDown
                                className={cn(
                                    'h-4 w-4 text-muted-foreground transition-transform duration-200',
                                    expanded && 'rotate-180',
                                )}
                            />
                        </button>
                    </div>
                </InfoBlock>
                {error && <FieldError id={errorId}>{error}</FieldError>}
            </Field>

            {expanded && (
                <div className="flex-1 overflow-hidden border-t px-6 pb-2 pt-2">
                    <DriveBrowser
                        value={value}
                        onChange={onChange}
                        mode="folder"
                        hideToolbar
                        hideHeader
                        sort={BY_NAME}
                        ownMountsOnly={ownMountsOnly}
                        newFolder={{ open: createFolderOpen, onOpenChange: setCreateFolderOpen }}
                        className="h-full"
                    />
                </div>
            )}
        </>
    );
}
