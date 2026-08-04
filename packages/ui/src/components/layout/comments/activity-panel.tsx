import { findCardIdByChatName } from '@workspace/lib/comments';
import { useFileHistory } from '@workspace/lib/drive';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Activity, X } from 'lucide-react';
import { ActivityEventList } from '../drive/activity-event-list';
import { PropertiesPanel } from '../properties-panel';
import { TooltipButton } from '../toolbar/tooltip-button';

type ActivityPanelProps = {
    path: DrivePath;
    cards: Record<string, CommentCard>;
    // Absent = the host draws its own chrome, so the panel renders no header.
    onClose?: () => void;
    // Opens the card a row references in-doc; other rows stay inert (see ActivityEventList).
    onOpenCard: (cardId: string) => void;
    className?: string;
};

export function ActivityPanel({ path, cards, onClose, onOpenCard, className }: ActivityPanelProps) {
    const { data: events = [], isPending } = useFileHistory(path.ownerId, path.mountId, path.id, 50);

    return (
        <PropertiesPanel className={className}>
            {onClose && (
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
                    <ActivityEventList
                        path={path}
                        events={events}
                        onOpenCard={({ cardId, chatName }) => {
                            const id = cardId ?? (chatName ? findCardIdByChatName(cards, chatName) : undefined);
                            if (id) onOpenCard(id);
                        }}
                    />
                </div>
            )}
        </PropertiesPanel>
    );
}
