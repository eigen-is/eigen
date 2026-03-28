import {usePeopleTeams} from '@workspace/lib/people';
import {usePublicConfig} from '@workspace/lib/public';
import {teamOwnerId} from '@workspace/lib/types';
import type {CalendarShare} from '@workspace/lib/types/calendar';
import {validateEmailAddress} from '@workspace/lib/validation';
import {Button} from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {ContactAutosuggest} from '@workspace/ui/components/layout/contacts/contact-autosuggest';
import {UserItem} from '@workspace/ui/components/layout/user-item';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Separator} from '@workspace/ui/components/separator';
import {Plus, Users} from 'lucide-react';
import {useCallback, useRef, useState} from 'react';

type CalendarShareEditorProps = {
    shares: CalendarShare[] | null;
    onChange: (shares: CalendarShare[] | null) => void;
};

export function CalendarShareEditor({shares, onChange}: CalendarShareEditorProps) {
    const [newContactInput, setNewContactInput] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const currentShares = shares || [];

    const {data: config} = usePublicConfig();
    const {data: teams} = usePeopleTeams(config?.orgId);

    const addShare = useCallback(
        (targetId: string, permission: CalendarShare['permission'] = 'read') => {
            if (currentShares.some((s) => s.targetId.toLowerCase() === targetId.toLowerCase())) return;
            onChange([...currentShares, {targetId, permission}]);
        },
        [currentShares, onChange],
    );

    const processContactInput = useCallback(
        (value: string) => {
            const emailMatch = value.match(/<(.+)>/);
            let email: string;

            if (emailMatch) {
                email = emailMatch[1];
            } else {
                const isEmail = validateEmailAddress(value);
                if (isEmail) {
                    email = value.trim().toLowerCase();
                } else {
                    return false;
                }
            }

            addShare(email.toLowerCase());
            return true;
        },
        [addShare],
    );

    const handleContactSelected = useCallback(
        (value: string) => {
            if (value.includes('<') && value.includes('>')) {
                const added = processContactInput(value);
                if (added) setNewContactInput('');
                else setNewContactInput(value);
            } else {
                setNewContactInput(value);
            }
        },
        [processContactInput],
    );

    const handleAddContactClick = useCallback(() => {
        if (!newContactInput) return;
        const added = processContactInput(newContactInput);
        if (added) setNewContactInput('');
    }, [newContactInput, processContactInput]);

    const handlePermissionChange = useCallback(
        (targetId: string, permission: string) => {
            if (permission === 'remove') {
                onChange(currentShares.filter((s) => s.targetId !== targetId));
            } else {
                onChange(
                    currentShares.map((s) =>
                        s.targetId === targetId ? {...s, permission: permission as CalendarShare['permission']} : s,
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

            <div className="flex">
                <div className="flex-1 relative">
                    <ContactAutosuggest
                        id="share-contact"
                        value={newContactInput}
                        onChange={handleContactSelected}
                        onlyEigenIsMails={false}
                        placeholder="Enter email addresses"
                        inputRef={inputRef}
                        onSubmit={handleAddContactClick}
                    />
                </div>
                <Button
                    size="icon"
                    variant="outline"
                    className="ml-2"
                    onClick={handleAddContactClick}
                    disabled={!newContactInput}
                >
                    <Plus className="h-4 w-4"/>
                </Button>
            </div>

            {currentShares.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">People with access</h4>
                    {currentShares.map((share) => (
                        <div key={share.targetId} className="flex items-center justify-between">
                            <UserItem email={share.targetId}/>
                            <Select
                                defaultValue={share.permission}
                                onValueChange={(value) => handlePermissionChange(share.targetId, value)}
                            >
                                <SelectTrigger className="h-7 w-32">
                                    <SelectValue/>
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

            {teams && teams.length > 0 && (
                <>
                    <Separator/>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="gap-2">
                                <Users className="h-4 w-4"/>
                                Share with team
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {teams.map((team) => (
                                <DropdownMenuItem
                                    key={team.id}
                                    onClick={() => handleAddTeam(team.id)}
                                    disabled={currentShares.some((s) => s.targetId === teamOwnerId(team.id))}
                                >
                                    <Users className="h-4 w-4 mr-2"/>
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
