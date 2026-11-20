// The settings of a calendar someone else owns, such as one shared with the user or a team's: the color the user
// sees it in, and for a shared one, removing it from their list. The sidebar opens it.

import { useAuth } from '@workspace/lib/auth';
import { useCalendarAccess, useDeleteSharedCalendar, useUpdateSharedCalendar } from '@workspace/lib/calendar';
import { parseOwnerId } from '@workspace/lib/types';
import type { SharedCalendar } from '@workspace/lib/types/calendar';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { Field, FieldContent, FieldTitle } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { ColorPickerSwatch } from '@workspace/ui/components/media';
import { Separator } from '@workspace/ui/components/separator';
import { UserItem } from '@workspace/ui/components/user';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CALENDAR_PERMISSION_LABELS } from './calendar-share-editor';

type SharedCalendarConfigDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sharedCalendar: SharedCalendar | null;
};

export function SharedCalendarConfigDialog({ open, onOpenChange, sharedCalendar }: SharedCalendarConfigDialogProps) {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    const deleteSharedCalendar = useDeleteSharedCalendar(ownerId);
    const [showRemoveConfirmation, setShowRemoveConfirmation] = useState(false);

    if (!sharedCalendar) return null;

    return (
        <>
            <FormDialog
                open={open}
                onOpenChange={onOpenChange}
                title="Shared calendar settings"
                size="sm"
                description={`${sharedCalendar.calendarName} — ${CALENDAR_PERMISSION_LABELS[sharedCalendar.permission]}`}
            >
                <SharedCalendarConfigForm
                    ownerId={ownerId}
                    sharedCalendar={sharedCalendar}
                    onRemove={() => setShowRemoveConfirmation(true)}
                />
            </FormDialog>

            {/* Stacked on the open form, so a cancelled remove leaves the color as the user left it. */}
            <ConfirmDialog
                open={showRemoveConfirmation}
                onOpenChange={setShowRemoveConfirmation}
                title="Remove shared calendar"
                description={
                    <>
                        Remove <strong>{sharedCalendar.calendarName}</strong> from your view? You can be re-added by the
                        owner.
                    </>
                }
                confirmText="Remove"
                destructive
                onConfirm={async () => {
                    await deleteSharedCalendar.mutateAsync(sharedCalendar.id);
                    onOpenChange(false);
                }}
            />
        </>
    );
}

// Mounted with the dialog, so each opening starts from the color the user sees the calendar in.
function SharedCalendarConfigForm({
    ownerId,
    sharedCalendar,
    onRemove,
}: {
    ownerId: string;
    sharedCalendar: SharedCalendar;
    onRemove: () => void;
}) {
    const [color, setColor] = useState(sharedCalendar.color || sharedCalendar.calendarColor);

    const updateSharedCalendar = useUpdateSharedCalendar(ownerId);
    const { data: accessData } = useCalendarAccess(sharedCalendar.ownerUserId, sharedCalendar.calendarId);

    const isTeamCalendar = parseOwnerId(sharedCalendar.ownerUserId).type === 'team';

    return (
        <FormDialogForm
            submitLabel="Save"
            onSubmit={async () => {
                await updateSharedCalendar.mutateAsync({
                    id: sharedCalendar.id,
                    color: color !== sharedCalendar.calendarColor ? color : null,
                });
            }}
            footerStart={
                !isTeamCalendar && <TooltipButton icon={Trash2} tooltipText="Remove calendar" onClick={onRemove} />
            }
        >
            <Field>
                <FieldTitle>Color</FieldTitle>
                <FieldContent>
                    <ColorPickerSwatch value={color} onChange={setColor} />
                </FieldContent>
            </Field>

            {!isTeamCalendar && (
                <>
                    <Separator />
                    <Field>
                        <FieldTitle>People with access</FieldTitle>
                        <FieldContent className="gap-3">
                            <UserItem userId={sharedCalendar.ownerUserId} label="Owner" />
                            {accessData?.shares?.map((share) => (
                                <UserItem
                                    key={share.targetId}
                                    email={share.targetId}
                                    label={CALENDAR_PERMISSION_LABELS[share.permission]}
                                />
                            ))}
                        </FieldContent>
                    </Field>
                </>
            )}
        </FormDialogForm>
    );
}
