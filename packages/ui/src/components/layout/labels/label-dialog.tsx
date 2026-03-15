import {useEffect, useState} from 'react';
import {z} from 'zod';
import {useForm} from 'react-hook-form';
import {zodResolver} from '@hookform/resolvers/zod';

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@workspace/ui/components/dialog";

import {Form, FormControl, FormField, FormItem, FormLabel, FormMessage,} from "@workspace/ui/components/form";

import {Input} from "@workspace/ui/components/input";
import {Button} from "@workspace/ui/components/button";
import {Popover, PopoverContent, PopoverTrigger} from "@workspace/ui/components/popover";
import {ColorPicker} from "@workspace/ui/components/layout/media/color-picker";
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";
import type {Label} from "@workspace/lib/types/label";

// Form schema for label management
const labelFormSchema = z.object({
    name: z.string().min(1, {
        message: "Label name is required.",
    }),
    color: z.string().min(1, {
        message: "Color is required.",
    }),
});

type LabelFormValues = z.infer<typeof labelFormSchema>;

interface LabelDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selectedLabel: Label | null;
    onSubmit: (data: LabelFormValues) => Promise<void>;
    onDelete: () => void;
}

export function LabelDialog({
                                open,
                                onOpenChange,
                                selectedLabel,
                                onSubmit,
                                onDelete,
                            }: LabelDialogProps) {
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
    const [colorPickerOpen, setColorPickerOpen] = useState(false);
    const isEditMode = !!selectedLabel;
    const [isLoading, setIsLoading] = useState(false);

    // Initialize the form with default values or the selected label data
    const form = useForm<LabelFormValues>({
        resolver: zodResolver(labelFormSchema),
        defaultValues: selectedLabel
            ? {name: selectedLabel.name, color: selectedLabel.color}
            : {name: "", color: "#3b82f6"}, // Default blue color
    });

    // Reset form values when selectedLabel changes
    useEffect(() => {
        if (selectedLabel) {
            form.reset({
                name: selectedLabel.name,
                color: selectedLabel.color
            });
        } else if (open) {
            // Reset to default values when opening for a new label
            form.reset({
                name: "",
                color: "#3b82f6"
            });
        }
    }, [selectedLabel, form, open]);

    // Handle form submission
    const handleSubmit = async (data: LabelFormValues) => {
        try {
            setIsLoading(true);
            await onSubmit(data);
            form.reset();
        } catch (error) {
            console.error('Error submitting form:', error);
        } finally {
            setTimeout(() => setIsLoading(false), 350);
        }
    };

    const handleDeleteClick = () => {
        setShowDeleteConfirmation(true);
    };

    return (
        <>
            <Dialog open={open && !showDeleteConfirmation} onOpenChange={onOpenChange}>
                <DialogContent size="sm">
                    <DialogHeader>
                        <DialogTitle>{isEditMode ? "Edit Label" : "Add Label"}</DialogTitle>
                        <DialogDescription>
                            {isEditMode
                                ? "Make changes to your label here."
                                : "Add a new label to your collection."}
                        </DialogDescription>
                    </DialogHeader>

                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4" noValidate>
                            <div className="flex gap-2">
                                <FormField
                                    control={form.control}
                                    name="color"
                                    render={({field, fieldState}) => (
                                        <FormItem>
                                            <FormLabel className="invisible">Color</FormLabel>
                                            <FormControl>
                                                <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
                                                    <PopoverTrigger asChild>
                                                        <button
                                                            type="button"
                                                            className="h-9 w-9 rounded-md border border-input shrink-0"
                                                            style={{backgroundColor: field.value}}
                                                            disabled={isLoading}
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
                                            <FormMessage>
                                                {fieldState.error?.message}
                                            </FormMessage>
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="name"
                                    render={({field, fieldState}) => (
                                        <FormItem className="flex-1">
                                            <FormLabel>Label Name</FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Enter label name"
                                                    autoFocus
                                                    {...field}
                                                    disabled={isLoading}
                                                />
                                            </FormControl>
                                            <FormMessage>
                                                {fieldState.error?.message}
                                            </FormMessage>
                                        </FormItem>
                                    )}
                                />
                            </div>
                            <DialogFooter className="flex justify-end">
                                {isEditMode && (
                                    <Button
                                        type="button"
                                        variant="destructive"
                                        onClick={handleDeleteClick}
                                        disabled={isLoading}
                                        className="mr-auto"
                                    >
                                        Delete
                                    </Button>
                                )}
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => onOpenChange(false)}
                                    className="mr-2"
                                    disabled={isLoading}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    type="submit"
                                    disabled={isLoading || form.formState.isSubmitting}
                                >
                                    {isLoading ? 'Saving...' : 'Save'}
                                </Button>
                            </DialogFooter>
                        </form>
                    </Form>
                </DialogContent>
            </Dialog>

            <DeleteDialog
                open={showDeleteConfirmation}
                onOpenChange={setShowDeleteConfirmation}
                title="Delete Label"
                description="Are you sure you want to delete this label"
                itemName={selectedLabel?.name}
                onDelete={() => {
                    onDelete();
                    setShowDeleteConfirmation(false);
                    onOpenChange(false);
                }}
            />
        </>
    );
}
