// The dialog that creates one of the user's own calendars or edits it: name, color and the people it is shared
// with. It also deletes the calendar. The sidebar opens it.

import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@workspace/lib/auth';
import { useCreateCalendar, useDeleteCalendar, useUpdateCalendar } from '@workspace/lib/calendar';
import { CALENDAR_NAME_MAX_LENGTH } from '@workspace/lib/constants/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import { DeleteDialog, FormDialog, FormDialogForm } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { Input } from '@workspace/ui/components/input';
import { ColorPicker } from '@workspace/ui/components/media';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Separator } from '@workspace/ui/components/separator';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { CalendarShareEditor } from './calendar-share-editor';

const calendarFormSchema = z.object({
    name: z.string().min(1, 'Calendar name is required.').max(CALENDAR_NAME_MAX_LENGTH, 'Calendar name is too long.'),
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
    const deleteCalendar = useDeleteCalendar(user?.id || '');
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);

    return (
        <>
            <FormDialog
                open={open}
                onOpenChange={onOpenChange}
                title={calendar ? 'Edit calendar' : 'New calendar'}
                description={calendar ? 'Edit calendar settings and sharing.' : 'Create a new calendar.'}
                size="md"
            >
                <CalendarConfigForm
                    calendar={calendar}
                    calendarCount={calendarCount}
                    onDelete={() => setShowDeleteConfirmation(true)}
                />
            </FormDialog>

            {/* Stacked on the open form, so a cancelled delete leaves its edits in place. */}
            <DeleteDialog
                open={showDeleteConfirmation}
                onOpenChange={setShowDeleteConfirmation}
                title="Delete calendar"
                description="Are you sure you want to delete this calendar? All events in it will be lost."
                itemName={calendar?.name}
                onDelete={async () => {
                    if (!calendar) return;
                    await deleteCalendar.mutateAsync(calendar.id);
                    onOpenChange(false);
                }}
            />
        </>
    );
}

// Mounted with the dialog, so each opening starts from the calendar as it is, or empty for a new one.
function CalendarConfigForm({
    calendar,
    calendarCount,
    onDelete,
}: {
    calendar: CalendarItem | null;
    calendarCount: number;
    onDelete: () => void;
}) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const [colorPickerOpen, setColorPickerOpen] = useState(false);
    const [shares, setShares] = useState<CalendarShare[] | null>(calendar?.shares ?? null);

    const createCalendar = useCreateCalendar(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);
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

    const save = async (data: CalendarFormValues) => {
        if (calendar) {
            await updateCalendar.mutateAsync({ id: calendar.id, name: data.name, color: data.color, shares });
        } else {
            await createCalendar.mutateAsync({ name: data.name, color: data.color });
        }
    };

    return (
        <Form {...form}>
            <FormDialogForm
                submitLabel="Save"
                // A failed check resolves without calling save, and returning false keeps its messages in view.
                onSubmit={async () => {
                    let saved = false;
                    await form.handleSubmit(async (data) => {
                        await save(data);
                        saved = true;
                    })();
                    return saved;
                }}
                footerStart={
                    calendar &&
                    !calendar.isDefault && (
                        <Button type="button" variant="destructive" onClick={onDelete} disabled={saving}>
                            Delete
                        </Button>
                    )
                }
            >
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
                                <FormLabel>Calendar name</FormLabel>
                                <FormControl>
                                    <Input placeholder="Enter calendar name" autoFocus {...field} disabled={saving} />
                                </FormControl>
                                <FormMessage>{fieldState.error?.message}</FormMessage>
                            </FormItem>
                        )}
                    />
                </div>

                {calendar && (
                    <>
                        <Separator />
                        <CalendarShareEditor shares={shares} onChange={setShares} />
                    </>
                )}
            </FormDialogForm>
        </Form>
    );
}
