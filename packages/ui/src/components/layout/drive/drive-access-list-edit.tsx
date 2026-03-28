'use client';

import {type DirectAccessItem, useDriveAccess, useIsEffectiveOwner} from '@workspace/lib/drive';
import {usePeopleTeams} from '@workspace/lib/people';
import {usePublicConfig} from '@workspace/lib/public';
import {teamOwnerId} from '@workspace/lib/types';
import type {DriveACL, DrivePath, DriveVisibility} from '@workspace/lib/types/drive';
import {validateEmailAddress} from '@workspace/lib/validation';
import {AvatarIcon} from '@workspace/ui/components/avatar';
import {Button} from '@workspace/ui/components/button';
import {Checkbox} from '@workspace/ui/components/checkbox';
import {DialogFooter} from '@workspace/ui/components/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Separator} from '@workspace/ui/components/separator';
import {cn} from '@workspace/ui/lib/utils';
import {Lock, Plus, Unlock, Users} from 'lucide-react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {ContactAutosuggest} from '../contacts/contact-autosuggest';
import type {ContactSuggestion} from '../contacts/types';
import {UserItem} from '../user-item';

export type DriveAccessListEditProps = {
    path: DrivePath;
    onSave: (updatedAcl: DriveACL[], visibility: DriveVisibility, sharingRestricted?: boolean) => void;
    onCancel?: () => void;
    className?: string;
};

