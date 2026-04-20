import { useAuth } from '@workspace/lib/auth';
import { useBreadcrumb, useRootFolder } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, Download } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DriveBreadcrumb } from './drive-breadcrumb';
import { DriveBrowser } from './drive-browser';
import { useMountLabel } from './drive-mount-list';

type DriveLocationPickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'save-as' | 'folder';
    onConfirm: (location: { ownerId: string; mountId: string; folderId: string; name?: string }) => void;
    onDownloadInstead?: () => void;
    title?: string;
    defaultName?: string;
    defaultOwnerId?: string;
    defaultMountId?: string;
    defaultFolderId?: string;
    nameLabel?: string;
    confirmLabel?: string;
};

export function DriveLocationPicker({
    open,
    onOpenChange,
    mode,
    onConfirm,
    onDownloadInstead,
    title,
    defaultName = '',
    defaultOwnerId,
    defaultMountId = 'default',
    defaultFolderId,
    nameLabel,
    confirmLabel,
}: DriveLocationPickerProps) {
    const { user } = useAuth();
    const initialOwnerId = defaultOwnerId || user?.id || '';
    const [name, setName] = useState(defaultName);
    const [expanded, setExpanded] = useState(mode !== 'create');
    const [activeMountId, setActiveMountId] = useState(defaultMountId);
    const [activeOwnerId, setActiveOwnerId] = useState(initialOwnerId);
    const [folderId, setFolderId] = useState<string | null>(defaultFolderId ?? null);

    const resolvedOwnerId = activeOwnerId || user?.id || '';

    const { data: rootFolder } = useRootFolder(resolvedOwnerId, activeMountId);
    const mountLabel = useMountLabel(resolvedOwnerId, activeMountId);
    const currentFolderId = folderId ?? rootFolder?.id ?? '';
    const { data: breadcrumbPaths = [] } = useBreadcrumb(resolvedOwnerId, activeMountId, currentFolderId);

    useEffect(() => {
        if (!user) return;
        setName(defaultName);
        setExpanded(mode !== 'create');
        setActiveMountId(defaultMountId);
        setActiveOwnerId(defaultOwnerId || user.id);
        setFolderId(defaultFolderId ?? null);
    }, [open, defaultName, mode, defaultOwnerId, defaultMountId, defaultFolderId, user]);

    const handleFolderChange = useCallback((folder: DrivePath, mountId: string) => {
        setFolderId(folder.id);
        setActiveMountId(mountId);
        setActiveOwnerId(folder.ownerId);
    }, []);

    if (!user) return null;

    const hasName = mode === 'create' || mode === 'save-as';

    const handleSubmit = () => {
        if (hasName && !name.trim()) return;
        onConfirm({
            ownerId: resolvedOwnerId,
            mountId: activeMountId,
            folderId: currentFolderId,
            name: hasName ? name.trim() : undefined,
        });
        onOpenChange(false);
    };

    const resolvedTitle =
        title ?? (mode === 'create' ? 'New item' : mode === 'save-as' ? 'Save to Drive' : 'Choose destination');
    const resolvedConfirmLabel =
        confirmLabel ?? (mode === 'create' ? 'Create' : mode === 'save-as' ? 'Save here' : 'Select');
    const resolvedNameLabel = nameLabel ?? (mode === 'save-as' ? 'Save as' : 'Name');

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                size={expanded ? undefined : 'sm'}
                className={cn('flex flex-col p-0 gap-0 w-[860px] max-w-[90vw]', expanded && 'h-[450px]')}
            >
                <DialogHeader className="px-6 py-4 border-b">
                    <DialogTitle>{resolvedTitle}</DialogTitle>
                </DialogHeader>

                {hasName && (
                    <div className="px-6 pt-4 pb-2">
                        <Label htmlFor="picker-name" className="text-sm text-muted-foreground">
                            {resolvedNameLabel}
                        </Label>
                        <Input
                            id="picker-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="mt-1.5"
                            autoFocus
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && name.trim()) {
                                    e.preventDefault();
                                    handleSubmit();
                                }
                            }}
                        />
                    </div>
                )}

                {mode === 'create' && !expanded && (
                    <div className="px-6 pb-2">
                        <Label className="text-sm text-muted-foreground">Location</Label>
                        <button
                            type="button"
                            className="mt-1.5 flex w-full items-center gap-1.5 rounded-md border px-3 py-2 text-sm hover:bg-accent"
                            onClick={() => setExpanded(true)}
                        >
                            <DriveBreadcrumb
                                paths={breadcrumbPaths}
                                mountLabel={mountLabel}
                                className="flex-1"
                                itemClassName="text-xs"
                            />
                            <span className="text-xs text-muted-foreground">Change</span>
                            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        </button>
                    </div>
                )}

                {expanded && (
                    <div className="flex-1 overflow-hidden border-t">
                        <DriveBrowser
                            ownerId={resolvedOwnerId}
                            mode="folder"
                            onFolderChange={handleFolderChange}
                            defaultMountId={activeMountId}
                            defaultFolderId={folderId ?? undefined}
                            showNewFolder
                            className="h-full"
                        />
                    </div>
                )}

                <DialogFooter className="px-6 py-3 border-t flex-row justify-between sm:justify-between">
                    {onDownloadInstead ? (
                        <Button variant="outline" onClick={onDownloadInstead}>
                            <Download className="h-4 w-4 mr-2" />
                            Download instead
                        </Button>
                    ) : (
                        <div />
                    )}
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSubmit} disabled={hasName && !name.trim()}>
                            {resolvedConfirmLabel}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
