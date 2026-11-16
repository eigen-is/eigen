// The settings of a calendar someone else owns, such as one shared with the user or a team's: the color the user
// sees it in, and for a shared one, removing it from their list. The sidebar opens it.

import { useAuth } from '@workspace/lib/auth';
import { useCalendarAccess, useDeleteSharedCalendar, useUpdateSharedCalendar } from '@workspace/lib/calendar';
import { parseOwnerId } from '@workspace/lib/types';
import type { CalendarShare, SharedCalendar } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Label } from '@workspace/ui/components/label';
import { ColorPickerSwatch } from '@workspace/ui/components/media';
import { Separator } from '@workspace/ui/components/separator';
import { UserItem } from '@workspace/ui/components/user';
import { useState } from 'react';

const PERMISSION_LABELS: Partial<Record<CalendarShare['permission'], string>> = { write: 'Editor', read: 'Viewer' };

type SharedCalendarConfigDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sharedCalendar: SharedCalendar | null;
};

export function SharedCalendarConfigDialog({ open, onOpenChange, sharedCalendar }: SharedCalendarConfigDialogProps) {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    const deleteSharedCalendar = useDeleteSharedCalendar(ownerId);
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);

    if (!sharedCalendar) return null;

    return (
        <>
            <FormDialog
                open={open}
                onOpenChange={onOpenChange}
                title="Shared calendar settings"
                description={`${sharedCalendar.calendarName} — ${sharedCalendar.permission} access`}
                size="sm"
            >
                <SharedCalendarConfigForm
                    ownerId={ownerId}
                    sharedCalendar={sharedCalendar}
                    onRemove={() => setShowDeleteConfirmation(true)}
                />
            </FormDialog>

            {/* Stacked on the open form, so a cancelled remove leaves the color as the user left it. */}
            <DeleteDialog
                open={showDeleteConfirmation}
                onOpenChange={setShowDeleteConfirmation}
                title="Remove shared calendar"
                description="Remove this shared calendar from your view? You can be re-added by the owner."
                itemName={sharedCalendar.calendarName}
                onDelete={async () => {
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
                !isTeamCalendar && (
                    <Button variant="destructive" onClick={onRemove}>
                        Remove
                    </Button>
                )
            }
        >
            <div className="space-y-4">
                <div className="flex items-center gap-3">
                    <Label>Color</Label>
                    <ColorPickerSwatch value={color} onChange={setColor} />
                </div>

                {!isTeamCalendar && (
                    <>
                        <Separator />

                        <div>
                            <Label className="text-sm font-medium">People with access</Label>
                            <div className="mt-2 space-y-3">
                                <UserItem userId={sharedCalendar.ownerUserId} label="Owner" />
                                {accessData?.shares?.map((share) => (
                                    <UserItem
                                        key={share.targetId}
                                        email={share.targetId}
                                        label={PERMISSION_LABELS[share.permission] ?? share.permission}
                                    />
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </FormDialogForm>
    );
}
