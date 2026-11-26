// The read-only view of who can open a Drive item: the people with access, each with their role, and the link's
// general access. A long list collapses under a header that counts the roles. It shows where someone may look but not
// edit, such as an item's details pane. GENERAL_ACCESS and GeneralAccess name and draw the general access wherever it
// shows, such as in the Share dialog's form, so every place says the same thing.

import { useDriveAccess } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveACL, DriveAccessItem, DriveVisibility } from '@workspace/lib/types/drive-access';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { AvatarIcon } from '@workspace/ui/components/avatar';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Globe, Lock, Unlock, UserRoundPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { TooltipButton } from '../layout/toolbar';
import { CollapsibleUserList } from '../user/collapsible-user-list';
import { UserItem } from '../user/user-item';

const SIGNED_IN = { label: 'Anyone signed in with the link', description: 'They sign in to open it', icon: Unlock };

// What each general access is called, by the value stored: a signed-in link also stores whether it lets people edit.
export const GENERAL_ACCESS: Record<DriveVisibility, { label: string; description: string; icon: LucideIcon }> = {
    private: { label: 'Restricted', description: 'Only people with access', icon: Lock },
    'public-read': SIGNED_IN,
    'public-write': SIGNED_IN,
    link: { label: 'Anyone with the link', description: 'No sign-in needed', icon: Globe },
};

export type DriveAccessListProps = {
    path: DrivePath;
    className?: string;
    onShareClick?: (path: DrivePath) => void;
    scrollable?: boolean;
};

export function DriveAccessList({ path, className, onShareClick, scrollable }: DriveAccessListProps) {
    const { allEntries } = useDriveAccess(path);

    const { visibility } = path;
    const count = allEntries.length;
    const title = count === 1 ? '1 person with access' : `${count} people with access`;
    const summary = buildSummary(allEntries);

    return (
        <div className={cn('flex flex-col min-h-0', className)}>
            <div className={cn(scrollable && 'app-gutter-bleed min-h-0 overflow-y-auto')}>
                <CollapsibleUserList
                    title={title}
                    summaryLines={summary ? [summary] : undefined}
                    count={count}
                    actions={
                        onShareClick ? (
                            <TooltipButton
                                icon={UserRoundPlus}
                                tooltipText="Share"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => onShareClick(path)}
                            />
                        ) : undefined
                    }
                >
                    {allEntries.map((access) => (
                        <UserItem
                            key={access.id}
                            email={access.id}
                            label={access.owner ? 'Owner' : <AccessLabel access={access} />}
                            popover={parseOwnerId(access.id).type === 'team'}
                        />
                    ))}
                </CollapsibleUserList>
            </div>
            <div className="shrink-0 pt-4">
                <h4 className="text-sm font-medium mb-2">General access</h4>
                <GeneralAccess visibility={visibility}>
                    {visibility !== 'private' && (
                        <span className="text-xs text-muted-foreground">
                            {visibility === 'public-write' ? 'Can edit' : 'Can view'}
                        </span>
                    )}
                </GeneralAccess>
            </div>
        </div>
    );
}

type GeneralAccessProps = {
    visibility: DriveVisibility;
    // A control in place of the name, and words in place of the short line under it.
    choice?: ReactNode;
    description?: ReactNode;
    // What the link lets someone do, on the right: as text, or the picker that changes it.
    children?: ReactNode;
};

export function GeneralAccess({ visibility, choice, description, children }: GeneralAccessProps) {
    const { label, description: shortDescription, icon: Icon } = GENERAL_ACCESS[visibility];
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="flex items-start">
                <AvatarIcon className="w-8 h-8 shrink-0">
                    <Icon />
                </AvatarIcon>
                <div className="ml-3">
                    {choice ?? <p className="text-sm font-medium">{label}</p>}
                    <p className="text-xs text-muted-foreground">{description ?? shortDescription}</p>
                </div>
            </div>
            {children}
        </div>
    );
}

function buildSummary(entries: readonly DriveAccessItem[]): string {
    let owners = 0;
    let editors = 0;
    let viewers = 0;
    for (const entry of entries) {
        if (entry.owner) owners++;
        else if (entry.write) editors++;
        else if (entry.read) viewers++;
    }
    const parts: string[] = [];
    if (owners) parts.push(`${owners} owner${owners > 1 ? 's' : ''}`);
    if (editors) parts.push(`${editors} editor${editors > 1 ? 's' : ''}`);
    if (viewers) parts.push(`${viewers} viewer${viewers > 1 ? 's' : ''}`);
    return parts.join(', ');
}

function AccessLabel({ access }: { access: DriveACL }) {
    if (access.write) {
        return <span>Editor</span>;
    }
    if (access.read) {
        return <span>Viewer</span>;
    }
    return null;
}
