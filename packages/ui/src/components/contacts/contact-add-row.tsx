// A field that suggests contacts as you type, with a + button beside it, for adding people one at a time, such as a
// share list or an event's guests. Enter in the field and the + both hand the typed person to the caller. Neither
// submits a form the row sits in.

import { cn } from '@workspace/ui/lib/utils';
import { Plus } from 'lucide-react';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { ContactAutosuggest } from './contact-autosuggest';

type ContactAddRowProps = {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    excludeEmails?: string[];
    placeholder?: string;
    onlyInternalMails?: boolean;
    onEmptyEnter?: () => void;
    id?: string;
    className?: string;
};

export function ContactAddRow({
    value,
    onChange,
    onSubmit,
    excludeEmails,
    placeholder = 'Enter email addresses',
    onlyInternalMails = false,
    onEmptyEnter,
    id,
    className,
}: ContactAddRowProps) {
    return (
        <div className={cn('flex items-center', className)}>
            <div className="flex-1 relative">
                <ContactAutosuggest
                    id={id}
                    value={value}
                    onChange={onChange}
                    onlyInternalMails={onlyInternalMails}
                    excludeEmails={excludeEmails}
                    placeholder={placeholder}
                    onSubmit={onSubmit}
                    onEmptyEnter={onEmptyEnter}
                />
            </div>
            <TooltipButton
                icon={Plus}
                tooltipText="Add"
                type="button"
                className="ml-2 shrink-0"
                onClick={onSubmit}
                disabled={!value}
            />
        </div>
    );
}
