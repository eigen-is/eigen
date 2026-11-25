// The dialog that picks a Drive folder, and in create mode a name, such as for a new folder, a new Eigen document, a
// copy or move, or Save to Drive, which can offer a download instead. Confirm waits for a folder: a picker opened with
// none confirms its drive's root, once that has loaded.

import { useAuth } from '@workspace/lib/auth';
import { useResolvedDriveLocation } from '@workspace/lib/drive';
import type { DriveLocationValue } from '@workspace/lib/types/drive-view';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { Field, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import type { DialogAction } from '@workspace/ui/hooks/use-dialog-pending';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { cn } from '@workspace/ui/lib/utils';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { DriveLocationField } from './drive-location-field';

type DriveLocationPickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'folder';
    onConfirm: (location: DriveLocationValue & { name?: string }) => void | Promise<void>;
    onDownloadInstead?: () => void;
    title: string;
    defaultOwnerId?: string;
    defaultMountId?: string;
    defaultFolderId?: string;
    nameLabel?: string;
    confirmLabel: string;
};

export function DriveLocationPicker({ open, onOpenChange, ...body }: DriveLocationPickerProps) {
    const { pending, run, handleOpenChange } = useDialogPending(onOpenChange);
    // A host that names another place while the picker is open, such as once the viewer's teams have loaded, moves it.
    const place = `${body.defaultOwnerId}/${body.defaultMountId}/${body.defaultFolderId}`;
    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="flex flex-col">
                <DriveLocationPickerBody
                    key={place}
                    {...body}
                    pending={pending}
                    run={run}
                    onCancel={() => onOpenChange(false)}
                />
            </DialogContent>
        </Dialog>
    );
}

// Mounted with the dialog's content, so each opening starts empty at the host's place.
function DriveLocationPickerBody({
    mode,
    onConfirm,
    onDownloadInstead,
    title,
    defaultOwnerId,
    defaultMountId = DEFAULT_MOUNT_ID,
    defaultFolderId = '',
    nameLabel = 'Name',
    confirmLabel,
    pending,
    run,
    onCancel,
}: Omit<DriveLocationPickerProps, 'open' | 'onOpenChange'> & {
    pending: boolean;
    run: (action: DialogAction) => Promise<false | undefined>;
    onCancel: () => void;
}) {
    const { user } = useAuth();
    const [name, setName] = useState('');
    const [expanded, setExpanded] = useState(mode !== 'create');
    const [location, setLocation] = useState<DriveLocationValue>({
        ownerId: defaultOwnerId || user?.id || '',
        mountId: defaultMountId,
        folderId: defaultFolderId,
    });
    const destination = useResolvedDriveLocation(location);

    const hasName = mode === 'create';
    const canConfirm = !!destination.folderId && (!hasName || !!name.trim());

    const handleSubmit = () => {
        if (!canConfirm) return;
        return run(() => onConfirm({ ...destination, name: hasName ? name.trim() : undefined }));
    };

    return (
        <div
            className={cn(
                'flex flex-col gap-4 min-h-0',
                expanded && (hasName ? 'h-[600px] max-h-[85vh]' : 'h-[520px] max-h-[85vh]'),
            )}
        >
            <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription className="sr-only">
                    Pick the folder in your Drive where this goes.
                </DialogDescription>
            </DialogHeader>

            {/* Edge to edge, so the folder browser's line spans the dialog. */}
            <div className="-mx-6 flex min-h-0 flex-1 flex-col">
                {hasName && (
                    <Field className="px-6 pb-2">
                        <FieldLabel htmlFor="picker-name">{nameLabel}</FieldLabel>
                        <Input
                            id="picker-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && name.trim()) {
                                    e.preventDefault();
                                    handleSubmit();
                                }
                            }}
                        />
                    </Field>
                )}
                <DriveLocationField
                    value={location}
                    onChange={setLocation}
                    expanded={expanded}
                    onExpandedChange={setExpanded}
                />
            </div>

            <DialogFooter
                start={
                    onDownloadInstead && (
                        <Button variant="outline" onClick={onDownloadInstead} disabled={pending}>
                            <Download />
                            Download instead
                        </Button>
                    )
                }
            >
                <Button variant="outline" onClick={onCancel} disabled={pending}>
                    Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={!canConfirm} pending={pending}>
                    {confirmLabel}
                </Button>
            </DialogFooter>
        </div>
    );
}
