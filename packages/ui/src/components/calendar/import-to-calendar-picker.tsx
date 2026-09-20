import { useAuth } from '@workspace/lib/auth';
import {
    useCalendars,
    useCreateCalendar,
    useImportCalendarFromDrive,
    useImportCalendarFromUrl,
} from '@workspace/lib/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import { subjectInfo } from '@workspace/lib/file-subject';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDialogPending } from '../../hooks/use-dialog-pending';
import { Button } from '../button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog';
import { Input } from '../input';
import { Label } from '../label';
import { useOptionalPreview } from '../preview-provider/preview-context';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';

// The option that stands for "somewhere that does not exist yet"; no calendar id can collide with it.
const NEW_CALENDAR = 'new';

type ImportToCalendarPickerProps = {
    subject: FileSubject | null;
    open: boolean;
    onClose: () => void;
};

// The "which calendar does this go into" dialog, the one thing an .ics import needs that a contacts or
// a mail import does not. Only calendars this home owns are offered: a calendar shared with the viewer
// lives in another home, which the import route refuses.
export function ImportToCalendarPicker({ subject, open, onClose }: ImportToCalendarPickerProps) {
    const { user } = useAuth();
    const preview = useOptionalPreview();
    const ownerId = user?.id ?? '';
    const { data: calendars } = useCalendars(ownerId);
    const createCalendar = useCreateCalendar(ownerId);
    const importFromDrive = useImportCalendarFromDrive();
    const importFromUrl = useImportCalendarFromUrl();
    const [target, setTarget] = useState(NEW_CALENDAR);
    const [name, setName] = useState('');
    const { pending, run, handleOpenChange } = useDialogPending((next) => {
        if (!next) onClose();
    });

    const fileName = subject ? subjectInfo(subject).name : '';
    const defaultName = fileName.replace(/\.ics$/i, '') || 'Imported calendar';
    const defaultTarget = calendars?.find((cal) => cal.isDefault)?.id ?? calendars?.[0]?.id ?? NEW_CALENDAR;

    useEffect(() => {
        if (!open) return;
        setTarget(defaultTarget);
        setName(defaultName);
    }, [open, defaultTarget, defaultName]);

    const isNew = target === NEW_CALENDAR;

    const handleSubmit = () =>
        run(async () => {
            if (!subject) return;
            let calendarId = target;
            if (isNew) {
                const created = await createCalendar.mutateAsync({
                    name: name.trim(),
                    color: EIGEN_ACCENT_COLORS_SHUFFLED[(calendars?.length ?? 0) % EIGEN_ACCENT_COLORS_SHUFFLED.length]
                        .value,
                });
                calendarId = created.id;
            }
            const { drive } = subject;
            if (drive) {
                await importFromDrive.mutateAsync({
                    calendarId,
                    sourceOwnerId: drive.ownerId,
                    sourceMountId: drive.mountId,
                    sourcePathId: drive.id,
                });
                return;
            }
            const { downloadUrl } = subjectInfo(subject);
            if (downloadUrl) await importFromUrl.mutateAsync({ url: downloadUrl, calendarId });
        });

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent size="sm" abovePreview={preview?.isPreviewOpen}>
                <DialogHeader>
                    <DialogTitle>Import to Calendar</DialogTitle>
                    <DialogDescription>
                        Pick the calendar {fileName ? `“${fileName}”` : 'this file'} lands in.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <Select value={target} onValueChange={setTarget}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select calendar" />
                        </SelectTrigger>
                        <SelectContent>
                            {calendars?.map((cal) => (
                                <SelectItem key={cal.id} value={cal.id}>
                                    <div className="flex items-center gap-2">
                                        <div
                                            className="h-3 w-3 rounded-full shrink-0"
                                            style={{ backgroundColor: cal.color }}
                                        />
                                        {cal.name}
                                    </div>
                                </SelectItem>
                            ))}
                            <SelectItem value={NEW_CALENDAR}>New calendar</SelectItem>
                        </SelectContent>
                    </Select>

                    {isNew && (
                        <div>
                            <Label htmlFor="import-calendar-name" className="text-sm text-muted-foreground">
                                Calendar name
                            </Label>
                            <Input
                                id="import-calendar-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="mt-1.5"
                            />
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={pending}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit} disabled={pending || (isNew && !name.trim())}>
                        {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        Import
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
