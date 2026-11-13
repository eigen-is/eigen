// The Location field of a folder picker, such as Save to Drive or a chat's new room: a bar that shows the chosen
// folder as a crumb row, with a Drive browser under it to pick another. The host owns the value and whether the
// browser is open. Open, the crumbs and New folder act on the browser, and the bar's toggle closes it.

import { useBreadcrumb, useResolvedDriveLocation } from '@workspace/lib/drive';
import type { DriveLocationValue } from '@workspace/lib/types/drive-view';
import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, FolderPlus } from 'lucide-react';
import { useState } from 'react';
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
    // False shows the browser alone, with no Location bar, for a picker that is always open, such as Save as.
    collapsible?: boolean;
    // Shows only the user's own drive, without team or shared mounts.
    ownMountsOnly?: boolean;
};

export function DriveLocationField({
    value,
    onChange,
    expanded,
    onExpandedChange,
    collapsible = true,
    ownMountsOnly,
}: DriveLocationFieldProps) {
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const { ownerId, mountId, folderId } = useResolvedDriveLocation(value);
    const mountLabel = useMountLabel(ownerId, mountId);
    const { data: breadcrumbPaths = [] } = useBreadcrumb(ownerId, mountId, folderId);

    return (
        <>
            {collapsible && (
                <div className="px-6 pb-2">
                    <Label className="text-sm text-muted-foreground">Location</Label>
                    {/* Collapsed, the toggle's hit area stretches over the whole bar. Open, it shrinks to its own box,
                        so the crumbs before it stay clickable. */}
                    <InfoBlock className="relative mt-1.5 w-full gap-1.5 text-sm hover:bg-muted">
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
                                className={cn(
                                    STRETCHED_TRIGGER_CLASS,
                                    'flex items-center gap-0.5',
                                    expanded && 'relative',
                                )}
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
                </div>
            )}

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
