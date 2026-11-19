// The thread side of an open card's dialog: tabs for All, Comments and Activity over the card's comment thread. The
// card's activity has no rows yet, so All shows the comments and Activity says there is none. All and Comments share
// one thread, so moving between them keeps its scroll and a reply being typed.

import { useState } from 'react';
import { CommentThread } from '../comments/comment-thread';
import { EmptyState } from '../layout/app/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';
import type { ThreadPlacement } from './card-dialog-shell';

type CardThreadTab = 'all' | 'comments' | 'activity';

type CardThreadTabsProps = {
    ownerId: string;
    mountId: string;
    pathId: string;
    chatName: string;
    placement: ThreadPlacement;
};

export function CardThreadTabs({ ownerId, mountId, pathId, chatName, placement }: CardThreadTabsProps) {
    const [tab, setTab] = useState<CardThreadTab>('all');
    return (
        <Tabs
            value={tab}
            onValueChange={(value) => setTab(value === 'comments' || value === 'activity' ? value : 'all')}
            className="min-h-0 flex-1 gap-0"
        >
            <div className="shrink-0 px-4 pt-3 pb-1">
                <TabsList className="w-full">
                    <TabsTrigger value="all">All</TabsTrigger>
                    <TabsTrigger value="comments">Comments</TabsTrigger>
                    <TabsTrigger value="activity">Activity</TabsTrigger>
                </TabsList>
            </div>
            {/* One panel whose value follows the tab, so the thread stays mounted between All and Comments. */}
            <TabsContent value={tab} className="flex min-h-0 flex-col">
                {tab === 'activity' ? (
                    <EmptyState message="No activity yet" />
                ) : (
                    <CommentThread
                        ownerId={ownerId}
                        mountId={mountId}
                        pathId={pathId}
                        chatName={chatName}
                        placement={placement}
                    />
                )}
            </TabsContent>
        </Tabs>
    );
}
