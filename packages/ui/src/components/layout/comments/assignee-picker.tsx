import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Check, CircleSlash } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { MemberAvatar } from './member-avatar';
import { MemberCommandList, memberRowClassName } from './member-command-list';

type AssigneePickerProps = {
    value: string | null;
    onChange: (email: string | null) => void;
    members: EffectiveMember[];
    currentUserEmail: string;
    disabled?: boolean;
    children: ReactNode;
};

export function AssigneePicker({
    value,
    onChange,
    members,
    currentUserEmail,
    disabled,
    children,
}: AssigneePickerProps) {
    const [open, setOpen] = useState(false);
    const select = (email: string | null) => {
        onChange(email);
        setOpen(false);
    };
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild disabled={disabled}>
                {children}
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start">
                <MemberCommandList
                    members={members}
                    currentUserEmail={currentUserEmail}
                    selectedEmail={value}
                    onSelect={select}
                    header={
                        <div className="p-1">
                            <button
                                type="button"
                                className={memberRowClassName}
                                onClick={() => select(currentUserEmail)}
                            >
                                <MemberAvatar email={currentUserEmail} />
                                <span className="flex-1 truncate text-left">Assign to me</span>
                                {value === currentUserEmail && <Check className="h-4 w-4 shrink-0" />}
                            </button>
                            <button type="button" className={memberRowClassName} onClick={() => select(null)}>
                                <CircleSlash className="h-4 w-4 text-muted-foreground" />
                                <span className="flex-1 truncate text-left">Unassigned</span>
                                {value === null && <Check className="h-4 w-4 shrink-0" />}
                            </button>
                        </div>
                    }
                />
            </PopoverContent>
        </Popover>
    );
}
