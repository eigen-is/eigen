import { useAuth } from '@workspace/lib/auth';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import { UserAvatar } from '@workspace/ui/components/user';
import { cn } from '@workspace/ui/lib/utils';
import { Home } from 'lucide-react';

export function useMountLabel(activeOwnerId: string, activeMountId: string): string {
    const { data: myTeams } = useMyTeams();
    if (activeMountId === 'default') return 'Drive';
    const mount = myTeams
        ?.flatMap((t) => t.mounts.map((m) => ({ ...m, ownerId: teamOwnerId(t.id) })))
        .find((m) => m.id === activeMountId && m.ownerId === activeOwnerId);
    return mount?.name || 'Drive';
}

type DriveMountListProps = {
    activeMountId: string;
    activeOwnerId: string;
    onMountSelect: (ownerId: string, mountId: string) => void;
    ownMountsOnly?: boolean;
};

export function DriveMountList({ activeMountId, activeOwnerId, onMountSelect, ownMountsOnly }: DriveMountListProps) {
    const { user } = useAuth();
    const { data: myTeams } = useMyTeams();
    const myDriveOwnerId = user?.id ?? '';

    const teamsWithMounts = ownMountsOnly ? [] : (myTeams?.filter((t) => t.mounts.length > 0) ?? []);

    const activeClass = 'bg-muted text-primary font-medium';
    const baseClass = 'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left hover:bg-muted';

    return (
        <div className="flex flex-col gap-1">
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">My Drive</div>
            <button
                type="button"
                className={cn(
                    baseClass,
                    activeOwnerId === myDriveOwnerId && activeMountId === 'default' && activeClass,
                )}
                onClick={() => onMountSelect(myDriveOwnerId, 'default')}
            >
                <Home className="h-4 w-4 shrink-0" />
                <span className="truncate">Drive</span>
            </button>

            {teamsWithMounts.length > 0 && (
                <>
                    <div className="px-2 py-1 pt-3 text-xs font-medium text-muted-foreground">Teams</div>
                    {teamsWithMounts.flatMap((team) =>
                        team.mounts.map((mount) => (
                            <button
                                key={`${team.id}-${mount.id}`}
                                type="button"
                                className={cn(
                                    baseClass,
                                    activeOwnerId === teamOwnerId(team.id) && activeMountId === mount.id && activeClass,
                                )}
                                onClick={() => onMountSelect(teamOwnerId(team.id), mount.id)}
                            >
                                <UserAvatar email={teamOwnerId(team.id)} className="h-4 w-4 shrink-0" />
                                <span className="truncate">{mount.name}</span>
                            </button>
                        )),
                    )}
                </>
            )}
        </div>
    );
}
