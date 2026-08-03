import { useFileHistory } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Activity, X } from 'lucide-react';
import { PropertiesPanel } from '../properties-panel';
import { TooltipButton } from '../toolbar/tooltip-button';
import { ActivityEventList } from './activity-event-list';

type ActivityPanelProps = {
    path: DrivePath;
    onClose: () => void;
    // Opens the card/comment a row references in-doc; other rows stay inert (see ActivityEventList).
    onOpenCard?: (ref: { cardId?: string; chatName?: string }) => void;
    className?: string;
    // For hosts that carry the title in their own chrome (the docs mobile Column toolbar).
    hideHeader?: boolean;
};

export function ActivityPanel({ path, onClose, onOpenCard, className, hideHeader }: ActivityPanelProps) {
    const { data: events = [], isPending } = useFileHistory(path.ownerId, path.mountId, path.id, 50);

    return (
        <PropertiesPanel className={className}>
            {!hideHeader && (
                <div className="px-3 py-2 border-b flex items-center justify-between">
                    <span className="text-sm font-medium">Activity</span>
                    <TooltipButton icon={X} tooltipText="Close" className="h-6 w-6" onClick={onClose} />
                </div>
            )}

            {/* isPending guard: no "No activity yet" flash while the first fetch is in flight. */}
            {isPending ? null : events.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <Activity className="h-8 w-8 mb-2 opacity-40" />
                    <p className="text-xs">No activity yet</p>
                </div>
            ) : (
                <div className="py-1">
                    <ActivityEventList path={path} events={events} onOpenCard={onOpenCard} />
                </div>
            )}
        </PropertiesPanel>
    );
}
