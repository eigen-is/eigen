import { useAuth } from '@workspace/lib/auth';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { CalendarShare } from '@workspace/lib/types/calendar';
import { Button } from '@workspace/ui/components/button';
import { ContactAddRow, useContactInput } from '@workspace/ui/components/contacts';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { UserItem } from '@workspace/ui/components/user';
import { Users } from 'lucide-react';
import { useCallback, useMemo } from 'react';

type CalendarShareEditorProps = {
    shares: CalendarShare[] | null;
    onChange: (shares: CalendarShare[] | null) => void;
};

export function CalendarShareEditor({ shares, onChange }: CalendarShareEditorProps) {
    const currentShares = shares || [];

    const { data: myTeams } = useMyTeams();
    const { user } = useAuth();

    const excludeEmails = useMemo(() => {
        const emails = currentShares.map((s) => s.targetId);
        if (user?.email) emails.push(user.email);
        return emails;
    }, [currentShares, user?.email]);

    const addShare = useCallback(
        (targetId: string, permission: CalendarShare['permission'] = 'read') => {
            if (currentShares.some((s) => s.targetId.toLowerCase() === targetId.toLowerCase())) return;
            onChange([...currentShares, { targetId, permission }]);
        },
        [currentShares, onChange],
    );

    const contactInput = useContactInput((contact) => {
        addShare(contact.email);
        return true;
    });

    const handlePermissionChange = useCallback(
        (targetId: string, permission: string) => {
            if (permission === 'remove') {
                onChange(currentShares.filter((s) => s.targetId !== targetId));
            } else {
                onChange(
                    currentShares.map((s) =>
                        s.targetId === targetId ? { ...s, permission: permission as CalendarShare['permission'] } : s,
                    ),
                );
            }
        },
        [currentShares, onChange],
    );

    const handleAddTeam = useCallback(
        (teamId: string) => {
            addShare(teamOwnerId(teamId));
        },
        [addShare],
    );

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
                                    <SelectItem value="write">Can edit</SelectItem>
                                    <SelectItem value="read">Can view</SelectItem>
                                    <SelectItem value="free-busy">Free/Busy</SelectItem>
                                    <SelectItem value="remove">Remove</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    ))}
                </div>
            )}

            {myTeams && myTeams.length > 0 && (
                <>
                    <Separator />
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
                                    onClick={() => handleAddTeam(team.id)}
                                    disabled={currentShares.some((s) => s.targetId === teamOwnerId(team.id))}
                                >
                                    <Users className="h-4 w-4 mr-2" />
                                    {team.name}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )}
        </div>
    );
}
