import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { type ReactNode, useState } from 'react';
import { MemberCommandList, PinnedAssigneeRows } from './member-command-list';

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
        // modal: inside the card dialog, the Dialog's scroll lock would otherwise swallow
        // wheel events over the portalled member list.
        <Popover open={open} onOpenChange={setOpen} modal>
            <PopoverTrigger asChild disabled={disabled}>
                {children}
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start">
                <MemberCommandList
                    members={members}
                    selectedEmail={value}
                    onSelect={select}
                    currentUserEmail={currentUserEmail}
                    header={
                        <PinnedAssigneeRows
                            currentUserEmail={currentUserEmail}
                            selected={value}
                            onSelect={select}
                            meLabel="Assign to me"
                        />
                    }
                />
            </PopoverContent>
        </Popover>
    );
}
