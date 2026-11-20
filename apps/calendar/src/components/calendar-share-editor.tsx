// The Sharing part of Edit calendar: add a person by email, set each one's access or remove them, and the footer's
// Share with team. Each change only edits the dialog's list of shares, which Save sends with the name and color.

import { useAuth } from '@workspace/lib/auth';
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

// The words for each access level, in the editor's menu and wherever a share is named, such as a shared calendar's
// settings.
export const CALENDAR_PERMISSION_LABELS: Record<CalendarShare['permission'], string> = {
    write: 'Can edit',
    read: 'Can view',
    'free-busy': 'Free/Busy',
};

type CalendarShareEditorProps = {
    shares: CalendarShare[] | null;
    onChange: (shares: CalendarShare[] | null) => void;
};

export function CalendarShareEditor({ shares, onChange }: CalendarShareEditorProps) {
    const currentShares = shares ?? [];
    const { user } = useAuth();

    const excludeEmails = currentShares.map((s) => s.targetId);
    if (user?.email) excludeEmails.push(user.email);

    const contactInput = useContactInput(({ email }) => {
        if (!currentShares.some((s) => s.targetId.toLowerCase() === email.toLowerCase())) {
            onChange([...currentShares, { targetId: email, permission: 'read' }]);
        }
        return true;
    });

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
                value={contactInput.value}
                onChange={contactInput.handleChange}
                onSubmit={contactInput.submit}
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

// The footer's Share with team: a menu of the user's teams, each added as a viewer. It shows only for someone in a team.
export function ShareWithTeamButton({ shares, onChange }: CalendarShareEditorProps) {
    const { data: myTeams } = useMyTeams();
    if (!myTeams || myTeams.length === 0) return null;
    const currentShares = shares ?? [];

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2">
                    <Users className="h-4 w-4" />
                    Share with team
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
                        <Users className="h-4 w-4" />
                        {team.name}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
