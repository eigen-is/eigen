import { useDriveAccess } from '@workspace/lib/drive';
import type { DriveACL, DrivePath } from '@workspace/lib/types/drive';
import { AvatarIcon } from '@workspace/ui/components/avatar';
import { Separator } from '@workspace/ui/components/separator';
import { cn } from '@workspace/ui/lib/utils';
import { Lock, Unlock, UserRoundPlus } from 'lucide-react';
import { TooltipButton } from '../toolbar';
import { UserItem } from '../user-item';

export type DriveAccessListProps = {
    path: DrivePath;
    className?: string;
    onShareClick?: (path: DrivePath) => void;
};

export function DriveAccessList({ path, className, onShareClick }: DriveAccessListProps) {
    const { allEntries } = useDriveAccess(path);

    const isPublic = path.visibility !== 'private';

    return (
        <div className={cn('flex flex-col min-h-0', className)}>
            <div className="flex items-center justify-between h-12 border-t border-b shrink-0">
                <h3 className="text-base font-medium">People with access</h3>
                {onShareClick && (
                    <TooltipButton icon={UserRoundPlus} tooltipText="Edit Access" onClick={() => onShareClick(path)} />
                )}
            </div>

            <div className="space-y-2 py-4 overflow-y-auto min-h-0">
                {allEntries.map((access) => (
                    <UserItem
                        key={access.id}
                        email={access.id}
                        label={access.owner ? 'Owner' : <AccessLabel access={access} />}
                    />
                ))}
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
                            <p className="text-xs text-muted-foreground">
                                Only people with access can open with the link
                            </p>
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
                                    ? 'Anyone with the link can edit'
                                    : 'Anyone with the link can view'}
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
