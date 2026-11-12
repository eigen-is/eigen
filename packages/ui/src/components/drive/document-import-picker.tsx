// The Import… picker of an editor such as Docs or Slides: pick a file from Drive or the device, then say how it comes
// in, and only then does either import mutation run. The choice stays open, under the progress dialog, until the import
// is done, and a failed import leaves it open for another try. A Drive file is offered by its extension, as Convert
// takes it: Drive stores the type its upload claimed, which for an Office file can be application/octet-stream.

import { useImportDocument, useImportFromDrive } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ConvertTarget, ImportMode } from '@workspace/lib/types/drive-convert';
import { CONVERT_SOURCES, isConvertSource } from '@workspace/lib/types/drive-convert';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
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

export function DocumentImportPicker({ path, open, onOpenChange, target, afterFrameId }: DocumentImportPickerProps) {
    const importMutation = useImportDocument(path.ownerId, path.mountId);
    const importFromDriveMutation = useImportFromDrive(path.ownerId, path.mountId);
    const choice = useDialogValue<ImportSource>();
    const source = choice.value;
    const { format } = CONVERT_SOURCES[target];
    const title = `Import ${format} file`;

    const runImport = async (from: ImportSource, mode: ImportMode) => {
        const options = { mode, afterFrameId };
        if ('file' in from) {
            await importMutation.mutateAsync({ pathId: path.id, file: from.file, options });
        } else {
            await importFromDriveMutation.mutateAsync({
                pathId: path.id,
                sourceOwnerId: from.drive.ownerId,
                sourceMountId: from.drive.mountId,
                sourcePathId: from.drive.id,
                options,
            });
        }
    };

    return (
        <>
            <FileImportPicker
                open={open}
                onOpenChange={onOpenChange}
                title={title}
                accept={`.${format}`}
                canPick={(item) => isConvertSource(item.name, target)}
                onDeviceFile={(file) => choice.openDialog({ name: file.name, file })}
                onDrivePick={(drive) => choice.openDialog({ name: drive.name, drive })}
                pending={importMutation.isPending || importFromDriveMutation.isPending}
                progressTitle={`Importing ${format} file`}
            />
            {source && (
                <FormDialog
                    open={choice.open}
                    onOpenChange={choice.setOpen}
                    title={title}
                    description={
                        IMPORT_CHOICES[target].length === 0
                            ? `${source.name} replaces this whole document: its text, headers and footers, and page setup. ${VERSION_NOTE}`
                            : source.name
                    }
                    size="sm"
                >
                    <ImportModeForm target={target} onImport={(mode) => runImport(source, mode)} />
                </FormDialog>
            )}
        </>
    );
}

// Mounted with the dialog, so each pick starts on the default.
function ImportModeForm({
    target,
    onImport,
}: {
    target: ConvertTarget;
    onImport: (mode: ImportMode) => Promise<void>;
}) {
    const choices = IMPORT_CHOICES[target];
    const [mode, setMode] = useState<ImportMode>(choices[0]?.mode ?? 'replace');

    return (
        <FormDialogForm submitLabel="Import" onSubmit={() => onImport(mode)}>
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
        </FormDialogForm>
    );
}
