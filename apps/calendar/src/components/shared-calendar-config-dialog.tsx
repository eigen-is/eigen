// The settings of a calendar someone else owns, such as one shared with the user or a team's: the color the user
// sees it in, and for a shared one, removing it from their list. The sidebar opens it.

import { useAuth } from '@workspace/lib/auth';
import { useCalendarAccess, useDeleteSharedCalendar, useUpdateSharedCalendar } from '@workspace/lib/calendar';
import { parseOwnerId } from '@workspace/lib/types';
import type { SharedCalendar } from '@workspace/lib/types/calendar';
import { DeleteDialog, FormDialog, FormDialogForm } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Label } from '@workspace/ui/components/label';
import { ColorPicker } from '@workspace/ui/components/media';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Separator } from '@workspace/ui/components/separator';
import { UserItem } from '@workspace/ui/components/user';
import { useState } from 'react';

type SharedCalendarConfigDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sharedCalendar: SharedCalendar | null;
};

export function SharedCalendarConfigDialog({ open, onOpenChange, sharedCalendar }: SharedCalendarConfigDialogProps) {
    const { user } = useAuth();
    const deleteSharedCalendar = useDeleteSharedCalendar(user?.id || '');
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
    sharedCalendar,
    onRemove,
}: {
    sharedCalendar: SharedCalendar;
    onRemove: () => void;
}) {
    const { user } = useAuth();
    const [colorPickerOpen, setColorPickerOpen] = useState(false);
    const [color, setColor] = useState(sharedCalendar.color || sharedCalendar.calendarColor);

    const updateSharedCalendar = useUpdateSharedCalendar(user?.id || '');
    const { data: accessData } = useCalendarAccess(sharedCalendar.ownerUserId, sharedCalendar.calendarId);

    const isTeamCalendar = parseOwnerId(sharedCalendar.ownerUserId).type === 'team';

    return (
        <FormDialogForm
            submitLabel="Save"
            onSubmit={() =>
                updateSharedCalendar.mutateAsync({
                    id: sharedCalendar.id,
                    color: color !== sharedCalendar.calendarColor ? color : null,
                })
            }
            footerStart={
                !isTeamCalendar && (
                    <Button
                        type="button"
                        variant="destructive"
                        onClick={onRemove}
                        disabled={updateSharedCalendar.isPending}
                    >
                        Remove
                    </Button>
                )
            }
        >
            <div className="space-y-4">
                <div className="flex items-center gap-3">
                    <Label>Color</Label>
                    <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                className="h-9 w-9 rounded-md border border-input shrink-0"
                                style={{ backgroundColor: color }}
                                disabled={updateSharedCalendar.isPending}
                            />
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-3" align="start">
                            <ColorPicker
                                value={color}
                                onChange={(c) => {
                                    setColor(c);
                                    setColorPickerOpen(false);
                                }}
                                showReset={false}
                            />
                        </PopoverContent>
                    </Popover>
                </div>

                {!isTeamCalendar && (
                    <>
                        <Separator />

                        <div>
                            <Label className="text-sm font-medium">People with access</Label>
                            <div className="mt-2 space-y-3">
                                <UserItem userId={sharedCalendar.ownerUserId} label="Owner" />
                                {accessData?.shares?.map((share, i) => (
                                    <UserItem
                                        key={i}
                                        email={share.targetId}
                                        label={
                                            share.permission === 'write'
                                                ? 'Editor'
                                                : share.permission === 'read'
                                                  ? 'Viewer'
                                                  : share.permission
                                        }
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
