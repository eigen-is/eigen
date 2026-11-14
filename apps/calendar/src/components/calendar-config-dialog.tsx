// The dialog that creates one of the user's own calendars or edits it: name, color and the people it is shared
// with. It also deletes the calendar. Save waits for a name that is more than spaces, and the name is saved trimmed.
// The sidebar opens it.

import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '@workspace/lib/auth';
import { useCreateCalendar, useDeleteCalendar, useUpdateCalendar } from '@workspace/lib/calendar';
import { CALENDAR_NAME_MAX_LENGTH } from '@workspace/lib/constants/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@workspace/ui/components/form';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { ColorPickerSwatch } from '@workspace/ui/components/media';
import { Separator } from '@workspace/ui/components/separator';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { CalendarShareEditor } from './calendar-share-editor';

const calendarFormSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, 'Calendar name is required.')
        .max(CALENDAR_NAME_MAX_LENGTH, 'Calendar name is too long.'),
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
    const ownerId = user?.id ?? '';
    const deleteCalendar = useDeleteCalendar(ownerId);
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
                    ownerId={ownerId}
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
    ownerId,
    calendar,
    calendarCount,
    onDelete,
}: {
    ownerId: string;
    calendar: CalendarItem | null;
    calendarCount: number;
    onDelete: () => void;
}) {
    const [shares, setShares] = useState<CalendarShare[] | null>(calendar?.shares ?? null);

    const createCalendar = useCreateCalendar(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);

    const form = useForm<CalendarFormValues>({
        resolver: zodResolver(calendarFormSchema),
        defaultValues: calendar
            ? { name: calendar.name, color: calendar.color }
            : {
                  name: '',
                  color: EIGEN_ACCENT_COLORS_SHUFFLED[calendarCount % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
              },
    });
    const name = form.watch('name');

    return (
        <Form {...form}>
            <FormDialogForm
                canSubmit={name.trim() !== ''}
                submitLabel="Save"
                // A failed check resolves without saving, and returning false keeps its messages in view.
                onSubmit={async () => {
                    let saved = false;
                    await form.handleSubmit(async (data) => {
                        if (calendar) await updateCalendar.mutateAsync({ id: calendar.id, ...data, shares });
                        else await createCalendar.mutateAsync(data);
                        saved = true;
                    })();
                    if (!saved) return false;
                }}
                footerStart={
                    calendar &&
                    !calendar.isDefault && (
                        <Button variant="destructive" onClick={onDelete}>
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
                                    <ColorPickerSwatch value={field.value} onChange={field.onChange} />
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
                                    <Input placeholder="Enter calendar name" autoFocus {...field} />
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
