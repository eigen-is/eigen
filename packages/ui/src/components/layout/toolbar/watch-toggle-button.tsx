// Watch for one Drive item, drawn from useWatchToggle: a bell that rings while the viewer watches the item
// directly. The button sits on a toolbar, such as a document's or the Drive detail column's; the menu row
// sits in a menu, such as the Drive item menu. Neither draws where the hook answers no toggle, as for a
// visitor without a login.

import { useWatchToggle } from '@workspace/lib/drive';
import { Bell, BellRing } from 'lucide-react';
import { DropdownMenuItem } from '../../dropdown-menu';
import { TooltipButton } from './tooltip-button';

type WatchToggleButtonProps = {
    ownerId: string;
    mountId: string;
    pathId: string;
};

export function WatchToggleButton({ ownerId, mountId, pathId }: WatchToggleButtonProps) {
    const watch = useWatchToggle(ownerId, mountId, pathId);
    if (!watch) return null;
    const { direct, label, isPending, toggle } = watch;
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
    const watch = useWatchToggle(ownerId, mountId, pathId);
    if (!watch) return null;
    const { direct, label, isPending, toggle } = watch;
    return (
        <DropdownMenuItem disabled={isPending} onClick={toggle}>
            {direct ? <BellRing /> : <Bell />}
            {label}
        </DropdownMenuItem>
    );
}
