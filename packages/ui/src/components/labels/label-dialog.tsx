// The dialog that adds or edits a label: its name and color, and deleting it after a confirmation. Save waits for a
// name that is more than spaces, and the name is saved trimmed. Contacts opens it from its label list.

import { zodResolver } from '@hookform/resolvers/zod';
import { EIGEN_ACCENT_COLORS_SHUFFLED, LABEL_NAME_MAX_LENGTH } from '@workspace/lib/constants';
import type { Label } from '@workspace/lib/types/label';
import { Button } from '@workspace/ui/components/button';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { ColorPicker } from '@workspace/ui/components/media/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

const labelFormSchema = z.object({
    name: z.string().trim().min(1, 'Label name is required.'),
    color: z.string().min(1, 'Color is required.'),
});

type LabelFormValues = z.infer<typeof labelFormSchema>;

type LabelDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedLabel: Label | null;
    // Rejects when the save fails, which keeps the dialog open.
    onSubmit: (data: LabelFormValues) => Promise<unknown>;
    onDelete: () => void | Promise<void>;
    labelCount?: number;
};

export function LabelDialog({
    open,
    onOpenChange,
    selectedLabel,
    onSubmit,
    onDelete,
    labelCount = 0,
}: LabelDialogProps) {
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);

    return (
        <>
            <FormDialog
                open={open}
                onOpenChange={onOpenChange}
                title={selectedLabel ? 'Edit label' : 'Add label'}
                description={selectedLabel ? 'Make changes to your label here.' : 'Add a new label to your collection.'}
                size="sm"
            >
                <LabelForm
                    selectedLabel={selectedLabel}
                    labelCount={labelCount}
                    onSubmit={onSubmit}
                    onDelete={() => setShowDeleteConfirmation(true)}
                />
            </FormDialog>

            {/* Stacked on the open form, so a cancelled delete leaves its edits in place. */}
            <DeleteDialog
                open={showDeleteConfirmation}
                onOpenChange={setShowDeleteConfirmation}
                title="Delete label"
                description="Are you sure you want to delete this label"
                itemName={selectedLabel?.name}
                onDelete={onDelete}
            />
        </>
    );
}

// Mounted with the dialog, so each opening starts from the label as it is, or empty for a new one.
function LabelForm({
    selectedLabel,
    labelCount,
    onSubmit,
    onDelete,
}: {
    selectedLabel: Label | null;
    labelCount: number;
    onSubmit: (data: LabelFormValues) => Promise<unknown>;
    onDelete: () => void;
}) {
    const [colorPickerOpen, setColorPickerOpen] = useState(false);

    const form = useForm<LabelFormValues>({
        resolver: zodResolver(labelFormSchema),
        defaultValues: selectedLabel
            ? { name: selectedLabel.name, color: selectedLabel.color }
            : { name: '', color: EIGEN_ACCENT_COLORS_SHUFFLED[labelCount % EIGEN_ACCENT_COLORS_SHUFFLED.length].value },
    });
    const name = form.watch('name');

    return (
        <Form {...form}>
            <FormDialogForm
                canSubmit={name.trim() !== ''}
                submitLabel="Save"
                // A failed check resolves without calling onSubmit, and returning false keeps its messages in view.
                onSubmit={async () => {
                    let saved = false;
                    await form.handleSubmit(async (data) => {
                        await onSubmit(data);
                        saved = true;
                    })();
                    return saved;
                }}
                footerStart={
                    selectedLabel && (
                        <Button type="button" variant="destructive" onClick={onDelete}>
                            Delete
                        </Button>
                    )
                }
            >
                <div className="flex gap-2">
                    <FormField
                        control={form.control}
                        name="color"
                        render={({ field, fieldState }) => (
                            <FormItem>
                                <FormLabel className="invisible">Color</FormLabel>
                                <FormControl>
                                    <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
                                        <PopoverTrigger asChild>
                                            <button
                                                type="button"
                                                className="h-9 w-9 rounded-md border border-input shrink-0"
                                                style={{ backgroundColor: field.value }}
                                            />
                                        </PopoverTrigger>
                                        <PopoverContent className="w-auto p-3" align="start">
                                            <ColorPicker
                                                value={field.value}
                                                onChange={(color) => {
                                                    field.onChange(color);
                                                    setColorPickerOpen(false);
                                                }}
                                                showReset={false}
                                            />
                                        </PopoverContent>
                                    </Popover>
                                </FormControl>
                                <FormMessage>{fieldState.error?.message}</FormMessage>
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="name"
                        render={({ field, fieldState }) => (
                            <FormItem className="flex-1">
                                <FormLabel>Label name</FormLabel>
                                <FormControl>
                                    <Input
                                        placeholder="Enter label name"
                                        autoFocus
                                        maxLength={LABEL_NAME_MAX_LENGTH}
                                        {...field}
                                    />
                                </FormControl>
                                <FormMessage>{fieldState.error?.message}</FormMessage>
                            </FormItem>
                        )}
                    />
                </div>
            </FormDialogForm>
        </Form>
    );
}
