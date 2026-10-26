import { useImportDocument, useImportFromDrive } from '@workspace/lib/drive';
import type { ConvertTarget, DrivePath, ImportMode } from '@workspace/lib/types/drive';
import { CONVERT_SOURCES, isConvertSource } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { useState } from 'react';
import { FileImportPicker } from './file-import-picker';

type DocumentImportPickerProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    target: ConvertTarget;
    // The slide the user is on, which Insert slides lands after.
    afterFrameId?: string;
};

type ImportSource = { name: string; file: File } | { name: string; drive: DrivePath };

const VERSION_NOTE = 'A version is saved first, so you can restore it from version history.';

// What Import… offers per document type, the default first, as Google Sheets' import dialog does. A doc has none: the
// file's page setup and headers can't sit beside the doc's, so it is told the import replaces it.
const IMPORT_CHOICES: Record<ConvertTarget, { mode: ImportMode; label: string; detail: string }[]> = {
    eigenslides: [
        { mode: 'insert', label: 'Insert slides', detail: 'After the current slide.' },
        {
            mode: 'replace',
            label: 'Replace all slides',
            detail: `The deck takes the file's slide size. ${VERSION_NOTE}`,
        },
    ],
    eigensheets: [
        { mode: 'insert', label: 'Insert as new sheets', detail: 'After the sheets this spreadsheet has.' },
        { mode: 'replace', label: 'Replace spreadsheet', detail: VERSION_NOTE },
    ],
    eigendoc: [],
};

// The import picker docs, sheets and slides share: pick a file from Drive or the device, then say how it comes in, and
// only then does either import mutation run. The toolbar keeps only the open state so its File menu can trigger it. A
// Drive file is offered by its extension, as Convert takes it: Drive stores the type its upload claimed, which for an
// Office file can be application/octet-stream.
export function DocumentImportPicker({ path, open, onOpenChange, target, afterFrameId }: DocumentImportPickerProps) {
    const importMutation = useImportDocument(path.ownerId, path.mountId);
    const importFromDriveMutation = useImportFromDrive(path.ownerId, path.mountId);
    const [source, setSource] = useState<ImportSource | null>(null);
    const { format } = CONVERT_SOURCES[target];

    const runImport = (mode: ImportMode) => {
        if (!source) return;
        const options = { mode, afterFrameId };
        if ('file' in source) importMutation.mutate({ pathId: path.id, file: source.file, options });
        else
            importFromDriveMutation.mutate({
                pathId: path.id,
                sourceOwnerId: source.drive.ownerId,
                sourceMountId: source.drive.mountId,
                sourcePathId: source.drive.id,
                options,
            });
        setSource(null);
    };

    return (
        <>
            <FileImportPicker
                open={open}
                onOpenChange={onOpenChange}
                title={`Import ${format} file`}
                accept={`.${format}`}
                canPick={(item) => isConvertSource(item.name, target)}
                onDeviceFile={(file) => setSource({ name: file.name, file })}
                onDrivePick={(drive) => setSource({ name: drive.name, drive })}
                pending={importMutation.isPending || importFromDriveMutation.isPending}
                progressTitle={`Importing ${format} file`}
            />
            <Dialog open={source !== null} onOpenChange={(next) => !next && setSource(null)}>
                <DialogContent size="sm">
                    {source && (
                        <ImportModeForm
                            title={`Import ${format} file`}
                            fileName={source.name}
                            target={target}
                            onCancel={() => setSource(null)}
                            onImport={runImport}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

type ImportModeFormProps = {
    title: string;
    fileName: string;
    target: ConvertTarget;
    onCancel: () => void;
    onImport: (mode: ImportMode) => void;
};

// Mounted per pick, so each one starts on the default.
function ImportModeForm({ title, fileName, target, onCancel, onImport }: ImportModeFormProps) {
    const choices = IMPORT_CHOICES[target];
    const [mode, setMode] = useState<ImportMode>(choices[0]?.mode ?? 'replace');

    return (
        <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
                e.preventDefault();
                onImport(mode);
            }}
        >
            <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription className="break-words">
                    {choices.length === 0
                        ? `${fileName} replaces this whole document: its text, headers and footers, and page setup. ${VERSION_NOTE}`
                        : fileName}
                </DialogDescription>
            </DialogHeader>
            {choices.length > 0 && (
                <RadioGroup
                    value={mode}
                    onValueChange={(value) => setMode(choices.find((choice) => choice.mode === value)?.mode ?? mode)}
                >
                    {choices.map((choice) => (
                        <div key={choice.mode} className="flex items-start gap-2">
                            <RadioGroupItem value={choice.mode} id={`import-${choice.mode}`} className="mt-0.5" />
                            <Label htmlFor={`import-${choice.mode}`} className="flex flex-col items-start gap-1">
                                {choice.label}
                                <span className="text-muted-foreground font-normal">{choice.detail}</span>
                            </Label>
                        </div>
                    ))}
                </RadioGroup>
            )}
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit">Import</Button>
            </DialogFooter>
        </form>
    );
}
