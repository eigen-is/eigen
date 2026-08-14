import { useAuth } from '@workspace/lib/auth';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { cn } from '@workspace/ui/lib/utils';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DriveLocationField, type DriveLocationValue } from './drive-location-field';

type DriveLocationPickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'save-as' | 'folder';
    onConfirm: (location: {
        ownerId: string;
        mountId: string;
        folderId: string;
        name?: string;
    }) => void | Promise<void>;
    onDownloadInstead?: () => void;
    title?: string;
    defaultName?: string;
    defaultOwnerId?: string;
    defaultMountId?: string;
    defaultFolderId?: string;
    nameLabel?: string;
    confirmLabel?: string;
    abovePreview?: boolean;
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
    abovePreview,
}: DriveLocationPickerProps) {
    const { user } = useAuth();
    const [name, setName] = useState(defaultName);
    const [expanded, setExpanded] = useState(mode !== 'create');
    const { pending, run, handleOpenChange } = useDialogPending(onOpenChange);
    const [location, setLocation] = useState<DriveLocationValue>({
        ownerId: defaultOwnerId || user?.id || '',
        mountId: defaultMountId,
        folderId: defaultFolderId ?? '',
    });

    useEffect(() => {
        if (!user) return;
        setName(defaultName);
        setExpanded(mode !== 'create');
        setLocation({ ownerId: defaultOwnerId || user.id, mountId: defaultMountId, folderId: defaultFolderId ?? '' });
    }, [open, defaultName, mode, defaultOwnerId, defaultMountId, defaultFolderId, user]);

    if (!user) return null;

    const hasName = mode === 'create' || mode === 'save-as';

    const handleSubmit = () => {
        if (hasName && !name.trim()) return;
        return run(() =>
            onConfirm({
                ownerId: location.ownerId || user.id,
                mountId: location.mountId,
                folderId: location.folderId,
                name: hasName ? name.trim() : undefined,
            }),
        );
    };

    const resolvedTitle =
        title ?? (mode === 'create' ? 'New item' : mode === 'save-as' ? 'Save to Drive' : 'Choose destination');
    const resolvedConfirmLabel =
        confirmLabel ?? (mode === 'create' ? 'Create' : mode === 'save-as' ? 'Save here' : 'Select');
    const resolvedNameLabel = nameLabel ?? (mode === 'save-as' ? 'Save as' : 'Name');

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                abovePreview={abovePreview}
                className={cn(
                    'flex flex-col p-0 gap-0 sm:max-w-[688px] max-w-[90vw]',
                    expanded && (hasName ? 'h-[600px] max-h-[85vh]' : 'h-[520px] max-h-[85vh]'),
                )}
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

                <DriveLocationField
                    value={location}
                    onChange={setLocation}
                    expanded={expanded}
                    onExpandedChange={setExpanded}
                    collapsible={mode !== 'save-as'}
                />

                <DialogFooter className="px-6 py-3 border-t flex-row justify-between sm:justify-between">
                    {onDownloadInstead ? (
                        <Button variant="outline" onClick={onDownloadInstead} disabled={pending}>
                            <Download className="h-4 w-4 mr-2" />
                            Download instead
                        </Button>
                    ) : (
                        <div />
                    )}
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={handleSubmit} disabled={pending || (hasName && !name.trim())}>
                            {resolvedConfirmLabel}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
