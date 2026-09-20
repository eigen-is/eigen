import { useAuth } from '@workspace/lib/auth';
import {
    useCalendars,
    useCreateCalendar,
    useImportCalendarFromDrive,
    useImportCalendarFromUrl,
} from '@workspace/lib/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import { importSourceOf, subjectInfo } from '@workspace/lib/file-subject';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDialogPending } from '../../hooks/use-dialog-pending';
import { Button } from '../button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog';
import { Input } from '../input';
import { Label } from '../label';
import { useOptionalPreview } from '../preview-provider/preview-context';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';

// The option that stands for "somewhere that does not exist yet"; no calendar id can collide with it.
const NEW_CALENDAR = 'new';
// No target chosen yet, because the calendars have not arrived: the Select shows its placeholder.
const NO_TARGET = '';

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
    const [target, setTarget] = useState(NO_TARGET);
    const [name, setName] = useState('');
    // Applied once, when the calendars first arrive: a refetch must not overwrite what the user chose or typed.
    const defaultsApplied = useRef(false);
    // A failed import leaves the dialog open for a retry, which must import into the calendar the first
    // attempt created rather than make a second one of the same name.
    const createdCalendarId = useRef<string | null>(null);
    const { pending, run, handleOpenChange } = useDialogPending((next) => {
        if (!next) onClose();
    });

    const fileName = subject ? subjectInfo(subject).name : '';
    const defaultName = fileName.replace(/\.ics$/i, '') || 'Imported calendar';
    const defaultTarget = calendars?.find((cal) => cal.isDefault)?.id ?? calendars?.[0]?.id ?? NEW_CALENDAR;

    useEffect(() => {
        if (!open) {
            defaultsApplied.current = false;
            createdCalendarId.current = null;
            return;
        }
        if (defaultsApplied.current || !calendars) return;
        defaultsApplied.current = true;
        setTarget(defaultTarget);
        setName(defaultName);
    }, [open, calendars, defaultTarget, defaultName]);

    const isNew = target === NEW_CALENDAR;

    const handleSubmit = () =>
        run(async () => {
            if (!subject) return;
            const source = importSourceOf(subject);
            if (!source) return;
            let calendarId = target;
            if (isNew) {
                if (!createdCalendarId.current) {
                    const created = await createCalendar.mutateAsync({
                        name: name.trim(),
                        color: EIGEN_ACCENT_COLORS_SHUFFLED[
                            (calendars?.length ?? 0) % EIGEN_ACCENT_COLORS_SHUFFLED.length
                        ].value,
                    });
                    createdCalendarId.current = created.id;
                }
                calendarId = createdCalendarId.current;
            }
            if (source.drive) await importFromDrive.mutateAsync({ calendarId, ...source.drive });
            else await importFromUrl.mutateAsync({ url: source.url, calendarId });
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
                    <Select value={target} onValueChange={setTarget} disabled={!calendars}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder={calendars ? 'Select calendar' : 'Loading calendars…'} />
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
                    <Button onClick={handleSubmit} disabled={pending || !target || (isNew && !name.trim())}>
                        {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        Import
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
