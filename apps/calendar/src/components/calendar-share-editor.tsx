// The Sharing part of Edit calendar: add a person by email, set each one's access or remove them, and the footer's
// Share with team. Each change only edits the dialog's list of shares, which Save sends with the name and color. The
// dialog owns the field's text through useShareInput, so its Save counts typed text as a change and adds it first.

import { useAuth } from '@workspace/lib/auth';
import { CALENDAR_PERMISSION_LABELS } from '@workspace/lib/constants/calendar';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { CalendarShare } from '@workspace/lib/types/calendar';
import { CALENDAR_SHARE_PERMISSIONS } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { ContactAddRow, useContactInput } from '@workspace/ui/components/contacts';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@workspace/ui/components/select';
import { UserItem } from '@workspace/ui/components/user';
import { Users } from 'lucide-react';

type CalendarShareEditorProps = {
    shares: CalendarShare[] | null;
    onChange: (shares: CalendarShare[] | null) => void;
};

type ShareInput = ReturnType<typeof useContactInput> & {
    // The shares with the typed person added, nothing when nothing was typed, or false when the field refuses it and
    // says why.
    commitShares: () => CalendarShare[] | undefined | false;
};

export function useShareInput({ shares, onChange }: CalendarShareEditorProps): ShareInput {
    const { user } = useAuth();
    const currentShares = shares ?? [];
    const withShare = (email: string): CalendarShare[] => [...currentShares, { targetId: email, permission: 'read' }];
    const input = useContactInput({
        listed: currentShares.map((s) => s.targetId),
        onAdd: ({ email }) => {
            if (email === user?.email?.toLowerCase()) return 'You cannot share a calendar with yourself';
            onChange(withShare(email));
        },
    });
    return {
        ...input,
        commitShares: () => {
            const typed = input.commitTyped();
            if ('refused' in typed) return false;
            return typed.added && withShare(typed.added.email);
        },
    };
}

export function CalendarShareEditor({ shares, onChange, input }: CalendarShareEditorProps & { input: ShareInput }) {
    const currentShares = shares ?? [];
    const { user } = useAuth();

    const excludeEmails = currentShares.map((s) => s.targetId);
    if (user?.email) excludeEmails.push(user.email);

    const handlePermissionChange = (targetId: string, permission: string) => {
        const next = CALENDAR_SHARE_PERMISSIONS.find((p) => p === permission);
        if (permission === 'remove') {
            onChange(currentShares.filter((s) => s.targetId !== targetId));
        } else if (next) {
            onChange(currentShares.map((s) => (s.targetId === targetId ? { ...s, permission: next } : s)));
        }
    };

    return (
        <div className="space-y-3">
            <h4 className="text-sm font-medium">Sharing</h4>

            <ContactAddRow
                id="share-contact"
                value={input.value}
                onChange={input.handleChange}
                onSubmit={input.submit}
                error={input.error}
                excludeEmails={excludeEmails}
            />

            {currentShares.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">People with access</h4>
                    {currentShares.map((share) => (
                        <div key={share.targetId} className="flex items-center justify-between">
                            <UserItem email={share.targetId} />
                            <Select
                                defaultValue={share.permission}
                                onValueChange={(value) => handlePermissionChange(share.targetId, value)}
                            >
                                <SelectTrigger className="h-7 w-32">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {Object.entries(CALENDAR_PERMISSION_LABELS).map(([permission, label]) => (
                                        <SelectItem key={permission} value={permission}>
                                            {label}
                                        </SelectItem>
                                    ))}
                                    <SelectSeparator />
                                    <SelectItem value="remove" variant="destructive">
                                        Remove
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// The footer's Share with team: a menu of the user's teams, each added as a viewer.
export function ShareWithTeamButton({ shares, onChange }: CalendarShareEditorProps) {
    const { data: myTeams } = useMyTeams();
    if (!myTeams || myTeams.length === 0) return null;
    const currentShares = shares ?? [];

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline">
                    <Users />
                    {/* A phone's footer keeps one row, so only the icon shows there. */}
                    <span className="max-sm:sr-only">Share with team</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                {myTeams.map((team) => (
                    <DropdownMenuItem
                        key={team.id}
                        onClick={() =>
                            onChange([...currentShares, { targetId: teamOwnerId(team.id), permission: 'read' }])
                        }
                        disabled={currentShares.some((s) => s.targetId === teamOwnerId(team.id))}
                    >
                        <Users />
                        {team.name}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
