// The dialog that creates one of the user's own calendars or edits it: name, color and the people it is shared
// with. It also deletes the calendar. Create or Save refuses a name of only spaces under the field, and saves the name
// trimmed. The sidebar opens it.

import { useAuth } from '@workspace/lib/auth';
import { useCreateCalendar, useDeleteCalendar, useUpdateCalendar } from '@workspace/lib/calendar';
import { CALENDAR_NAME_MAX_LENGTH } from '@workspace/lib/constants/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import { FIELD_MESSAGES } from '@workspace/lib/validation';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { ColorPickerSwatch } from '@workspace/ui/components/media';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import { Separator } from '@workspace/ui/components/separator';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CalendarShareEditor, ShareWithTeamButton, useShareInput } from './calendar-share-editor';

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
            <FormDialog open={open} onOpenChange={onOpenChange} title={calendar ? 'Edit calendar' : 'New calendar'}>
                <CalendarConfigForm
                    ownerId={ownerId}
                    calendar={calendar}
                    calendarCount={calendarCount}
                    onDelete={() => setShowDeleteConfirmation(true)}
                />
            </FormDialog>

            {/* Stacked on the open form, so a canceled delete leaves its edits in place. */}
            <ConfirmDialog
                open={showDeleteConfirmation}
                onOpenChange={setShowDeleteConfirmation}
                title="Delete calendar"
                description={
                    <>
                        Are you sure you want to delete <strong>{calendar?.name}</strong>? All events in it will be
                        lost.
                    </>
                }
                onConfirm={async () => {
                    if (!calendar) return;
                    await deleteCalendar.mutateAsync(calendar.id);
                    onOpenChange(false);
                }}
                confirmText="Delete"
                destructive
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
    const [opened] = useState(() => ({
        name: calendar?.name ?? '',
        color:
            calendar?.color ?? EIGEN_ACCENT_COLORS_SHUFFLED[calendarCount % EIGEN_ACCENT_COLORS_SHUFFLED.length].value,
        shares: calendar?.shares ?? null,
    }));
    const [name, setName] = useState(opened.name);
    const [color, setColor] = useState(opened.color);
    const [shares, setShares] = useState<CalendarShare[] | null>(opened.shares);
    const shareInput = useShareInput({ shares, onChange: setShares });

    const createCalendar = useCreateCalendar(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);

    // Every edit of the shares makes a new list.
    const changed = name !== opened.name || color !== opened.color || shares !== opened.shares || shareInput.hasText;

    return (
        <FormDialogForm
            changed={changed}
            submitLabel={calendar ? 'Save' : 'Create'}
            onSubmit={async () => {
                const typedShares = shareInput.commitShares();
                if (!name.trim() || typedShares === false) return false;
                const data = { name: name.trim(), color };
                if (calendar)
                    await updateCalendar.mutateAsync({ id: calendar.id, ...data, shares: typedShares ?? shares });
                else await createCalendar.mutateAsync(data);
            }}
            footerStart={
                calendar && (
                    <>
                        {!calendar.isDefault && (
                            <TooltipButton icon={Trash2} tooltipText="Delete calendar" onClick={onDelete} />
                        )}
                        <ShareWithTeamButton shares={shares} onChange={setShares} />
                    </>
                )
            }
        >
            <RequiredTextField
                label="Calendar name"
                placeholder="Enter calendar name"
                maxLength={CALENDAR_NAME_MAX_LENGTH}
                value={name}
                onChange={setName}
                message={FIELD_MESSAGES.nameMissing}
                addon={<ColorPickerSwatch value={color} onChange={setColor} className="size-6 rounded-sm" />}
            />

            {calendar && (
                <>
                    <Separator />
                    <CalendarShareEditor shares={shares} onChange={setShares} input={shareInput} />
                </>
            )}
        </FormDialogForm>
    );
}
