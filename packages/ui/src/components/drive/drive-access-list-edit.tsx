// The editable half of the Share dialog: add people or a team, change or remove each one's access, set the link's
// general access and, for the owner, whether editors may share. It is the dialog's form, and mounts with it, so each
// opening starts from the item as it is. Save adds a person still typed in the field first, then sends only what
// changed, so a dialog opened a while ago can't undo what another sharer added since; with nothing changed it closes.
// Adding a person set to Remove, yourself included, takes the Remove back. Anyone with the link is offered where the
// server takes it, and always on an item that has it, so it can be closed.

import { getDriveShareUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { useDriveAccess, useIsEffectiveOwner, useUpdateACL } from '@workspace/lib/drive';
import { useMyTeams } from '@workspace/lib/home';
import { usePublicConfig } from '@workspace/lib/public';
import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_FILE, DRIVE_TYPE_FOLDER, isCollabType } from '@workspace/lib/types/drive';
import type { DirectAccessItem, DriveACL, DriveVisibility } from '@workspace/lib/types/drive-access';
import { Checkbox } from '@workspace/ui/components/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { FooterTool, FormDialogForm } from '@workspace/ui/components/form-dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { ClipboardCopy, Link, Mail, Users } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { ContactAddRow } from '../contacts/contact-add-row';
import { useContactInput } from '../contacts/use-contact-input';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { UserItem } from '../user/user-item';
import { GENERAL_ACCESS, GeneralAccess } from './drive-access-list';

const GENERAL_ACCESS_CHOICES: readonly DriveVisibility[] = ['private', 'public-read', 'link'];

const PUBLIC_LINK_NOTE =
    "Anyone who has this link can view this without signing in, and download files. The link is the item's address: whoever has seen it can open it for as long as this is on. Everything inside a public folder is public, private subfolders too. Visitors see comments and who wrote them, but not the replies, the history or who has access.";
const PUBLIC_LINKS_OFF_NOTE = 'Public links are turned off on this server, so this link opens nothing.';

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
    const updateACL = useUpdateACL(user?.id ?? '');

    const excludeEmails = useMemo(() => {
        const emails = [...directList, ...inheritedList].map((item) => item.id);
        if (user?.email) emails.push(user.email);
        return emails;
    }, [directList, inheritedList, user?.email]);

    const contactFieldId = useId();
    const generalAccessId = useId();

    const { data: publicConfig } = usePublicConfig();
    // The types the server lets have a link, which leaves out a chat.
    const linkable = path.type === DRIVE_TYPE_FOLDER || path.type === DRIVE_TYPE_FILE || isCollabType(path.type);
    const offersLink = path.visibility === 'link' || (publicConfig?.publicLinks === true && linkable);
    const choices = GENERAL_ACCESS_CHOICES.filter((choice) => choice !== 'link' || offersLink);
    const linkNote = publicConfig?.publicLinks === false ? PUBLIC_LINKS_OFF_NOTE : PUBLIC_LINK_NOTE;

    // A person set to Remove comes back with the access they had, your own entry included.
    const withPerson = (email: string): DirectAccessItem[] => {
        const removed = directList.find((item) => item.id.toLowerCase() === email);
        const restored = baseDirectList.find((item) => item.id === removed?.id && item.read);
        return removed
            ? directList.map((item) => (item === removed ? (restored ?? { ...item, read: true, write: true }) : item))
            : [...directList, { id: email, read: true, write: true, owner: false }];
    };

    const contactInput = useContactInput({
        // A person set to Remove may be added again.
        listed: directList.filter((item) => item.read).map((item) => item.id),
        onAdd: ({ email }) => {
            const listed = directList.some((item) => item.id.toLowerCase() === email);
            if (!listed && email === user?.email?.toLowerCase()) return 'You already have access';
            setDirectListOverride(withPerson(email));
            setHasChanges(true);
        },
    });

    useEffect(() => {
        if (prefillEmail) contactInput.setValue(prefillEmail);
    }, [prefillEmail, contactInput.setValue]);

    const handleAddTeam = (teamId: string) => {
        const id = teamOwnerId(teamId);
        if (directList.some((item) => item.id === id)) return;
        setDirectListOverride((prev) => [...(prev ?? baseDirectList), { id, read: true, write: true, owner: false }]);
        setHasChanges(true);
    };

    const handlePermissionChange = (id: string, permission: string) => {
        setDirectListOverride((prev) =>
            (prev ?? baseDirectList).map((item) =>
                item.id === id ? { ...item, read: permission !== 'remove', write: permission === 'editor' } : item,
            ),
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

    const handleSave = async () => {
        // A person still typed in the field is saved with the rest, built here since the state update hasn't rendered yet.
        const typed = contactInput.commitTyped();
        if ('refused' in typed) return false;
        if (!hasChanges && !typed.added) return;
        const list = typed.added ? withPerson(typed.added.email) : directList;
        const base = new Map(baseDirectList.filter((item) => !item.owner).map((item) => [item.id.toLowerCase(), item]));
        const add: DriveACL[] = [];
        const remove: string[] = [];

        for (const item of list) {
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

    return (
        <FormDialogForm
            submitLabel="Save"
            changed={hasChanges || contactInput.hasText}
            onSubmit={handleSave}
            footerStart={
                myTeams &&
                myTeams.length > 0 && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <FooterTool icon={Users} label="Share with team" />
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
            <label htmlFor={contactFieldId} className="sr-only">
                Add people
            </label>
            {/* Enter here adds the person typed, and never submits. */}
            <ContactAddRow
                id={contactFieldId}
                value={contactInput.value}
                onChange={contactInput.handleChange}
                onSubmit={contactInput.submit}
                error={contactInput.error}
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
                                value={access.read ? (access.write ? 'editor' : 'viewer') : 'remove'}
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
                <h4 id={generalAccessId} className="text-sm font-medium mb-2">
                    General access
                </h4>
                <GeneralAccess
                    visibility={visibility}
                    choice={
                        <Select
                            // A signed-in link that lets people edit is the same choice; the picker on the right says.
                            value={visibility === 'public-write' ? 'public-read' : visibility}
                            onValueChange={(value) => {
                                const choice = choices.find((c) => c === value);
                                if (choice) handleVisibilityChange(choice);
                            }}
                        >
                            <SelectTrigger
                                aria-labelledby={generalAccessId}
                                className="-ml-2 h-7 border-transparent px-2 font-medium shadow-none hover:bg-accent"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {choices.map((choice) => (
                                    <SelectItem key={choice} value={choice}>
                                        {GENERAL_ACCESS[choice].label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    }
                    description={visibility === 'link' ? linkNote : undefined}
                >
                    {visibility === 'link' && <span className="text-xs text-muted-foreground shrink-0">Can view</span>}
                    {(visibility === 'public-read' || visibility === 'public-write') && (
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
        </FormDialogForm>
    );
}
