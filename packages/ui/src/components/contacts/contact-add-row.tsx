import { cn } from '@workspace/ui/lib/utils';
import { Plus } from 'lucide-react';
import { Button } from '../button';
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
        <div className={cn('flex', className)}>
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
            <Button size="icon" variant="outline" className="ml-2" onClick={onSubmit} disabled={!value}>
                <Plus className="h-4 w-4" />
            </Button>
        </div>
    );
}
