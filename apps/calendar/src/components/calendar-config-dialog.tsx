import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@workspace/lib/auth';
import { useCreateCalendar, useDeleteCalendar, useUpdateCalendar } from '@workspace/lib/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { ColorPicker } from '@workspace/ui/components/media/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Separator } from '@workspace/ui/components/separator';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { CalendarShareEditor } from './calendar-share-editor';

const calendarFormSchema = z.object({
    name: z.string().min(1, 'Calendar name is required.'),
    color: z.string().min(1, 'Color is required.'),
});

type CalendarFormValues = z.infer<typeof calendarFormSchema>;

type CalendarConfigDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    calendar: CalendarItem | null;
    calendarCount?: number;
};

export function CalendarConfigDialog({ open, onOpenChange, calendar, calendarCount = 0 }: CalendarConfigDialogProps) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
    const [colorPickerOpen, setColorPickerOpen] = useState(false);
    const [shares, setShares] = useState<CalendarShare[] | null>(null);

    const isEditMode = !!calendar;
    const createCalendar = useCreateCalendar(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);
    const deleteCalendar = useDeleteCalendar(ownerId);
    const saving = createCalendar.isPending || updateCalendar.isPending;

    const form = useForm<CalendarFormValues>({
        resolver: zodResolver(calendarFormSchema),
        defaultValues: calendar
            ? { name: calendar.name, color: calendar.color }
            : {
                  name: '',
                  color: EIGEN_ACCENT_COLORS_SHUFFLED[calendarCount % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
              },
    });

    const defaultColor = EIGEN_ACCENT_COLORS_SHUFFLED[calendarCount % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;

    useEffect(() => {
        if (calendar) {
            form.reset({ name: calendar.name, color: calendar.color });
            setShares(calendar.shares);
        } else if (open) {
            form.reset({ name: '', color: defaultColor });
            setShares(null);
        }
    }, [calendar, form, open, defaultColor]);

    const handleSubmit = async (data: CalendarFormValues) => {
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
    };

    const handleDelete = async () => {
        if (!calendar) return;
        await deleteCalendar.mutateAsync(calendar.id);
        onOpenChange(false);
    };

    return (
        <>
            <Dialog open={open && !showDeleteConfirmation} onOpenChange={onOpenChange}>
                <DialogContent size="md">
                    <DialogHeader>
                        <DialogTitle>{isEditMode ? 'Edit Calendar' : 'New Calendar'}</DialogTitle>
                        <DialogDescription>
                            {isEditMode ? 'Edit calendar settings and sharing.' : 'Create a new calendar.'}
                        </DialogDescription>
                    </DialogHeader>

                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4" noValidate>
                            <div className="flex gap-2">
                                <FormField
                                    control={form.control}
                                    name="color"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel className="invisible">Color</FormLabel>
                                            <FormControl>
                                                <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
                                                    <PopoverTrigger asChild>
                                                        <button
                                                            type="button"
                                                            className="h-9 w-9 rounded-md border border-input shrink-0"
                                                            style={{ backgroundColor: field.value }}
                                                            disabled={saving}
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
                                    render={({ field, fieldState }) => (
                                        <FormItem className="flex-1">
                                            <FormLabel>Calendar Name</FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Enter calendar name"
                                                    autoFocus
                                                    {...field}
                                                    disabled={saving}
                                                />
                                            </FormControl>
                                            <FormMessage>{fieldState.error?.message}</FormMessage>
                                        </FormItem>
                                    )}
                                />
                            </div>

                            {isEditMode && (
                                <>
                                    <Separator />
                                    <CalendarShareEditor shares={shares} onChange={setShares} />
                                </>
                            )}

                            <DialogFooter>
                                {isEditMode && !calendar.isDefault && (
                                    <Button
                                        type="button"
                                        variant="destructive"
                                        onClick={() => setShowDeleteConfirmation(true)}
                                        disabled={saving}
                                        className="mr-auto"
                                    >
                                        Delete
                                    </Button>
                                )}
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => onOpenChange(false)}
                                    disabled={saving}
                                >
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={saving || form.formState.isSubmitting}>
                                    {saving ? 'Saving...' : 'Save'}
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
