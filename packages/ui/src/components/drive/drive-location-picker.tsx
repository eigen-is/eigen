// The dialog that picks a Drive folder, and in create mode a name, such as for a new folder, a new Eigen document, a
// copy or move, or Save to Drive, which can offer a download instead. Confirm waits for a folder: a picker opened with
// none confirms its drive's root, once that has loaded. A blank name, a name the folder has already, or a folder the
// host refuses gets its reason under its field. Esc, the X and a click outside ask "Discard changes?" once a name is
// typed; a pick alone loses nothing typed, so it closes at once.

import { useAuth } from '@workspace/lib/auth';
import { isNameTaken, useResolvedDriveLocation } from '@workspace/lib/drive';
import type { DriveLocationValue } from '@workspace/lib/types/drive-view';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { FormFooter } from '@workspace/ui/components/form-dialog';
import { FormShell } from '@workspace/ui/components/form-shell';
import type { DialogAction } from '@workspace/ui/hooks/use-dialog-pending';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { useDiscardChanges } from '@workspace/ui/hooks/use-discard-changes';
import { cn } from '@workspace/ui/lib/utils';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DriveNameField } from './drive-item-name-dialog';
import { DriveLocationField } from './drive-location-field';

type DriveLocationPickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mode: 'create' | 'folder';
    onConfirm: (location: DriveLocationValue & { name?: string }) => void | Promise<void>;
    // Why a folder can't take what the picker is for, such as a move to another drive, shown under the location.
    refuseLocation?: (location: DriveLocationValue) => string | undefined;
    onDownloadInstead?: () => void;
    title: string;
    defaultOwnerId?: string;
    defaultMountId?: string;
    defaultFolderId?: string;
    nameLabel?: string;
    confirmLabel: string;
};

export function DriveLocationPicker({ open, onOpenChange, ...body }: DriveLocationPickerProps) {
    const { pending, run } = useDialogPending(onOpenChange);
    const [named, setNamed] = useState(false);
    const discard = useDiscardChanges({ open, changed: named, pending, onDiscard: () => onOpenChange(false) });
    return (
        <>
            <Dialog open={open} onOpenChange={discard.onOpenChange}>
                <DialogContent className="flex flex-col" onFocus={discard.onFocus}>
                    <DriveLocationPickerBody
                        {...body}
                        pending={pending}
                        run={run}
                        onCancel={() => onOpenChange(false)}
                        onNamedChange={setNamed}
                    />
                </DialogContent>
            </Dialog>
            {discard.dialog}
        </>
    );
}

// Mounted with the dialog's content, so each opening starts empty at the host's place.
function DriveLocationPickerBody({
    mode,
    onConfirm,
    refuseLocation,
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
    onNamedChange,
}: Omit<DriveLocationPickerProps, 'open' | 'onOpenChange'> & {
    pending: boolean;
    run: (action: DialogAction) => Promise<false | undefined>;
    onCancel: () => void;
    onNamedChange: (named: boolean) => void;
}) {
    const { user } = useAuth();
    const nameRef = useRef<HTMLInputElement>(null);
    const [name, setName] = useState('');
    // The server's reason for the name last sent, until the name or the folder changes.
    const [taken, setTaken] = useState<string>();
    const [expanded, setExpanded] = useState(mode !== 'create');
    const place = { ownerId: defaultOwnerId || user?.id || '', mountId: defaultMountId, folderId: defaultFolderId };
    const [location, setLocation] = useState<DriveLocationValue>(place);
    const [locationRefusal, setLocationRefusal] = useState<string>();
    const destination = useResolvedDriveLocation(location);
    // Both reasons were about the folder left, so neither stays.
    const moveTo = (next: DriveLocationValue) => {
        setLocation(next);
        setTaken(undefined);
        setLocationRefusal(undefined);
    };

    // A host that names another place while the picker is open, such as once the viewer's teams have loaded, moves it.
    // The typed name stays.
    const placeKey = `${defaultOwnerId}/${defaultMountId}/${defaultFolderId}`;
    const [shownPlace, setShownPlace] = useState(placeKey);
    if (shownPlace !== placeKey) {
        setShownPlace(placeKey);
        moveTo(place);
    }

    const named = name !== '';
    useEffect(() => {
        onNamedChange(named);
        return () => onNamedChange(false);
    }, [named, onNamedChange]);

    const hasName = mode === 'create';

    const confirm = async () => {
        const refusal = refuseLocation?.(destination);
        setLocationRefusal(refusal);
        if (refusal || (hasName && !name.trim())) return false;
        try {
            await onConfirm({ ...destination, name: hasName ? name.trim() : undefined });
        } catch (error) {
            if (!hasName || !isNameTaken(error)) throw error;
            setTaken(error.message);
            return false;
        }
    };

    return (
        <FormShell
            onSubmit={() => (destination.folderId ? run(confirm) : undefined)}
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
                    <DriveNameField
                        fieldRef={nameRef}
                        label={nameLabel}
                        autoFocus
                        className="px-6 pb-2"
                        value={name}
                        onChange={(next) => {
                            setName(next);
                            setTaken(undefined);
                        }}
                        taken={taken}
                    />
                )}
                <DriveLocationField
                    value={location}
                    onChange={moveTo}
                    expanded={expanded}
                    // The name keeps the focus, so Enter still creates once the folder is picked.
                    onExpandedChange={(next) => {
                        setExpanded(next);
                        nameRef.current?.focus();
                    }}
                    error={locationRefusal}
                />
            </div>

            <FormFooter
                start={
                    onDownloadInstead && (
                        <Button variant="outline" onClick={onDownloadInstead}>
                            <Download />
                            {/* A phone's footer keeps one row, so only the icon shows there. */}
                            <span className="max-sm:sr-only">Download instead</span>
                        </Button>
                    )
                }
                pending={pending}
                onCancel={onCancel}
                canSubmit={!!destination.folderId}
                submitLabel={confirmLabel}
            />
        </FormShell>
    );
}
