import {useEffect, useState} from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Popover, PopoverContent, PopoverTrigger} from '@workspace/ui/components/popover';
import {ColorPicker} from '@workspace/ui/components/layout/media/color-picker';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';
import {useCalendarAccess, useDeleteSharedCalendar, useUpdateSharedCalendar} from '@workspace/lib/calendar';
import {useAuth} from '@workspace/lib/auth';
import {parseOwnerId} from '@workspace/lib/types';
import type {SharedCalendar} from '@workspace/lib/types/calendar';
import {Label} from '@workspace/ui/components/label';
import {UserItem} from '@workspace/ui/components/layout/user-item';
import {Separator} from '@workspace/ui/components/separator';

type SharedCalendarConfigDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sharedCalendar: SharedCalendar | null;
}

export function SharedCalendarConfigDialog({open, onOpenChange, sharedCalendar}: SharedCalendarConfigDialogProps) {
    const {user} = useAuth();
    const ownerId = user?.id || '';
    const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
    const [colorPickerOpen, setColorPickerOpen] = useState(false);
    const [color, setColor] = useState<string>('');
    const [isLoading, setIsLoading] = useState(false);

    const updateSharedCalendar = useUpdateSharedCalendar(ownerId);
    const deleteSharedCalendar = useDeleteSharedCalendar(ownerId);
    const {data: accessData} = useCalendarAccess(
        sharedCalendar?.ownerUserId || '',
        sharedCalendar?.calendarId || '',
        open && !!sharedCalendar,
    );

    useEffect(() => {
        if (sharedCalendar && open) {
            setColor(sharedCalendar.color || sharedCalendar.calendarColor);
        }
    }, [sharedCalendar, open]);

    if (!sharedCalendar) return null;

    const isTeamCalendar = parseOwnerId(sharedCalendar.ownerUserId).type === 'team';

    const handleSave = async () => {
        try {
            setIsLoading(true);
            await updateSharedCalendar.mutateAsync({
                id: sharedCalendar.id,
                color: color !== sharedCalendar.calendarColor ? color : null,
            });
            onOpenChange(false);
        } catch (error) {
            console.error('Error updating shared calendar:', error);
        } finally {
            setTimeout(() => setIsLoading(false), 350);
        }
    };

    const handleDelete = async () => {
        try {
            await deleteSharedCalendar.mutateAsync(sharedCalendar.id);
            setShowDeleteConfirmation(false);
            onOpenChange(false);
        } catch (error) {
            console.error('Error removing shared calendar:', error);
        }
    };

    return (
        <>
            <Dialog open={open && !showDeleteConfirmation} onOpenChange={onOpenChange}>
                <DialogContent size="sm">
                    <DialogHeader>
                        <DialogTitle>Shared Calendar Settings</DialogTitle>
                        <DialogDescription>
                            {sharedCalendar.calendarName} — {sharedCalendar.permission} access
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="flex items-center gap-3">
                            <Label>Color</Label>
                            <Popover open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
                                <PopoverTrigger asChild>
                                    <button
                                        type="button"
                                        className="h-9 w-9 rounded-md border border-input shrink-0"
                                        style={{backgroundColor: color}}
                                        disabled={isLoading}
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
                                <Separator/>

                                <div>
                                    <Label className="text-sm font-semibold">People with access</Label>
                                    <div className="mt-2 space-y-3">
                                        <UserItem userId={sharedCalendar.ownerUserId} label="Owner"/>
                                        {accessData?.shares?.map((share, i) => (
                                            <UserItem
                                                key={i}
                                                email={share.targetId}
                                                label={share.permission === 'write' ? 'Editor' : share.permission === 'read' ? 'Viewer' : share.permission}
                                            />
                                        ))}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    <DialogFooter>
                        {!isTeamCalendar && (
                            <Button
                                type="button"
                                variant="destructive"
                                onClick={() => setShowDeleteConfirmation(true)}
                                disabled={isLoading}
                                className="mr-auto"
                            >
                                Remove
                            </Button>
                        )}
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}
                                disabled={isLoading}>
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={isLoading}>
                            {isLoading ? 'Saving...' : 'Save'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteDialog
                open={showDeleteConfirmation}
                onOpenChange={setShowDeleteConfirmation}
                title="Remove Shared Calendar"
                description="Remove this shared calendar from your view? You can be re-added by the owner."
                itemName={sharedCalendar.calendarName}
                onDelete={handleDelete}
            />
        </>
    );
}
