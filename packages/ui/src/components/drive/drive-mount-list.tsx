// The drives a Drive browser can open: the viewer's own drive, then the drives of their teams. The desktop draws
// them as a column of buttons and a phone as a select above the folders, both from one list, and both ask their host
// for a drive by owner and mount id. useMountLabel names a drive from the same list, such as for a breadcrumb.

import { useAuth } from '@workspace/lib/auth';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@workspace/ui/components/select';
import { UserAvatar } from '@workspace/ui/components/user';
import { cn } from '@workspace/ui/lib/utils';
import { Home } from 'lucide-react';

type DriveMountListProps = {
    activeMountId: string;
    activeOwnerId: string;
    onMountSelect: (ownerId: string, mountId: string) => void;
    ownMountsOnly?: boolean;
};

type MountEntry = { ownerId: string; mountId: string; name: string };

export function useMountLabel(activeOwnerId: string, activeMountId: string): string {
    const { teamMounts } = useMountEntries(false);
    if (activeMountId === 'default') return 'Drive';
    const mount = teamMounts.find((m) => m.mountId === activeMountId && m.ownerId === activeOwnerId);
    return mount?.name || 'Drive';
}

export function DriveMountList({ activeMountId, activeOwnerId, onMountSelect, ownMountsOnly }: DriveMountListProps) {
    const { myDrive, teamMounts } = useMountEntries(ownMountsOnly);

    const activeClass = 'bg-muted text-primary font-medium';
    const baseClass = 'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left hover:bg-muted';
    const isActive = (entry: MountEntry) => entry.ownerId === activeOwnerId && entry.mountId === activeMountId;

    return (
        <div className="flex flex-col gap-1">
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">My Drive</div>
            <button
                type="button"
                className={cn(baseClass, isActive(myDrive) && activeClass)}
                onClick={() => onMountSelect(myDrive.ownerId, myDrive.mountId)}
            >
                <Home className="h-4 w-4 shrink-0" />
                <span className="truncate">{myDrive.name}</span>
            </button>

            {teamMounts.length > 0 && (
                <>
                    <div className="px-2 py-1 pt-3 text-xs font-medium text-muted-foreground">Teams</div>
                    {teamMounts.map((entry) => (
                        <button
                            key={mountKey(entry.ownerId, entry.mountId)}
                            type="button"
                            className={cn(baseClass, isActive(entry) && activeClass)}
                            onClick={() => onMountSelect(entry.ownerId, entry.mountId)}
                        >
                            <UserAvatar email={entry.ownerId} className="h-4 w-4 shrink-0" />
                            <span className="truncate">{entry.name}</span>
                        </button>
                    ))}
                </>
            )}
        </div>
    );
}

export function DriveMountSelect({ activeMountId, activeOwnerId, onMountSelect, ownMountsOnly }: DriveMountListProps) {
    const { myDrive, teamMounts } = useMountEntries(ownMountsOnly);
    const mountLabel = useMountLabel(activeOwnerId, activeMountId);
    const pick = (key: string) => {
        const entry = [myDrive, ...teamMounts].find((e) => mountKey(e.ownerId, e.mountId) === key);
        if (entry) onMountSelect(entry.ownerId, entry.mountId);
    };
    const item = (entry: MountEntry) => (
        <SelectItem
            key={mountKey(entry.ownerId, entry.mountId)}
            value={mountKey(entry.ownerId, entry.mountId)}
            className="pointer-coarse:min-h-11"
        >
            {entry.name}
        </SelectItem>
    );

    return (
        <Select value={mountKey(activeOwnerId, activeMountId)} onValueChange={pick}>
            <SelectTrigger aria-label="Drive" className="w-full data-[size=default]:h-11">
                <SelectValue>{mountLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    <SelectLabel>My Drive</SelectLabel>
                    {item(myDrive)}
                </SelectGroup>
                {teamMounts.length > 0 && (
                    <SelectGroup>
                        <SelectLabel>Teams</SelectLabel>
                        {teamMounts.map(item)}
                    </SelectGroup>
                )}
            </SelectContent>
        </Select>
    );
}

function useMountEntries(ownMountsOnly: boolean | undefined) {
    const { user } = useAuth();
    const { data: myTeams = [] } = useMyTeams();
    const myDrive: MountEntry = { ownerId: user?.id ?? '', mountId: 'default', name: 'Drive' };
    const teamMounts: MountEntry[] = ownMountsOnly
        ? []
        : myTeams.flatMap((team) =>
              team.mounts.map((mount) => ({ ownerId: teamOwnerId(team.id), mountId: mount.id, name: mount.name })),
          );
    return { myDrive, teamMounts };
}

function mountKey(ownerId: string, mountId: string) {
    return `${ownerId}/${mountId}`;
}
