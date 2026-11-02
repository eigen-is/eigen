// Watch for one Drive item: useWatchToggle reads whether the viewer watches it, directly or through a
// folder above it, and turns a direct watch on or off. The button sits on a toolbar, such as a
// document's or the Drive detail column's; the menu row sits in a menu, such as the Drive item menu.

import { useIsPathWatched, useUnwatchPath, useWatchPath } from '@workspace/lib/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Bell, BellRing } from 'lucide-react';
import { DropdownMenuItem } from '../../dropdown-menu';
import { TooltipButton } from './tooltip-button';

type WatchToggleButtonProps = {
    ownerId: string;
    mountId: string;
    pathId: string;
};

export function useWatchToggle(ownerId: string, mountId: string, pathId: string) {
    const { data: status } = useIsPathWatched(ownerId, mountId, pathId);
    const watch = useWatchPath(ownerId, mountId, pathId);
    const unwatch = useUnwatchPath(ownerId, mountId, pathId);

    const direct = status?.direct ?? false;
    const label = direct
        ? 'Stop watching'
        : status?.viaAncestor
          ? `Watching via ${stripEigenExtension(status.viaAncestor.name)}`
          : 'Watch';
    return {
        direct,
        label,
        isPending: watch.isPending || unwatch.isPending,
        toggle: () => (direct ? unwatch.mutate() : watch.mutate()),
    };
}

export function WatchToggleButton({ ownerId, mountId, pathId }: WatchToggleButtonProps) {
    const { direct, label, isPending, toggle } = useWatchToggle(ownerId, mountId, pathId);
    return (
        <TooltipButton
            icon={direct ? BellRing : Bell}
            tooltipText={label}
            active={direct}
            disabled={isPending}
            onClick={toggle}
        />
    );
}

export function WatchMenuItem({ ownerId, mountId, pathId }: WatchToggleButtonProps) {
    const { direct, label, isPending, toggle } = useWatchToggle(ownerId, mountId, pathId);
    return (
        <DropdownMenuItem disabled={isPending} onClick={toggle}>
            {direct ? <BellRing /> : <Bell />}
            {label}
        </DropdownMenuItem>
    );
}
