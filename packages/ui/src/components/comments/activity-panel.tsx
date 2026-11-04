// A document's activity pane: its file history, newest first, as rows that open in the editor the card or the comment
// they name. Rows of other events, such as a rename, stay inert. Hosts show it through the panel column, beside the
// comments pane.

import { useFileHistory } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Activity } from 'lucide-react';
import { ActivityEventList } from '../drive/activity-event-list';
import { PropertiesPanel } from '../properties-panel';

type ActivityPanelProps = {
    path: DrivePath;
    // Opens the card a row names by its id, such as a sticky added to a column.
    onOpenCard: (cardId: string) => void;
    // Opens the comment a row names by its chat name. The host decides whether it opens live or as deleted.
    onOpenChat: (chatName: string) => void;
    className?: string;
};

export function ActivityPanel({ path, onOpenCard, onOpenChat, className }: ActivityPanelProps) {
    const { data: events = [], isPending } = useFileHistory(path.ownerId, path.mountId, path.id, 50);

    return (
        <PropertiesPanel className={className}>
            {/* Nothing shows while the first fetch runs, so "No activity yet" never flashes. */}
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
                            if (cardId) onOpenCard(cardId);
                            else if (chatName) onOpenChat(chatName);
                        }}
                    />
                </div>
            )}
        </PropertiesPanel>
    );
}
