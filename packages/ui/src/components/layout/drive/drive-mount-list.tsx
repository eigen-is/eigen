import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import { cn } from '@workspace/ui/lib/utils';
import { HardDrive, UsersRound } from 'lucide-react';

type DriveMountListProps = {
    ownerId: string;
    activeMountId: string;
    activeOwnerId: string;
    onMountSelect: (ownerId: string, mountId: string) => void;
};

export function DriveMountList({ ownerId, activeMountId, activeOwnerId, onMountSelect }: DriveMountListProps) {
    const { data: myTeams } = useMyTeams();

    const teamsWithMounts = myTeams?.filter((t) => t.mounts.length > 0) ?? [];

    return (
        <div className="flex flex-col gap-1">
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">My Drive</div>
            <button
                type="button"
                className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left',
                    activeOwnerId === ownerId && activeMountId === 'default' && 'bg-accent font-medium',
                )}
                onClick={() => onMountSelect(ownerId, 'default')}
            >
                <HardDrive className="h-4 w-4 shrink-0" />
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
                                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left',
                                    activeOwnerId === teamOwnerId(team.id) &&
                                        activeMountId === mount.id &&
                                        'bg-accent font-medium',
                                )}
                                onClick={() => onMountSelect(teamOwnerId(team.id), mount.id)}
                            >
                                <UsersRound className="h-4 w-4 shrink-0" />
                                <span className="truncate">{mount.name}</span>
                            </button>
                        )),
                    )}
                </>
            )}
        </div>
    );
}
