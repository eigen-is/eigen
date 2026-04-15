import { getDriveShareUrl } from '@workspace/lib/api';
import { useDriveAccess } from '@workspace/lib/drive';
import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import { AvatarIcon } from '@workspace/ui/components/avatar';
import { Separator } from '@workspace/ui/components/separator';
import { cn } from '@workspace/ui/lib/utils';
import { ClipboardCopy, Link, Lock, Mail, Unlock, UserRoundPlus } from 'lucide-react';
import { toast } from 'sonner';
import { CollapsibleUserList } from '../collapsible-user-list';
import { TooltipButton } from '../toolbar';
import { UserItem } from '../user-item';

export type DriveAccessListProps = {
    path: DrivePath;
    className?: string;
    onShareClick?: (path: DrivePath) => void;
    onEmailClick?: () => void;
};

function buildSummary(entries: { owner?: boolean; write?: boolean; read?: boolean }[]): string {
    let owners = 0;
    let editors = 0;
    let viewers = 0;
    for (const e of entries) {
        if (e.owner) owners++;
        else if (e.write) editors++;
        else if (e.read) viewers++;
    }
    const parts: string[] = [];
    if (owners) parts.push(`${owners} owner${owners > 1 ? 's' : ''}`);
    if (editors) parts.push(`${editors} editor${editors > 1 ? 's' : ''}`);
    if (viewers) parts.push(`${viewers} viewer${viewers > 1 ? 's' : ''}`);
    return parts.join(', ');
}

export function DriveAccessList({ path, className, onShareClick, onEmailClick }: DriveAccessListProps) {
    const { allEntries } = useDriveAccess(path);

    const isPublic = path.visibility !== 'private';
    const count = allEntries.length;
    const title = count === 1 ? '1 person with access' : `${count} people with access`;
    const summary = buildSummary(allEntries);

    const handleCopyEmails = () => {
        const emails = allEntries.map((e) => e.id).join(', ');
        navigator.clipboard.writeText(emails);
        toast.success('Emails copied to clipboard');
    };

    return (
        <div className={cn('flex flex-col min-h-0', className)}>
            <div className="border-t py-4">
                <CollapsibleUserList
                    title={title}
                    summaryLines={count > 3 ? [summary] : undefined}
                    count={count}
                    actions={
                        <>
                            <TooltipButton
                                icon={ClipboardCopy}
                                tooltipText="Copy emails"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={handleCopyEmails}
                            />
                            <TooltipButton
                                icon={Link}
                                tooltipText="Copy link"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => {
                                    navigator.clipboard.writeText(getDriveShareUrl(path));
                                    toast.success('Link copied to clipboard');
                                }}
                            />
                            {onEmailClick && (
                                <TooltipButton
                                    icon={Mail}
                                    tooltipText="Email collaborators"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    onClick={onEmailClick}
                                />
                            )}
                            {onShareClick && (
                                <TooltipButton
                                    icon={UserRoundPlus}
                                    tooltipText="Share"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    onClick={() => onShareClick(path)}
                                />
                            )}
                        </>
                    }
                >
                    {allEntries.map((access) => (
                        <UserItem
                            key={access.id}
                            email={access.id}
                            label={access.owner ? 'Owner' : <AccessLabel access={access} />}
                        />
                    ))}
                </CollapsibleUserList>
            </div>
            <Separator className="shrink-0" />
            <div className="shrink-0 pt-4">
                <h4 className="text-sm font-medium mb-2">General access</h4>
                {!isPublic ? (
                    <div className="flex items-center">
                        <AvatarIcon className="w-10 h-10">
                            <Lock />
                        </AvatarIcon>
                        <div>
                            <p className="text-sm font-medium">Restricted</p>
                            <p className="text-xs text-muted-foreground">Only people with access</p>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center">
                        <AvatarIcon className="w-10 h-10">
                            <Unlock />
                        </AvatarIcon>
                        <div>
                            <p className="text-sm font-medium">Unrestricted</p>
                            <p className="text-xs text-muted-foreground">
                                {path.visibility === 'public-write'
                                    ? 'Any authenticated user with the link can edit'
                                    : 'Any authenticated user with the link can view'}
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
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
