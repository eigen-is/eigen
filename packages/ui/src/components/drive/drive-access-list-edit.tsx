// The editable half of the Share dialog: add people or a team, change or remove each one's access, set the link's
// general access and, for the owner, whether editors may share. It is the dialog's form, and mounts with it, so each
// opening starts from the item as it is. Save sends only what changed, so a dialog opened a while ago can't undo what
// another sharer added since.

import { getDriveShareUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { useDriveAccess, useIsEffectiveOwner, useUpdateACL } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DirectAccessItem, DriveACL, DriveVisibility } from '@workspace/lib/types/drive-access';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { FormDialogForm } from '@workspace/ui/components/form-dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { ClipboardCopy, Link, Lock, Mail, Unlock, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ContactAddRow } from '../contacts/contact-add-row';
import { useContactInput } from '../contacts/use-contact-input';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { UserItem } from '../user/user-item';
import { GeneralAccess } from './drive-access-list';

export type DriveAccessListEditProps = {
    path: DrivePath;
    onEmailClick?: () => void;
    prefillEmail?: string;
};

export function DriveAccessListEdit({ path, onEmailClick, prefillEmail }: DriveAccessListEditProps) {
    const [hasChanges, setHasChanges] = useState(false);
    const [directListOverride, setDirectListOverride] = useState<DirectAccessItem[] | undefined>();

    const { baseDirectList, directList, inheritedList } = useDriveAccess(path, directListOverride);

    const [visibility, setVisibility] = useState<DriveVisibility>(path.visibility);
    const [sharingRestricted, setSharingRestricted] = useState(path.sharingRestricted);

    const { data: myTeams } = useMyTeams();

    const isEffectiveOwner = useIsEffectiveOwner(path.ownerId);
    const { user } = useAuth();
    const updateACL = useUpdateACL(path.ownerId, path.mountId, user?.id);

    const excludeEmails = useMemo(() => {
        const emails = [...directList, ...inheritedList].map((item) => item.id);
        if (user?.email) emails.push(user.email);
        return emails;
    }, [directList, inheritedList, user?.email]);

    // Rejecting a duplicate returns false so the raw text stays in the field for the user to edit.
    const contactInput = useContactInput((contact) => {
        if (directList.some((item) => item.id.toLowerCase() === contact.email)) return false;
        setDirectListOverride((prevList) => [
            ...(prevList || baseDirectList),
            { id: contact.email, read: true, write: true, owner: false },
        ]);
        setHasChanges(true);
        return true;
    });

    useEffect(() => {
        if (prefillEmail) {
            contactInput.setValue(prefillEmail);
        }
    }, [prefillEmail, contactInput.setValue]);

    const handleAddTeam = (teamId: string) => {
        const id = teamOwnerId(teamId);
        if (directList.some((item) => item.id === id)) return;
        setDirectListOverride((prev) => [...(prev || baseDirectList), { id, read: true, write: true, owner: false }]);
        setHasChanges(true);
    };

    const handlePermissionChange = (id: string, permission: string) => {
        setDirectListOverride((prev) =>
            (prev || baseDirectList).map((item) => {
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
        setHasChanges(true);
    };

    const handleVisibilityChange = (newVisibility: DriveVisibility) => {
        setVisibility(newVisibility);
        setHasChanges(true);
    };

    const handleSharingRestrictedChange = (checked: boolean | 'indeterminate') => {
        setSharingRestricted(!checked);
        setHasChanges(true);
    };

    // The server merges what it gets onto the current ACL, so a dialog opened a while ago can't revert an entry
    // another sharer added since.
    const handleSave = async () => {
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
                // Remove in the picker clears both read and write.
                remove.push(item.id);
            }
        }

        await updateACL.mutateAsync({
            path,
            add,
            remove,
            visibility,
            sharingRestricted: isEffectiveOwner ? sharingRestricted : undefined,
        });
    };

    // The lock's name says what a click does, since Restricted or Unrestricted beside it already says the state.
    const lockLabel =
        visibility === 'private' ? 'Let anyone signed in with the link view it' : 'Restrict to people with access';
    const LockIcon = visibility === 'private' ? Lock : Unlock;

    return (
        <FormDialogForm
            submitLabel="Save"
            canSubmit={hasChanges}
            onSubmit={handleSave}
            footerStart={
                myTeams &&
                myTeams.length > 0 && (
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
                                    disabled={directList.some((i) => i.id === teamOwnerId(team.id))}
                                >
                                    <Users className="h-4 w-4" />
                                    {team.name}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )
            }
        >
            {/* Enter here adds the person typed, and never submits. */}
            <ContactAddRow
                id="new-contact"
                value={contactInput.value}
                onChange={contactInput.handleChange}
                onSubmit={contactInput.submit}
                excludeEmails={excludeEmails}
                className="mt-2"
            />

            <Separator />

            {/* A long list scrolls on its own, so General access and the footer stay in view. */}
            <div className="app-gutter-bleed space-y-2 overflow-y-auto max-h-[40vh]">
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
                                tooltipText={hasChanges ? 'Save changes first' : 'Email collaborators'}
                                variant="ghost"
                                className="h-7 w-7"
                                disabled={hasChanges}
                                onClick={onEmailClick}
                            />
                        )}
                    </div>
                </div>

                {directList.map((access) => (
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
                                    <SelectSeparator />
                                    <SelectItem value="remove" variant="destructive">
                                        Remove
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        )}
                    </div>
                ))}

                {inheritedList.map((access) => (
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
                ))}
            </div>

            <Separator />

            <div>
                <h4 className="text-sm font-medium mb-2">General access</h4>
                <GeneralAccess
                    visibility={visibility}
                    icon={
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="rounded-full"
                                    aria-label={lockLabel}
                                    onClick={() =>
                                        handleVisibilityChange(visibility === 'private' ? 'public-read' : 'private')
                                    }
                                >
                                    <LockIcon className="size-6" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>{lockLabel}</TooltipContent>
                        </Tooltip>
                    }
                >
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
                </GeneralAccess>

                {isEffectiveOwner && (
                    <label className="mt-2 flex items-center cursor-pointer">
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

            <Separator />
        </FormDialogForm>
    );
}
