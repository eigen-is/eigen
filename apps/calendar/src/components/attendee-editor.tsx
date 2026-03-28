import type { Attendee } from '@workspace/lib/types/calendar';
import { validateEmailAddress } from '@workspace/lib/validation';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { ContactAutosuggest } from '@workspace/ui/components/layout/contacts/contact-autosuggest';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { Check, CircleDashed, HelpCircle, Plus, X as XIcon } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

type AttendeeEditorProps = {
    attendees: Attendee[];
    onChange: (attendees: Attendee[]) => void;
    currentUserEmail?: string;
};

const statusIcon: Record<Attendee['status'], typeof Check> = {
    accepted: Check,
    declined: XIcon,
    tentative: HelpCircle,
    pending: CircleDashed,
};

const statusLabel: Record<Attendee['status'], string> = {
    accepted: 'Accepted',
    declined: 'Declined',
    tentative: 'Maybe',
    pending: 'Pending',
};

export function AttendeeEditor({ attendees, onChange, currentUserEmail }: AttendeeEditorProps) {
    const [input, setInput] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const addAttendee = useCallback(
        (email: string, name?: string) => {
            const normalized = email.toLowerCase();
            if (attendees.some((a) => a.email.toLowerCase() === normalized)) return;
            if (currentUserEmail && normalized === currentUserEmail.toLowerCase()) return;
            onChange([...attendees, { email: normalized, name, status: 'pending', role: 'required' }]);
        },
        [attendees, onChange, currentUserEmail],
    );

    const processInput = useCallback(
        (value: string) => {
            const emailMatch = value.match(/<(.+)>/);
            if (emailMatch) {
                const nameMatch = value.match(/^(.+?)\s*</);
                addAttendee(emailMatch[1], nameMatch?.[1]);
                return true;
            }
            if (validateEmailAddress(value.trim())) {
                addAttendee(value.trim());
                return true;
            }
            return false;
        },
        [addAttendee],
    );

    const handleContactSelected = useCallback(
        (value: string) => {
            if (value.includes('<') && value.includes('>')) {
                if (processInput(value)) setInput('');
                else setInput(value);
            } else {
                setInput(value);
            }
        },
        [processInput],
    );

    const handleAddClick = useCallback(() => {
        if (processInput(input)) setInput('');
    }, [input, processInput]);

    const removeAttendee = useCallback(
        (email: string) => {
            onChange(attendees.filter((a) => a.email !== email));
        },
        [attendees, onChange],
    );

    return (
        <div className="space-y-2">
            <div className="flex gap-2">
                <div className="flex-1 relative">
                    <ContactAutosuggest
                        id="attendee-input"
                        value={input}
                        onChange={handleContactSelected}
                        onlyEigenIsMails={false}
                        placeholder="Add guests"
                        inputRef={inputRef}
                        onSubmit={handleAddClick}
                    />
                </div>
                <Button size="icon" variant="outline" onClick={handleAddClick} disabled={!input}>
                    <Plus className="h-4 w-4" />
                </Button>
            </div>

            {attendees.length > 0 && (
                <div className="space-y-1">
                    {attendees.map((attendee) => {
                        const StatusIcon = statusIcon[attendee.status];
                        return (
                            <div key={attendee.email} className="flex items-center justify-between group">
                                <UserItem email={attendee.email} name={attendee.name} />
                                <div className="flex items-center gap-1">
                                    <Badge variant="outline" className="text-xs gap-1">
                                        <StatusIcon className="h-3 w-3" />
                                        {statusLabel[attendee.status]}
                                    </Badge>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                                        onClick={() => removeAttendee(attendee.email)}
                                    >
                                        <XIcon className="h-3 w-3" />
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

type AttendeeListProps = {
    attendees: Attendee[];
    organizer?: { userId?: string; email: string; name?: string };
};

export function AttendeeList({ attendees, organizer }: AttendeeListProps) {
    return (
        <div className="space-y-1">
            {organizer && (
                <div className="flex items-center justify-between">
                    <UserItem email={organizer.email} name={organizer.name} />
                    <Badge variant="outline" className="text-xs">
                        Organizer
                    </Badge>
                </div>
            )}
            {attendees.map((attendee) => {
                const StatusIcon = statusIcon[attendee.status];
                return (
                    <div key={attendee.email} className="flex items-center justify-between">
                        <UserItem email={attendee.email} name={attendee.name} />
                        <Badge variant="outline" className="text-xs gap-1">
                            <StatusIcon className="h-3 w-3" />
                            {statusLabel[attendee.status]}
                        </Badge>
                    </div>
                );
            })}
        </div>
    );
}
