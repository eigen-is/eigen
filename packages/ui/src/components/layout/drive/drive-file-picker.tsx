import { useAuth } from '@workspace/lib/auth';
import type { DrivePath } from '@workspace/lib/types/drive';
import { isFolderType } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Upload } from 'lucide-react';
import { useCallback, useState } from 'react';
import { DriveBrowser } from './drive-browser';

type DriveFilePickerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (paths: DrivePath[]) => void;
    onUploadFromDevice?: () => void;
    mimeFilter?: string[];
    title?: string;
    multiSelect?: boolean;
};

export function DriveFilePicker({
    open,
    onOpenChange,
    onSelect,
    onUploadFromDevice,
    mimeFilter,
    title = 'Attach file',
    multiSelect = false,
}: DriveFilePickerProps) {
    const { user } = useAuth();
    const [selected, setSelected] = useState<DrivePath | null>(null);
    // In multi-select mode the DriveTable owns modifier-aware selection (shift/ctrl range +
    // toggle). We mirror its current selection here so the submit button reads what the user
    // actually sees highlighted.
    const [multiSelected, setMultiSelected] = useState<DrivePath[]>([]);

    const reset = useCallback(() => {
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
    const ownerId = user.id;

    const handleSubmit = () => {
        if (multiSelect) {
            const files = multiSelected.filter((p) => !isFolderType(p.type));
            if (files.length === 0) return;
            onSelect(files);
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

    const selectedFileCount = multiSelected.filter((p) => !isFolderType(p.type)).length;
    const hasSelection = multiSelect ? selectedFileCount > 0 : !!selected;
    const submitLabel = multiSelect && selectedFileCount > 0 ? `Select (${selectedFileCount})` : 'Select';

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="flex flex-col p-0 gap-0 sm:max-w-[688px] max-w-[90vw] h-[520px] max-h-[85vh]">
                <DialogHeader className="px-6 py-4 border-b">
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>

                <div className="flex-1 overflow-hidden">
                    <DriveBrowser
                        ownerId={ownerId}
                        mode="file"
                        mimeFilter={mimeFilter}
                        selectedId={multiSelect ? undefined : selected?.id}
                        onSelect={handleSelect}
                        onConfirm={multiSelect ? undefined : handleConfirm}
                        showNewFolder={false}
                        onSelectionChange={multiSelect ? setMultiSelected : undefined}
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
