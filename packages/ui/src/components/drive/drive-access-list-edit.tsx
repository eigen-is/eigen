import { getDriveShareUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { type DirectAccessItem, useDriveAccess, useIsEffectiveOwner } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { DriveACL, DriveACLDelta, DrivePath, DriveVisibility } from '@workspace/lib/types/drive';
import { AvatarIcon } from '@workspace/ui/components/avatar';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { DialogFooter } from '@workspace/ui/components/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { cn } from '@workspace/ui/lib/utils';
import { ClipboardCopy, Link, Lock, Mail, Unlock, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ContactAddRow } from '../contacts/contact-add-row';
import { useContactInput } from '../contacts/use-contact-input';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { UserItem } from '../user/user-item';

export type DriveAccessListEditProps = {
    path: DrivePath;
    onSave: (delta: DriveACLDelta, visibility: DriveVisibility, sharingRestricted?: boolean) => void;
    onCancel?: () => void;
    onEmailClick?: () => void;
    className?: string;
    prefillEmail?: string;
};

export function DriveAccessListEdit({
    path,
    onSave,
    onCancel,
    onEmailClick,
    className,
    prefillEmail,
}: DriveAccessListEditProps) {
    const [pendingChanges, setPendingChanges] = useState(false);
    const [directListOverride, setDirectListOverride] = useState<DirectAccessItem[] | undefined>();

    const { baseDirectList, directList, inheritedList } = useDriveAccess(path, directListOverride);

    const [visibility, setVisibility] = useState<DriveVisibility>(path.visibility ?? 'private');
    const [sharingRestricted, setSharingRestricted] = useState(path.sharingRestricted ?? false);

    const { data: myTeams } = useMyTeams();

    const isEffectiveOwner = useIsEffectiveOwner(path.ownerId);
    const { user } = useAuth();

    const excludeEmails = useMemo(() => {
        const emails = [...directList, ...inheritedList].map((item) => item.id);
        if (user?.email) emails.push(user.email);
        return emails;
    }, [directList, inheritedList, user?.email]);

    useEffect(() => {
        setDirectListOverride(undefined);
        setVisibility(path.visibility ?? 'private');
        setSharingRestricted(path.sharingRestricted ?? false);
    }, [path]);

    // Rejecting a duplicate returns false so the raw text stays in the field for the user to edit.
    const contactInput = useContactInput((contact) => {
        if (directList.some((item: DirectAccessItem) => item.id.toLowerCase() === contact.email)) return false;
        setDirectListOverride((prevList) => [
            ...(prevList || baseDirectList),
            { id: contact.email, read: true, write: true, owner: false },
        ]);
        setPendingChanges(true);
        return true;
    });

    useEffect(() => {
        if (prefillEmail) {
            contactInput.setValue(prefillEmail);
        }
    }, [prefillEmail, contactInput.setValue]);

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
                            return { ...item, read: false, write: false };
                        } else if (permission === 'editor') {
                            return { ...item, read: true, write: true };
                        } else if (permission === 'viewer') {
                            return { ...item, read: true, write: false };
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
        // Send only what changed — the server merges onto the current ACL, so a stale
        // dialog can't revert entries another sharer added while it was open.
        const base = new Map(baseDirectList.filter((item) => !item.owner).map((item) => [item.id.toLowerCase(), item]));
        const add: DriveACL[] = [];
        const remove: string[] = [];

        for (const item of directList) {
            if (item.owner) continue;
            const prev = base.get(item.id.toLowerCase());
            if (item.read || item.write) {
                if (!prev || prev.read !== item.read || prev.write !== item.write) {
                    add.push({ id: item.id, read: item.read, write: item.write });
                }
            } else if (prev) {
                // Marked "remove" in the UI (read and write both cleared)
                remove.push(item.id);
            }
        }

        onSave({ add, remove }, visibility, isEffectiveOwner ? sharingRestricted : undefined);
    }, [baseDirectList, directList, visibility, sharingRestricted, isEffectiveOwner, onSave]);

    return (
        <div className={cn('flex flex-col min-h-0', className)}>
            <div className="shrink-0">
                <ContactAddRow
                    id="new-contact"
                    value={contactInput.value}
                    onChange={contactInput.handleChange}
                    onSubmit={contactInput.submit}
                    excludeEmails={excludeEmails}
                    className="mt-2"
                />
            </div>

            <Separator className="my-4 shrink-0" />

            <div className="space-y-2 overflow-y-auto min-h-0">
                <div className="flex items-center justify-between rounded-md bg-muted/50 px-2 py-1.5">
                    <h4 className="text-base font-medium">People with access</h4>
                    <div className="flex items-center gap-0.5">
                        <TooltipButton
                            icon={ClipboardCopy}
                            tooltipText="Copy emails"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => {
                                const emails = [...directList, ...inheritedList].map((e) => e.id).join(', ');
                                copyToClipboard(emails, 'Emails copied to clipboard');
                            }}
                        />
                        <TooltipButton
                            icon={Link}
                            tooltipText="Copy link"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => copyToClipboard(getDriveShareUrl(path), 'Link copied to clipboard')}
                        />
                        {onEmailClick && (
                            <TooltipButton
                                icon={Mail}
                                tooltipText={pendingChanges ? 'Save changes first' : 'Email collaborators'}
                                variant="ghost"
                                className="h-7 w-7"
                                disabled={pendingChanges}
                                onClick={onEmailClick}
                            />
                        )}
                    </div>
                </div>

                {directList.map((access: DirectAccessItem) => {
                    return (
                        <div key={access.id} className="flex items-center justify-between">
                            <UserItem email={access.id} popover={parseOwnerId(access.id).type === 'team'} />
                            {access.owner ? (
                                <span className="text-xs text-muted-foreground w-28 text-right">Owner</span>
                            ) : (
                                <Select
                                    defaultValue={access.write ? 'editor' : 'viewer'}
                                    onValueChange={(value) => handlePermissionChange(access.id, value)}
                                >
                                    <SelectTrigger className="h-7 w-28">
                                        <SelectValue />
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
                            <UserItem
                                email={access.id}
                                label={<>(inherited from /{access.sourceFolderName})</>}
                                popover={parseOwnerId(access.id).type === 'team'}
                            />
                            <span className="text-xs text-muted-foreground w-28 text-right">
                                {access.write ? 'Editor' : 'Viewer'}
                            </span>
                        </div>
                    );
                })}
            </div>

            <Separator className="my-4 shrink-0" />

            <div className="shrink-0">
                <h4 className="text-sm font-medium mb-2">General access</h4>
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center">
                        <AvatarIcon
                            className="w-8 h-8 cursor-pointer"
                            onClick={() => handleVisibilityChange(visibility === 'private' ? 'public-read' : 'private')}
                        >
                            {visibility !== 'private' ? <Unlock /> : <Lock />}
                        </AvatarIcon>
                        <div className="ml-3">
                            <p className="text-sm font-medium">
                                {visibility !== 'private' ? 'Unrestricted' : 'Restricted'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {visibility !== 'private'
                                    ? 'Any authenticated user with the link'
                                    : 'Only people with access'}
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
                                <SelectValue />
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
                            <Checkbox checked={!sharingRestricted} onCheckedChange={handleSharingRestrictedChange} />
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

            <Separator className="my-4 shrink-0" />

            <DialogFooter className="shrink-0">
                {myTeams && myTeams.length > 0 && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="mr-auto gap-2">
                                <Users className="h-4 w-4" />
                                Share with team
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {myTeams.map((team) => (
                                <DropdownMenuItem
                                    key={team.id}
                                    onClick={() => handleAddTeam(team.id)}
                                    disabled={directList.some((i: DirectAccessItem) => i.id === teamOwnerId(team.id))}
                                >
                                    <Users className="h-4 w-4 mr-2" />
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
