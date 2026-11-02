// The dialog that imports an .ics file into a calendar: one of the viewer's own, a team calendar they may write in, or
// a new one named after the file. Enter in the name submits, and a failed import stays open for another try. A file
// action, such as Import to Calendar on a mail attachment, opens it.

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
import { useState } from 'react';
import { Button } from '../button';
import { FormDialog, FormDialogForm } from '../form-dialog';
import { Input } from '../input';
import { Label } from '../label';
import { ErrorState } from '../layout/app/error-state';
import { useOptionalPreview } from '../preview-provider/preview-context';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../select';

// The leading colon keeps this out of the target space: every real value is a home and a calendar id joined by one.
const NEW_CALENDAR = ':new';

type ImportToCalendarPickerProps = {
    subject: FileSubject | null;
    open: boolean;
    onClose: () => void;
};

export function ImportToCalendarPicker({ subject, open, onClose }: ImportToCalendarPickerProps) {
    const preview = useOptionalPreview();
    const fileName = subject ? subjectInfo(subject).name : '';

    return (
        <FormDialog
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            title="Import to Calendar"
            description={`Pick the calendar ${fileName ? `“${fileName}”` : 'this file'} lands in.`}
            size="sm"
            abovePreview={preview?.isPreviewOpen}
        >
            <ImportToCalendarForm subject={subject} fileName={fileName} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening asks for the calendars and starts from the defaults. The import hook lives
// here too: a new calendar it made for a failed try is reused by the next try, and forgotten when the dialog closes.
function ImportToCalendarForm({ subject, fileName }: { subject: FileSubject | null; fileName: string }) {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    const { data: calendars, isError, refetch } = useCalendars(ownerId);
    const { data: sharedCalendars } = useSharedCalendars(ownerId);
    const { importToCalendar } = useImportToCalendar(ownerId);

    // The import route refuses a calendar shared out of another user's home, so only own and writable team calendars
    // are offered.
    const options = useCalendarOptions(ownerId, calendars ?? [], sharedCalendars ?? []).filter((option) =>
        isTransferableCalendarHome(option.ownerId, ownerId),
    );
    const ownTargets = options.filter((option) => option.ownerId === ownerId);
    const teamTargets = options.filter((option) => parseOwnerId(option.ownerId).type === 'team');

    // A team calendar is never the default: the file is the viewer's own until they say otherwise.
    const defaultCalendarId = calendars?.find((cal) => cal.isDefault)?.id ?? calendars?.[0]?.id;
    const defaultTarget = defaultCalendarId ? `${ownerId}/${defaultCalendarId}` : NEW_CALENDAR;
    // Until the user picks one, the target follows the default, so a later fetch never overwrites a choice. While the
    // calendars load there is none, and the Select shows its placeholder.
    const [chosenTarget, setChosenTarget] = useState<string>();
    const target = chosenTarget ?? (calendars ? defaultTarget : '');
    const [name, setName] = useState(fileName.replace(/\.ics$/i, '') || 'Imported calendar');
    const isNew = target === NEW_CALENDAR;

    const handleSubmit = async () => {
        if (!subject) return;
        const source = importSourceOf(subject);
        if (!source) return;
        // A new calendar is always made in the viewer's own home; a team home is only ever written into.
        if (isNew) {
            const color =
                EIGEN_ACCENT_COLORS_SHUFFLED[(calendars?.length ?? 0) % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;
            await importToCalendar(source, { kind: 'new', name: name.trim(), color });
            return;
        }
        const chosen = options.find((option) => targetValue(option) === target);
        if (!chosen) return;
        await importToCalendar(source, { kind: 'existing', ownerId: chosen.ownerId, calendarId: chosen.id });
    };

    return (
        <FormDialogForm
            onSubmit={handleSubmit}
            canSubmit={!isError && target !== '' && (!isNew || name.trim() !== '')}
            submitLabel="Import"
        >
            {isError ? (
                <ErrorState
                    message="Could not load your calendars"
                    action={
                        <Button type="button" variant="outline" onClick={() => refetch()}>
                            Try again
                        </Button>
                    }
                />
            ) : (
                <div className="space-y-3">
                    <Select value={target} onValueChange={setChosenTarget} disabled={!calendars}>
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder={calendars ? 'Select calendar' : 'Loading calendars…'} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectGroup>
                                <SelectLabel>My calendars</SelectLabel>
                                {ownTargets.map(renderTarget)}
                            </SelectGroup>
                            {teamTargets.length > 0 && (
                                <SelectGroup>
                                    <SelectLabel>Team calendars</SelectLabel>
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
        </FormDialogForm>
    );
}

const targetValue = (option: CalendarOption) => `${option.ownerId}/${option.id}`;

const renderTarget = (option: CalendarOption) => (
    <SelectItem key={targetValue(option)} value={targetValue(option)}>
        <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: option.color }} />
            {option.name}
        </div>
    </SelectItem>
);
