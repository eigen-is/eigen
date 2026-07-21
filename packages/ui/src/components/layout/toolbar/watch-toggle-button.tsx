import { useIsPathWatched, useUnwatchPath, useWatchPath } from '@workspace/lib/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Bell, BellRing } from 'lucide-react';
import { DropdownMenuItem } from '../../dropdown-menu.tsx';
import { TooltipButton } from './tooltip-button.tsx';

type WatchToggleButtonProps = {
    ownerId: string;
    mountId: string;
    pathId: string;
};

export function WatchToggleButton({ ownerId, mountId, pathId }: WatchToggleButtonProps) {
    const { data: status } = useIsPathWatched(ownerId, mountId, pathId);
    const watch = useWatchPath(ownerId, mountId, pathId);
    const unwatch = useUnwatchPath(ownerId, mountId, pathId);

    const direct = status?.direct ?? false;
    const isPending = watch.isPending || unwatch.isPending;
    const tooltip = direct
        ? 'Stop watching'
        : status?.viaAncestor
          ? `Watching via ${stripEigenExtension(status.viaAncestor.name)}`
          : 'Watch';

    return (
        <TooltipButton
            icon={direct ? BellRing : Bell}
            tooltipText={tooltip}
            active={direct}
            disabled={isPending}
            onClick={() => (direct ? unwatch.mutate() : watch.mutate())}
        />
    );
}

// Kebab-menu counterpart of WatchToggleButton, used by DocumentShareCluster on mobile.
export function WatchMenuItem({ ownerId, mountId, pathId }: WatchToggleButtonProps) {
    const { data: status } = useIsPathWatched(ownerId, mountId, pathId);
    const watch = useWatchPath(ownerId, mountId, pathId);
    const unwatch = useUnwatchPath(ownerId, mountId, pathId);

    const direct = status?.direct ?? false;
    const isPending = watch.isPending || unwatch.isPending;
    const label = direct
        ? 'Stop watching'
        : status?.viaAncestor
          ? `Watching via ${stripEigenExtension(status.viaAncestor.name)}`
          : 'Watch';

    return (
        <DropdownMenuItem disabled={isPending} onClick={() => (direct ? unwatch.mutate() : watch.mutate())}>
            {direct ? <BellRing className="mr-2" /> : <Bell className="mr-2" />}
            {label}
        </DropdownMenuItem>
    );
}
