// A dialog for picking files from the viewer's Drive: a DriveBrowser, a Select button and, where the caller
// can take one, Upload from device. It hands the picked files back, such as to the file menu's Open. A single
// pick also confirms on a second click of its row; a multi pick takes every file highlighted.

import { useAuth } from '@workspace/lib/auth';
import { useDriveViewPreferences } from '@workspace/lib/drive';
import type { DrivePath, DriveSort } from '@workspace/lib/types/drive';
import { isFolderType } from '@workspace/lib/types/drive';
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
import { Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { DriveLocationValue } from './drive-browser';
import { DriveBrowser } from './drive-browser';

type DriveFilePickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (paths: DrivePath[]) => void;
    onUploadFromDevice?: () => void;
    canPick?: (item: DrivePath) => boolean;
    title?: string;
    multiSelect?: boolean;
};

export function DriveFilePicker({
    open,
    onOpenChange,
    onSelect,
    onUploadFromDevice,
    canPick,
    title = 'Attach file',
    multiSelect = false,
}: DriveFilePickerProps) {
    const { user } = useAuth();
    // Seeded once from the view preference and kept here, so a sort picked in the dialog never writes it.
    const { sortKey, sortDir } = useDriveViewPreferences();
    const [sort, setSort] = useState<DriveSort>({ key: sortKey, dir: sortDir });
    // Unset is the root of the viewer's own drive, where every opening starts.
    const [location, setLocation] = useState<DriveLocationValue>();
    const [selected, setSelected] = useState<DrivePath | null>(null);
    // The table owns a multi pick, Shift and Ctrl clicks included; this mirror lets Select read it.
    const [multiSelected, setMultiSelected] = useState<DrivePath[]>([]);

    const reset = useCallback(() => {
        setLocation(undefined);
        setSelected(null);
        setMultiSelected([]);
    }, []);

    const handleSelect = useCallback(
        (path: DrivePath) => {
            if (!multiSelect) setSelected(path);
        },
        [multiSelect],
    );

    const handleConfirm = useCallback(
        (path: DrivePath) => {
            onSelect([path]);
            onOpenChange(false);
            reset();
        },
        [onSelect, onOpenChange, reset],
    );

    if (!user) return null;
    const pickedFiles = multiSelected.filter((p) => !isFolderType(p.type));

    const handleSubmit = () => {
        if (multiSelect) {
            if (pickedFiles.length === 0) return;
            onSelect(pickedFiles);
            onOpenChange(false);
            reset();
        } else if (selected) {
            handleConfirm(selected);
        }
    };

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) reset();
        onOpenChange(nextOpen);
    };

    const hasSelection = multiSelect ? pickedFiles.length > 0 : !!selected;
    const submitLabel = multiSelect && pickedFiles.length > 0 ? `Select (${pickedFiles.length})` : 'Select';

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="flex flex-col p-0 gap-0 sm:max-w-[688px] max-w-[90vw] h-[520px] max-h-[85vh]">
                <DialogHeader className="px-6 py-4 border-b">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription className="sr-only">Browse your Drive and pick a file.</DialogDescription>
                </DialogHeader>

                <div className="flex-1 overflow-hidden">
                    <DriveBrowser
                        value={location ?? { ownerId: user.id, mountId: DEFAULT_MOUNT_ID, folderId: '' }}
                        onChange={setLocation}
                        mode="file"
                        canPick={canPick}
                        selectedId={multiSelect ? undefined : selected?.id}
                        onSelect={handleSelect}
                        onConfirm={multiSelect ? undefined : handleConfirm}
                        onSelectionChange={multiSelect ? setMultiSelected : undefined}
                        sort={{ value: sort, onChange: setSort }}
                        className="h-full"
                    />
                </div>

                <DialogFooter className="px-6 py-3 border-t flex-row justify-between sm:justify-between">
                    {onUploadFromDevice ? (
                        <Button variant="outline" onClick={onUploadFromDevice}>
                            <Upload className="h-4 w-4 mr-2" />
                            Upload from device
                        </Button>
                    ) : (
                        <div />
                    )}
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSubmit} disabled={!hasSelection}>
                            {submitLabel}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
