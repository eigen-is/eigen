// The read-only view of who can open a Drive item: the people with access, each with their role, and the link's
// general access. A long list collapses under a header that counts the roles. It shows where someone may look but
// not edit, such as an item's details pane or the Share dialog of a viewer. The general access line is shared with
// the Share dialog's form, so both say the same thing.

import { useDriveAccess } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveACL, DriveAccessItem, DriveVisibility } from '@workspace/lib/types/drive-access';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { AvatarIcon } from '@workspace/ui/components/avatar';
import { cn } from '@workspace/ui/lib/utils';
import { Lock, Unlock, UserRoundPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { TooltipButton } from '../layout/toolbar';
import { CollapsibleUserList } from '../user/collapsible-user-list';
import { UserItem } from '../user/user-item';

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
                <h3 className="eigen-section-label mb-2">General access</h3>
                <GeneralAccess
                    visibility={visibility}
                    icon={
                        <AvatarIcon className="w-8 h-8">{visibility === 'private' ? <Lock /> : <Unlock />}</AvatarIcon>
                    }
                >
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
    // The lock: a plain icon where the viewer may only look, a button that flips it in the Share dialog's form.
    icon: ReactNode;
    // What the link lets someone do, on the right: as text, or the picker that changes it.
    children?: ReactNode;
};

// The link's general access, which the read-only list and the Share dialog's form both draw.
export function GeneralAccess({ visibility, icon, children }: GeneralAccessProps) {
    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center">
                {icon}
                <div className="ml-3">
                    <p className="text-sm font-medium">{visibility === 'private' ? 'Restricted' : 'Unrestricted'}</p>
                    <p className="text-xs text-muted-foreground">
                        {visibility === 'private' ? 'Only people with access' : 'Anyone signed in with the link'}
                    </p>
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
