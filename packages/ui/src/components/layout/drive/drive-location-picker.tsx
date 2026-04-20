import { useAuth } from '@workspace/lib/auth';
import { useBreadcrumb, useRootFolder } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@workspace/ui/components/breadcrumb';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, Download } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { DriveBrowser } from './drive-browser';

type DriveLocationPickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'save-as' | 'folder';
    onConfirm: (location: { ownerId: string; mountId: string; folderId: string; name?: string }) => void;
    onDownloadInstead?: () => void;
    title?: string;
    defaultName?: string;
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
    defaultMountId = 'default',
    defaultFolderId,
    nameLabel,
    confirmLabel,
}: DriveLocationPickerProps) {
    const { user } = useAuth();
    const [name, setName] = useState(defaultName);
    const [expanded, setExpanded] = useState(mode !== 'create');
    const [activeMountId, setActiveMountId] = useState(defaultMountId);
    const [activeOwnerId, setActiveOwnerId] = useState(user?.id ?? '');
    const [folderId, setFolderId] = useState<string | null>(defaultFolderId ?? null);

    const ownerId = user?.id ?? '';

    const { data: rootFolder } = useRootFolder(activeOwnerId || ownerId, activeMountId);
    const currentFolderId = folderId ?? rootFolder?.id ?? '';
    const { data: breadcrumbPaths = [] } = useBreadcrumb(activeOwnerId || ownerId, activeMountId, currentFolderId);

    useEffect(() => {
        if (!user) return;
        setName(defaultName);
        setExpanded(mode !== 'create');
        setActiveMountId(defaultMountId);
        setActiveOwnerId(user.id);
        setFolderId(defaultFolderId ?? null);
    }, [open, defaultName, mode, defaultMountId, defaultFolderId, user]);

    const handleFolderChange = useCallback((folder: DrivePath, mountId: string) => {
        setFolderId(folder.id);
        setActiveMountId(mountId);
        setActiveOwnerId(folder.ownerId);
    }, []);

    const handleSubmit = useCallback(() => {
        if (hasName && !name.trim()) return;
        onConfirm({
            ownerId: activeOwnerId || ownerId,
            mountId: activeMountId,
            folderId: currentFolderId,
            name: hasName ? name.trim() : undefined,
        });
        onOpenChange(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeOwnerId, ownerId, activeMountId, currentFolderId, name, onConfirm, onOpenChange]);

    if (!user) return null;

    const hasName = mode === 'create' || mode === 'save-as';
    const resolvedTitle =
        title ?? (mode === 'create' ? 'New item' : mode === 'save-as' ? 'Save to Drive' : 'Choose destination');
    const resolvedConfirmLabel =
        confirmLabel ?? (mode === 'create' ? 'Create' : mode === 'save-as' ? 'Save here' : 'Select');
    const resolvedNameLabel = nameLabel ?? (mode === 'save-as' ? 'Save as' : 'Name');

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                size={expanded ? undefined : 'sm'}
                className={cn('flex flex-col p-0 gap-0', expanded && 'h-[450px]')}
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
                            <Breadcrumb className="overflow-hidden flex-1">
                                <BreadcrumbList>
                                    {breadcrumbPaths.map((path, index) => (
                                        <Fragment key={path.id}>
                                            {index > 0 && <BreadcrumbSeparator />}
                                            <BreadcrumbItem>
                                                <BreadcrumbPage className="text-xs">
                                                    {path.name || 'Drive'}
                                                </BreadcrumbPage>
                                            </BreadcrumbItem>
                                        </Fragment>
                                    ))}
                                </BreadcrumbList>
                            </Breadcrumb>
                            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        </button>
                    </div>
                )}

                {expanded && (
                    <div className="flex-1 overflow-hidden border-t">
                        <DriveBrowser
                            ownerId={activeOwnerId || ownerId}
                            mode="folder"
                            selectedId={folderId}
                            onSelect={(path) => {
                                setFolderId(path.id);
                                setActiveOwnerId(path.ownerId);
                            }}
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
