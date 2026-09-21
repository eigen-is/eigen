import { useAuth } from '@workspace/lib/auth';
import {
    isTransferableCalendarHome,
    useCalendarOptions,
    useCalendars,
    useImportToCalendar,
    useSharedCalendars,
} from '@workspace/lib/calendar';
import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import { importSourceOf, subjectInfo } from '@workspace/lib/file-subject';
import { parseOwnerId } from '@workspace/lib/types';
import type { CalendarOption } from '@workspace/lib/types/calendar';
import type { FileSubject } from '@workspace/lib/types/file-subject';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDialogPending } from '../../hooks/use-dialog-pending';
import { Button } from '../button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog';
import { Input } from '../input';
import { Label } from '../label';
import { ErrorState } from '../layout/app/error-state';
import { useOptionalPreview } from '../preview-provider/preview-context';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../select';

// The option that stands for "somewhere that does not exist yet". A leading colon is what keeps it out of
// the target space: every other value is a home and a calendar id joined by one, and a home is never empty.
const NEW_CALENDAR = ':new';

const targetValue = (option: CalendarOption) => `${option.ownerId}/${option.id}`;

const renderTarget = (option: CalendarOption) => (
    <SelectItem key={targetValue(option)} value={targetValue(option)}>
        <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: option.color }} />
            {option.name}
        </div>
    </SelectItem>
);

type ImportToCalendarPickerProps = {
    subject: FileSubject | null;
    open: boolean;
    onClose: () => void;
};

// The "which calendar does this go into" dialog, the one thing an .ics import needs that a contacts or
// a mail import does not. The viewer's own calendars and the team calendars they may write in are the
// targets: a calendar shared out of another user's home is refused by the import route.
export function ImportToCalendarPicker({ subject, open, onClose }: ImportToCalendarPickerProps) {
    const { user } = useAuth();
    const preview = useOptionalPreview();
    const ownerId = user?.id ?? '';
    // Every runner host mounts this dialog closed, so neither list is asked for until it opens.
    const { data: calendars, isError, refetch } = useCalendars(ownerId, open);
    const { data: sharedCalendars } = useSharedCalendars(ownerId, open);
    const { importToCalendar, forgetNewCalendar } = useImportToCalendar(ownerId);
    // No target chosen yet, because the calendars have not arrived: the Select shows its placeholder.
    const [target, setTarget] = useState('');
    const [name, setName] = useState('');
    // Applied once, when the calendars first arrive: a refetch must not overwrite what the user chose or typed.
    const defaultsApplied = useRef(false);
    const { pending, run, handleOpenChange } = useDialogPending((next) => {
        if (!next) onClose();
    });

    // A calendar shared out of another user's home is refused by the import route, so it is no target.
    const options = useCalendarOptions(ownerId, calendars ?? [], sharedCalendars ?? []).filter((option) =>
        isTransferableCalendarHome(option.ownerId, ownerId),
    );
    const ownTargets = options.filter((option) => option.ownerId === ownerId);
    const teamTargets = options.filter((option) => parseOwnerId(option.ownerId).type === 'team');

    const fileName = subject ? subjectInfo(subject).name : '';
    const defaultName = fileName.replace(/\.ics$/i, '') || 'Imported calendar';
    // A team calendar is never the default: the file is the viewer's own until they say otherwise.
    const defaultCalendarId = calendars?.find((cal) => cal.isDefault)?.id ?? calendars?.[0]?.id;
    const defaultTarget = defaultCalendarId ? `${ownerId}/${defaultCalendarId}` : NEW_CALENDAR;

    useEffect(() => {
        if (!open) {
            defaultsApplied.current = false;
            forgetNewCalendar();
            return;
        }
        if (defaultsApplied.current || !calendars) return;
        defaultsApplied.current = true;
        setTarget(defaultTarget);
        setName(defaultName);
    }, [open, calendars, defaultTarget, defaultName, forgetNewCalendar]);

    const isNew = target === NEW_CALENDAR;

    const handleSubmit = () =>
        run(async () => {
            if (!subject) return;
            const source = importSourceOf(subject);
            if (!source) return;
            // A new calendar is always made in the viewer's own home; a team home is only ever written into.
            if (isNew) {
                await importToCalendar(source, {
                    kind: 'new',
                    name: name.trim(),
                    color: EIGEN_ACCENT_COLORS_SHUFFLED[(calendars?.length ?? 0) % EIGEN_ACCENT_COLORS_SHUFFLED.length]
                        .value,
                });
                return;
            }
            const chosen = options.find((option) => targetValue(option) === target);
            if (!chosen) return;
            await importToCalendar(source, { kind: 'existing', ownerId: chosen.ownerId, calendarId: chosen.id });
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

                {isError ? (
                    <ErrorState
                        message="Could not load your calendars"
                        action={
                            <Button variant="outline" onClick={() => refetch()}>
                                Try again
                            </Button>
                        }
                    />
                ) : (
                    <div className="space-y-3">
                        <Select value={target} onValueChange={setTarget} disabled={!calendars}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder={calendars ? 'Select calendar' : 'Loading calendars…'} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    <SelectLabel>My Calendars</SelectLabel>
                                    {ownTargets.map(renderTarget)}
                                </SelectGroup>
                                {teamTargets.length > 0 && (
                                    <SelectGroup>
                                        <SelectLabel>Team Calendars</SelectLabel>
                                        {teamTargets.map(renderTarget)}
                                    </SelectGroup>
                                )}
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
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={pending}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit} disabled={pending || isError || !target || (isNew && !name.trim())}>
                        {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        Import
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
