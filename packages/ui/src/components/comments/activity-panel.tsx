// A document's activity pane: its file history, newest first, as rows that open in the editor the card or the comment
// they name. Rows of other events, such as a rename, stay inert. Hosts show it through the panel column, beside the
// comments pane.

import { findCardIdByChatName } from '@workspace/lib/comments';
import { useFileHistory } from '@workspace/lib/drive';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Activity } from 'lucide-react';
import { ActivityEventList } from '../drive/activity-event-list';
import { PropertiesPanel } from '../properties-panel';

type ActivityPanelProps = {
    path: DrivePath;
    cards: Record<string, CommentCard>;
    // Opens the card a row references in-doc; other rows stay inert (see ActivityEventList).
    onOpenCard: (cardId: string) => void;
    // Opens a comment row whose card is gone from the map, by its chat name, such as a sticky deleted from its board.
    onOpenChat?: (chatName: string) => void;
    className?: string;
};

export function ActivityPanel({ path, cards, onOpenCard, onOpenChat, className }: ActivityPanelProps) {
    const { data: events = [], isPending } = useFileHistory(path.ownerId, path.mountId, path.id, 50);

    return (
        <PropertiesPanel className={className}>
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
                            else if (chatName) onOpenChat?.(chatName);
                        }}
                    />
                </div>
            )}
        </PropertiesPanel>
    );
}
