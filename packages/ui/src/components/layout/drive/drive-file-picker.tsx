import { useAuth } from '@workspace/lib/auth';
import type { DrivePath } from '@workspace/lib/types/drive';
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
    multiple?: boolean;
};

export function DriveFilePicker({
    open,
    onOpenChange,
    onSelect,
    onUploadFromDevice,
    mimeFilter,
    title = 'Attach file',
    multiple: _multiple = false,
}: DriveFilePickerProps) {
    const { user } = useAuth();
    const [selected, setSelected] = useState<DrivePath | null>(null);

    if (!user) return null;
    const ownerId = user.id;

    const handleSelect = useCallback((path: DrivePath) => {
        setSelected(path);
    }, []);

    const handleConfirm = useCallback(
        (path: DrivePath) => {
            onSelect([path]);
            onOpenChange(false);
            setSelected(null);
        },
        [onSelect, onOpenChange],
    );

    const handleSubmit = () => {
        if (selected) handleConfirm(selected);
    };

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) setSelected(null);
        onOpenChange(nextOpen);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent size="lg" className="flex flex-col p-0 gap-0 h-[480px]">
                <DialogHeader className="px-6 py-4 border-b">
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>

                <div className="flex-1 overflow-hidden">
                    <DriveBrowser
                        ownerId={ownerId}
                        mode="file"
                        mimeFilter={mimeFilter}
                        selectedId={selected?.id}
                        onSelect={handleSelect}
                        onConfirm={handleConfirm}
                        showNewFolder={false}
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
                        <Button onClick={handleSubmit} disabled={!selected}>
                            Select
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
