// The thread side of an open card's dialog: the card's comment thread under a Comments tab, which names what the
// messages beside or below the card are. More tabs, such as the card's activity, join it once they have something to
// show.

import { CommentThread } from '../comments/comment-thread';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';
import type { ThreadPlacement } from './card-dialog-shell';

type CardThreadTabsProps = {
    ownerId: string;
    mountId: string;
    pathId: string;
    chatName: string;
    placement: ThreadPlacement;
};

export function CardThreadTabs({ ownerId, mountId, pathId, chatName, placement }: CardThreadTabsProps) {
    return (
        <Tabs value="comments" className="min-h-0 flex-1 gap-0">
            <div className="shrink-0 px-4 pt-3 pb-1">
                <TabsList className="w-full">
                    <TabsTrigger value="comments">Comments</TabsTrigger>
                </TabsList>
            </div>
            <TabsContent value="comments" className="flex min-h-0 flex-col">
                <CommentThread
                    ownerId={ownerId}
                    mountId={mountId}
                    pathId={pathId}
                    chatName={chatName}
                    placement={placement}
                />
            </TabsContent>
        </Tabs>
    );
}
