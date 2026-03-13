import {useEffect, useState} from 'react';
import {z} from 'zod';
import {useForm} from 'react-hook-form';
import {zodResolver} from '@hookform/resolvers/zod';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Form, FormControl, FormField, FormItem, FormLabel, FormMessage} from '@workspace/ui/components/form';
import {Input} from '@workspace/ui/components/input';
import {Button} from '@workspace/ui/components/button';
import {Popover, PopoverContent, PopoverTrigger} from '@workspace/ui/components/popover';
import {ColorPicker} from '@workspace/ui/components/layout/media/color-picker';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';
import {Separator} from '@workspace/ui/components/separator';
import {useCreateCalendar, useUpdateCalendar, useDeleteCalendar} from '@workspace/lib/calendar';
import type {CalendarItem, CalendarShare} from '@workspace/lib/types/calendar';
import {CalendarShareEditor} from './calendar-share-editor';

const calendarFormSchema = z.object({
    name: z.string().min(1, {message: 'Calendar name is required.'}),
    color: z.string().min(1, {message: 'Color is required.'}),
});

type CalendarFormValues = z.infer<typeof calendarFormSchema>;

type CalendarConfigDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    calendar: CalendarItem | null;
}

export function CalendarConfigDialog({open, onOpenChange, calendar}: CalendarConfigDialogProps) {
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
    const [colorPickerOpen, setColorPickerOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [shares, setShares] = useState<CalendarShare[] | null>(null);

    const isEditMode = !!calendar;
    const createCalendar = useCreateCalendar();
    const updateCalendar = useUpdateCalendar();
    const deleteCalendar = useDeleteCalendar();

    const form = useForm<CalendarFormValues>({
        resolver: zodResolver(calendarFormSchema),
        defaultValues: calendar
            ? {name: calendar.name, color: calendar.color}
            : {name: '', color: '#4285f4'},
    });

    useEffect(() => {
        if (calendar) {
            form.reset({name: calendar.name, color: calendar.color});
            setShares(calendar.shares);
        } else if (open) {
            form.reset({name: '', color: '#4285f4'});
            setShares(null);
        }
    }, [calendar, form, open]);

    const handleSubmit = async (data: CalendarFormValues) => {
        try {
            setIsLoading(true);
            if (isEditMode) {
                await updateCalendar.mutateAsync({
                    id: calendar.id,
                    name: data.name,
                    color: data.color,
                    shares,
                });
            } else {
                await createCalendar.mutateAsync({
                    name: data.name,
                    color: data.color,
                });
            }
            onOpenChange(false);
        } catch (error) {
            console.error('Error saving calendar:', error);
        } finally {
            setTimeout(() => setIsLoading(false), 350);
        }
    };

    const handleDelete = async () => {
        if (!calendar) return;
        try {
            await deleteCalendar.mutateAsync(calendar.id);
            setShowDeleteConfirmation(false);
            onOpenChange(false);
        } catch (error) {
            console.error('Error deleting calendar:', error);
        }
    };

    return (
        <>
            <Dialog open={open && !showDeleteConfirmation} onOpenChange={onOpenChange}>
                <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                        <DialogTitle>{isEditMode ? 'Edit Calendar' : 'New Calendar'}</DialogTitle>
                        <DialogDescription>
                            {isEditMode
                                ? 'Edit calendar settings and sharing.'
                                : 'Create a new calendar.'}
                        </DialogDescription>
                    </DialogHeader>

                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4" noValidate>
                            <div className="flex gap-2">
                                <FormField
                                    control={form.control}
                                    name="color"
                                    render={({field}) => (
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
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="name"
                                    render={({field, fieldState}) => (
                                        <FormItem className="flex-1">
                                            <FormLabel>Calendar Name</FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Enter calendar name"
                                                    autoFocus
                                                    {...field}
                                                    disabled={isLoading}
                                                />
                                            </FormControl>
                                            <FormMessage>{fieldState.error?.message}</FormMessage>
                                        </FormItem>
                                    )}
                                />
                            </div>

                            {isEditMode && (
                                <>
                                    <Separator/>
                                    <CalendarShareEditor
                                        shares={shares}
                                        onChange={setShares}
                                    />
                                </>
                            )}

                            <DialogFooter className="flex justify-end">
                                {isEditMode && !calendar.isDefault && (
                                    <Button
                                        type="button"
                                        variant="destructive"
                                        onClick={() => setShowDeleteConfirmation(true)}
                                        disabled={isLoading}
                                        className="mr-auto"
                                    >
                                        Delete
                                    </Button>
                                )}
                                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}
                                        className="mr-2" disabled={isLoading}>
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={isLoading || form.formState.isSubmitting}>
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
                title="Delete Calendar"
                description="Are you sure you want to delete this calendar? All events in it will be lost."
                itemName={calendar?.name}
                onDelete={handleDelete}
            />
        </>
    );
}
