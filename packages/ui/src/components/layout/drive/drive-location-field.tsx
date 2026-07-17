import { useAuth } from '@workspace/lib/auth';
import { useBreadcrumb, useRootFolder } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, FolderPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { InfoBlock } from '../info-block';
import { TooltipButton } from '../toolbar/tooltip-button';
import { DriveBreadcrumb } from './drive-breadcrumb';
import { DriveBrowser } from './drive-browser';
import { useMountLabel } from './drive-mount-list';

export type DriveLocationValue = { ownerId: string; mountId: string; folderId: string };

type DriveLocationFieldProps = {
    value: DriveLocationValue;
    onChange: (value: DriveLocationValue) => void;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    // When false the collapsible breadcrumb header is hidden and only the browser shows
    // (the save-as flow, which is always expanded with no collapse affordance).
    collapsible?: boolean;
    // Restricts the mount list to the user's own drive, hiding team/shared mounts.
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
    const { user } = useAuth();
    const [createFolderOpen, setCreateFolderOpen] = useState(false);

    const resolvedOwnerId = value.ownerId || user?.id || '';
    const { data: rootFolder } = useRootFolder(resolvedOwnerId, value.mountId);
    const mountLabel = useMountLabel(resolvedOwnerId, value.mountId);
    const currentFolderId = value.folderId || rootFolder?.id || '';
    const { data: breadcrumbPaths = [] } = useBreadcrumb(resolvedOwnerId, value.mountId, currentFolderId);

    const handleFolderChange = useCallback(
        (folder: DrivePath, mountId: string) => {
            onChange({ ownerId: folder.ownerId, mountId, folderId: folder.id });
        },
        [onChange],
    );

    // Resolve the mount root into the controlled value so a submit made without browsing
    // (the collapsed create flow, where DriveBrowser never mounts to emit it) still carries
    // a concrete folderId. When expanded, DriveBrowser owns this the same way it always has.
    useEffect(() => {
        if (!expanded && !value.folderId && rootFolder) {
            onChange({ ...value, folderId: rootFolder.id });
        }
    }, [expanded, value, rootFolder, onChange]);

    return (
        <>
            {collapsible && (
                <div className="px-6 pb-2">
                    <Label className="text-sm text-muted-foreground">Location</Label>
                    <InfoBlock
                        className="mt-1.5 w-full cursor-pointer gap-1.5 text-sm hover:bg-muted"
                        onClick={() => onExpandedChange(!expanded)}
                    >
                        <div className="flex-1 min-w-0" onClick={expanded ? (e) => e.stopPropagation() : undefined}>
                            <DriveBreadcrumb
                                paths={breadcrumbPaths}
                                mountLabel={mountLabel}
                                onNavigate={expanded ? (path) => handleFolderChange(path, value.mountId) : undefined}
                                itemClassName="text-xs"
                            />
                        </div>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                            {expanded && (
                                <div onClick={(e) => e.stopPropagation()}>
                                    <TooltipButton
                                        icon={FolderPlus}
                                        tooltipText="New folder"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        onClick={() => setCreateFolderOpen(true)}
                                    />
                                </div>
                            )}
                            {!expanded && <span className="text-xs text-muted-foreground mr-1">Change</span>}
                            <ChevronDown
                                className={cn(
                                    'h-4 w-4 text-muted-foreground transition-transform duration-200',
                                    expanded && 'rotate-180',
                                )}
                            />
                        </div>
                    </InfoBlock>
                </div>
            )}

            {expanded && (
                <div className="flex-1 overflow-hidden border-t px-6 pb-2 pt-2">
                    <DriveBrowser
                        ownerId={value.ownerId}
                        mode="folder"
                        onFolderChange={handleFolderChange}
                        defaultMountId={value.mountId}
                        defaultFolderId={value.folderId || undefined}
                        showNewFolder
                        hideToolbar
                        hideHeader
                        ownMountsOnly={ownMountsOnly}
                        createFolderOpen={createFolderOpen}
                        onCreateFolderOpenChange={setCreateFolderOpen}
                        className="h-full"
                    />
                </div>
            )}
        </>
    );
}
