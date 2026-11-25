// A dialog for picking files from the viewer's Drive: a DriveBrowser, a Select button, or the caller's own verb such
// as Import, and, where the caller can take one, Upload from device. It hands the picked files back, such as to the
// file menu's Open. The button waits for a pick, and then Cmd+Enter confirms too. A single pick also confirms on a
// second click of its row; a multi pick takes every file highlighted.

import { useAuth } from '@workspace/lib/auth';
import { useDriveViewPreferences } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isFolderType } from '@workspace/lib/types/drive';
import type { DriveLocationValue, DriveSort } from '@workspace/lib/types/drive-view';
import { DEFAULT_MOUNT_ID } from '@workspace/lib/types/mount';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { FormFooter } from '@workspace/ui/components/form-dialog';
import { FormShell } from '@workspace/ui/components/form-shell';
import { Upload } from 'lucide-react';
import { useState } from 'react';
import { DriveBrowser } from './drive-browser';

type DriveFilePickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (paths: DrivePath[]) => void;
    onUploadFromDevice?: () => void;
    canPick?: (item: DrivePath) => boolean;
    title?: string;
    submitLabel?: string;
    multiSelect?: boolean;
};

export function DriveFilePicker({ open, onOpenChange, title = 'Attach file', ...body }: DriveFilePickerProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex flex-col h-[520px] max-h-[85vh]">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription className="sr-only">Browse your Drive and pick a file.</DialogDescription>
                </DialogHeader>
                <DriveFilePickerBody {...body} open={open} onClose={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    );
}

// Mounted with the dialog's content, so each opening starts at the root of the viewer's drive with nothing picked.
function DriveFilePickerBody({
    open,
    onClose,
    onSelect,
    onUploadFromDevice,
    canPick,
    submitLabel = 'Select',
    multiSelect = false,
}: Omit<DriveFilePickerProps, 'onOpenChange' | 'title'> & { onClose: () => void }) {
    const { user } = useAuth();
    // Seeded from the view preference and kept here, so a sort picked in the dialog never writes it.
    const { sortKey, sortDir } = useDriveViewPreferences();
    const [sort, setSort] = useState<DriveSort>({ key: sortKey, dir: sortDir });
    const [location, setLocation] = useState<DriveLocationValue>({
        ownerId: user?.id ?? '',
        mountId: DEFAULT_MOUNT_ID,
        folderId: '',
    });
    const [selected, setSelected] = useState<DrivePath | null>(null);
    // The table owns a multi pick, Shift and Ctrl clicks included; this mirror lets Select read it.
    const [multiSelected, setMultiSelected] = useState<DrivePath[]>([]);

    const pickedFiles = multiSelected.filter((p) => !isFolderType(p.type));
    const picked = multiSelect ? pickedFiles : selected ? [selected] : [];
    const label = multiSelect && pickedFiles.length > 0 ? `${submitLabel} (${pickedFiles.length})` : submitLabel;

    const confirm = (paths: DrivePath[]) => {
        onSelect(paths);
        onClose();
    };

    return (
        <FormShell
            // A closing picker is still drawn as it fades out, and takes no second confirm, as FormDialog's form.
            onSubmit={() => (open && picked.length > 0 ? confirm(picked) : undefined)}
            className="flex min-h-0 flex-1 flex-col gap-4"
        >
            {/* Edge to edge from sm up. A phone keeps the padding, so the drive select above the folders stays inset. */}
            <div className="min-h-0 flex-1 overflow-hidden sm:-mx-6">
                <DriveBrowser
                    value={location}
                    onChange={setLocation}
                    mode="file"
                    canPick={canPick}
                    selectedId={multiSelect ? undefined : selected?.id}
                    onSelect={multiSelect ? undefined : setSelected}
                    onConfirm={multiSelect ? undefined : (path) => confirm([path])}
                    onSelectionChange={multiSelect ? setMultiSelected : undefined}
                    sort={{ value: sort, onChange: setSort }}
                    className="h-full"
                />
            </div>

            <FormFooter
                start={
                    onUploadFromDevice && (
                        <Button variant="outline" onClick={onUploadFromDevice}>
                            <Upload />
                            {/* A phone's footer keeps one row, so only the icon shows there. */}
                            <span className="max-sm:sr-only">Upload from device</span>
                        </Button>
                    )
                }
                pending={false}
                onCancel={onClose}
                canSubmit={picked.length > 0}
                submitLabel={label}
            />
        </FormShell>
    );
}
