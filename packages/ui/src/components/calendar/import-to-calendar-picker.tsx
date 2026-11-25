// The dialog that imports an .ics file into a calendar: one of the viewer's own, a team calendar they may write in, or
// a new one named after the file. Enter in the name submits, a missing calendar or name says so under its field, and
// a failed import stays open for another try. Until the calendars load it offers only Close. A file action, such as
// Import to Calendar on a mail attachment, opens it.

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
import type { FileImportSource, FileSubject } from '@workspace/lib/types/file-subject';
import { useState } from 'react';
import { Button } from '../button';
import { Field, FieldError, FieldLabel } from '../field';
import { FormDialog, FormDialogForm } from '../form-dialog';
import { useFormSubmitted } from '../form-shell';
import { Input } from '../input';
import { ErrorState } from '../layout/app/error-state';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../select';

// The leading colon keeps this out of the target space: every real value is a home and a calendar id joined by one.
const NEW_CALENDAR = ':new';

type ImportToCalendarPickerProps = {
    subject: FileSubject | null;
    open: boolean;
    onClose: () => void;
};

export function ImportToCalendarPicker({ subject, open, onClose }: ImportToCalendarPickerProps) {
    const fileName = subject ? subjectInfo(subject).name : '';
    // Null only for a subject with no bytes, such as a folder, which no import row is offered for.
    const source = subject && importSourceOf(subject);

    return (
        <FormDialog
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            title="Import to Calendar"
            description={`Pick the calendar ${fileName ? `“${fileName}”` : 'this file'} lands in.`}
        >
            {source && <ImportToCalendarForm source={source} fileName={fileName} />}
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening asks for the calendars and starts from the defaults.
function ImportToCalendarForm({ source, fileName }: { source: FileImportSource; fileName: string }) {
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
    // Until the user picks, the target follows the default, so a later fetch never overwrites a choice. A choice a later
    // fetch drops leaves nothing chosen, rather than a quiet switch to another calendar.
    const [chosenTarget, setChosenTarget] = useState<string>();
    const picked = chosenTarget ?? (calendars ? defaultTarget : '');
    const chosen = options.find((option) => targetValue(option) === picked);
    const isNew = picked === NEW_CALENDAR;
    const target = chosen || isNew ? picked : '';
    const [defaultName] = useState(fileName.replace(/\.ics$/i, '') || 'Imported calendar');
    const [name, setName] = useState(defaultName);

    const handleSubmit = async () => {
        if (chosen) {
            await importToCalendar(source, { kind: 'existing', ownerId: chosen.ownerId, calendarId: chosen.id });
            return;
        }
        if (!isNew || !name.trim()) return false;
        // A new calendar is always made in the viewer's own home; a team home is only ever written into.
        const color =
            EIGEN_ACCENT_COLORS_SHUFFLED[(calendars?.length ?? 0) % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;
        await importToCalendar(source, { kind: 'new', name: name.trim(), color });
    };

    return (
        <FormDialogForm
            onSubmit={handleSubmit}
            changed={isNew && name !== defaultName}
            readOnly={isError || !calendars}
            submitLabel="Import"
        >
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
                <TargetFields
                    target={target}
                    onTargetChange={setChosenTarget}
                    loading={!calendars}
                    ownTargets={ownTargets}
                    teamTargets={teamTargets}
                    name={isNew ? name : undefined}
                    onNameChange={setName}
                />
            )}
        </FormDialogForm>
    );
}

// The calendar to add to, and the name of a new one. Once Import was pressed, a missing one says so under its field.
function TargetFields({
    target,
    onTargetChange,
    loading,
    ownTargets,
    teamTargets,
    name,
    onNameChange,
}: {
    target: string;
    onTargetChange: (target: string) => void;
    loading: boolean;
    ownTargets: readonly CalendarOption[];
    teamTargets: readonly CalendarOption[];
    // Only a new calendar has one.
    name: string | undefined;
    onNameChange: (name: string) => void;
}) {
    const submitted = useFormSubmitted();
    const noTarget = submitted && !target;
    const noName = submitted && name !== undefined && !name.trim();
    return (
        <>
            <Field>
                <FieldLabel htmlFor="import-calendar-target">Add to calendar</FieldLabel>
                <Select value={target} onValueChange={onTargetChange} disabled={loading}>
                    <SelectTrigger
                        id="import-calendar-target"
                        className="w-full"
                        aria-invalid={noTarget || undefined}
                        aria-describedby={noTarget ? 'import-calendar-target-error' : undefined}
                    >
                        <SelectValue placeholder={loading ? 'Loading calendars…' : 'Select calendar'} />
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
                {noTarget && <FieldError id="import-calendar-target-error">Pick a calendar</FieldError>}
            </Field>

            {name !== undefined && (
                <Field>
                    <FieldLabel htmlFor="import-calendar-name">Calendar name</FieldLabel>
                    <Input
                        id="import-calendar-name"
                        value={name}
                        onChange={(e) => onNameChange(e.target.value)}
                        aria-invalid={noName || undefined}
                        aria-describedby={noName ? 'import-calendar-name-error' : undefined}
                    />
                    {noName && <FieldError id="import-calendar-name-error">Add a name</FieldError>}
                </Field>
            )}
        </>
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