export function DriveAccessListEdit({path, onSave, onCancel, className}: DriveAccessListEditProps) {
    const [pendingChanges, setPendingChanges] = useState(false);
    const [newContactInput, setNewContactInput] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const [directListOverride, setDirectListOverride] = useState<DirectAccessItem[] | undefined>();

    const {baseDirectList, directList, inheritedList} = useDriveAccess(path, directListOverride);

    const [visibility, setVisibility] = useState<DriveVisibility>(path.visibility ?? 'private');
    const [sharingRestricted, setSharingRestricted] = useState(path.sharingRestricted ?? false);

    // Fetch org and teams for the team sharing picker
    const {data: config} = usePublicConfig();
    const {data: teams} = usePeopleTeams(config?.orgId);

    const isEffectiveOwner = useIsEffectiveOwner(path.ownerId);

    useEffect(() => {
        setDirectListOverride(undefined);
        setVisibility(path.visibility ?? 'private');
        setSharingRestricted(path.sharingRestricted ?? false);
    }, [path]);

    const handleAddUser = useCallback(
        (suggestion: ContactSuggestion) => {
            if (directList.some((item: DirectAccessItem) => item.id.toLowerCase() === suggestion.email.toLowerCase())) {
                return;
            }

            const newUser: DirectAccessItem = {
                id: suggestion.email.toLowerCase(),
                read: true,
                write: true,
                owner: false,
            };

            setDirectListOverride((prevList) => [...(prevList || baseDirectList), newUser]);
            setPendingChanges(true);
            setNewContactInput('');
        },
        [directList],
    );

    const processContactInput = useCallback(
        (value: string) => {
            const emailMatch = value.match(/<(.+)>/);
            let email: string;
            let displayName: string;

            if (emailMatch) {
                email = emailMatch[1];
                displayName = value.split('<')[0].trim();
            } else {
                const isEmail = validateEmailAddress(value);
                if (isEmail) {
                    email = value.trim().toLowerCase();
                    displayName = email.split('@')[0];
                } else {
                    return false;
                }
            }

            if (directList.some((item: DirectAccessItem) => item.id.toLowerCase() === email.toLowerCase())) {
                return false;
            }

            const suggestion: ContactSuggestion = {
                id: email.toLowerCase(),
                email: email.toLowerCase(),
                displayName: displayName,
                allEmails: [email.toLowerCase()],
            };

            handleAddUser(suggestion);
            return true;
        },
        [directList, handleAddUser],
    );

    const handleContactSelected = useCallback(
        (value: string) => {
            if (value.includes('<') && value.includes('>')) {
                const added = processContactInput(value);
                if (added) {
                    setNewContactInput('');
                } else {
                    setNewContactInput(value);
                }
            } else {
                setNewContactInput(value);
            }
        },
        [processContactInput],
    );

    const handleAddContactClick = useCallback(() => {
        if (!newContactInput) return;
        const added = processContactInput(newContactInput);
        if (added) {
            setNewContactInput('');
        }
    }, [newContactInput, processContactInput]);

    const handleAddTeam = useCallback(
        (teamId: string) => {
            const id = teamOwnerId(teamId);
            if (directList.some((item: DirectAccessItem) => item.id === id)) return;
            setDirectListOverride((prev) => [
                ...(prev || baseDirectList),
                {
                    id,
                    read: true,
                    write: true,
                    owner: false,
                },
            ]);
            setPendingChanges(true);
        },
        [directList],
    );

    const handlePermissionChange = useCallback(
        (id: string, permission: string) => {
            setDirectListOverride((prev) =>
                (prev || baseDirectList).map((item: DirectAccessItem) => {
                    if (item.id === id) {
                        if (permission === 'remove') {
                            return {...item, read: false, write: false};
                        } else if (permission === 'editor') {
                            return {...item, read: true, write: true};
                        } else if (permission === 'viewer') {
                            return {...item, read: true, write: false};
                        }
                    }
                    return item;
                }),
            );
            setPendingChanges(true);
        },
        [baseDirectList],
    );

    const handleVisibilityChange = useCallback((newVisibility: DriveVisibility) => {
        setVisibility(newVisibility);
        setPendingChanges(true);
    }, []);

    const handleSharingRestrictedChange = useCallback((checked: boolean | 'indeterminate') => {
        setSharingRestricted(!checked);
        setPendingChanges(true);
    }, []);

    const handleSave = useCallback(() => {
        const updatedAcl: DriveACL[] = [];

        for (const item of directList) {
            if (!item.owner && (item.read || item.write)) {
                updatedAcl.push({
                    id: item.id,
                    read: item.read,
                    write: item.write,
                });
            }
        }

        onSave(updatedAcl, visibility, isEffectiveOwner ? sharingRestricted : undefined);
    }, [directList, visibility, sharingRestricted, isEffectiveOwner, onSave]);

    return (
        <div className={cn('space-y-4', className)}>
            <div>
                <div className="flex mt-2">
                    <div className="flex-1 relative">
                        <ContactAutosuggest
                            id="new-contact"
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
            </div>

            <Separator/>

            <div className="space-y-2">
                <h4 className="text-base font-medium">People with access</h4>

                {directList.map((access: DirectAccessItem) => {
                    return (
                        <div key={access.id} className="flex items-center justify-between">
                            <UserItem email={access.id}/>
                            {access.owner ? (
                                <span className="text-xs text-muted-foreground w-28 text-right">Owner</span>
                            ) : (
                                <Select
                                    defaultValue={access.write ? 'editor' : 'viewer'}
                                    onValueChange={(value) => handlePermissionChange(access.id, value)}
                                >
                                    <SelectTrigger className="h-7 w-28">
                                        <SelectValue/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="editor">Editor</SelectItem>
                                        <SelectItem value="viewer">Viewer</SelectItem>
                                        <SelectItem value="remove">Remove</SelectItem>
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                    );
                })}

                {inheritedList.map((access) => {
                    return (
                        <div key={access.id} className="flex items-center justify-between">
                            <UserItem email={access.id} label={<>(inherited from /{access.sourceFolderName})</>}/>
                            <span className="text-xs text-muted-foreground w-28 text-right">
                                {access.write ? 'Editor' : 'Viewer'}
                            </span>
                        </div>
                    );
                })}
            </div>

            <Separator/>

            <div>
                <h4 className="text-sm font-medium mb-2">General access</h4>
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center">
                        <AvatarIcon
                            className="w-8 h-8 cursor-pointer"
                            onClick={() => handleVisibilityChange(visibility === 'private' ? 'public-read' : 'private')}
                        >
                            {visibility !== 'private' ? <Unlock/> : <Lock/>}
                        </AvatarIcon>
                        <div className="ml-3">
                            <p className="text-sm font-medium">
                                {visibility !== 'private' ? 'Unrestricted' : 'Restricted'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {visibility !== 'private'
                                    ? 'Anyone with the link can access'
                                    : 'Only people with access can open with the link'}
                            </p>
                        </div>
                    </div>

                    {visibility !== 'private' && (
                        <Select
                            value={visibility === 'public-write' ? 'editor' : 'viewer'}
                            onValueChange={(v) =>
                                handleVisibilityChange(v === 'editor' ? 'public-write' : 'public-read')
                            }
                        >
                            <SelectTrigger className="h-7 w-28">
                                <SelectValue/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="editor">Can edit</SelectItem>
                                <SelectItem value="viewer">Can view</SelectItem>
                            </SelectContent>
                        </Select>
                    )}
                </div>

                {isEffectiveOwner && (
                    <label className="flex items-center cursor-pointer">
                        <div className="w-8 h-8 flex items-center justify-center shrink-0">
                            <Checkbox checked={!sharingRestricted} onCheckedChange={handleSharingRestrictedChange}/>
                        </div>
                        <div className="ml-3">
                            <p className="text-sm">Editors can share</p>
                            <p className="text-xs text-muted-foreground">
                                When off, only the owner can add or remove people
                            </p>
                        </div>
                    </label>
                )}
            </div>

            <Separator/>

            <DialogFooter>
                {teams && teams.length > 0 && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="mr-auto gap-2">
                                <Users className="h-4 w-4"/>
                                Share with team
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {teams.map((team) => (
                                <DropdownMenuItem
                                    key={team.id}
                                    onClick={() => handleAddTeam(team.id)}
                                    disabled={directList.some((i: DirectAccessItem) => i.id === teamOwnerId(team.id))}
                                >
                                    <Users className="h-4 w-4 mr-2"/>
                                    {team.name}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
                {onCancel && (
                    <Button variant="outline" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                <Button onClick={handleSave} disabled={!pendingChanges}>
                    {pendingChanges ? 'Save' : 'Done'}
                </Button>
            </DialogFooter>
        </div>
    );
}
