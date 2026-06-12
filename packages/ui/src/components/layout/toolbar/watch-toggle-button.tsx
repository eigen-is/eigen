import { useIsPathWatched, useUnwatchPath, useWatchPath } from '@workspace/lib/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Bell, BellRing } from 'lucide-react';
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
            onClick={() => (direct ? unwatch.mutate() : watch.mutate())}
        />
    );
}
