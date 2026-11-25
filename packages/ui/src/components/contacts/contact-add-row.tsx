// A field that suggests contacts as you type, with a + button beside it, for adding people one at a time, such as a
// share list or an event's guests. Enter in the field and the + both hand the typed person to the caller. Neither
// submits a form the row sits in. A person the caller couldn't take shows the reason under the field, as every
// form's field error does.

import { Plus } from 'lucide-react';
import { useId } from 'react';
import { FieldError } from '../field';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { ContactAutosuggest } from './contact-autosuggest';

type ContactAddRowProps = {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    error: string | undefined;
    excludeEmails?: string[];
    placeholder?: string;
    onEmptyEnter?: () => void;
    id?: string;
    className?: string;
};

export function ContactAddRow({
    value,
    onChange,
    onSubmit,
    error,
    excludeEmails,
    placeholder = 'Enter email addresses',
    onEmptyEnter,
    id,
    className,
}: ContactAddRowProps) {
    const errorId = useId();
    return (
        <div className={className}>
            <div className="flex items-center">
                <div className="flex-1 relative">
                    <ContactAutosuggest
                        id={id}
                        value={value}
                        onChange={onChange}
                        excludeEmails={excludeEmails}
                        placeholder={placeholder}
                        onSubmit={onSubmit}
                        onEmptyEnter={onEmptyEnter}
                        aria-invalid={!!error}
                        aria-describedby={error ? errorId : undefined}
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
            {error && (
                <FieldError id={errorId} className="mt-1.5">
                    {error}
                </FieldError>
            )}
        </div>
    );
}
