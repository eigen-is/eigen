import {useChatRoom} from '@workspace/lib/chat';
import {useMediaResolver} from '@workspace/lib/drive';
import {ChatMessageInput, ChatMessageList} from '@workspace/ui';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {TooltipButton} from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import {Separator} from '@workspace/ui/components/separator';
import {Pencil} from 'lucide-react';
import {useState} from 'react';
import type * as Y from 'yjs';
import {CardSettingsDialog} from './card-settings-dialog';
import type {CardItem} from './types';

type CardDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    card: CardItem | null;
    canWrite?: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
};

function CardChat({ownerId, mountId, chatName}: { ownerId: string; mountId: string; chatName: string }) {
    const {resolveChatId} = useMediaResolver();
    const chatId = resolveChatId(chatName);

    if (!chatId) return <div className="px-4 pb-4 text-sm text-muted-foreground">Chat not found.</div>;

    return <CardChatInner ownerId={ownerId} mountId={mountId} chatId={chatId}/>;
}

function CardChatInner({ownerId, mountId, chatId}: { ownerId: string; mountId: string; chatId: string }) {
    const chat = useChatRoom(ownerId, mountId, chatId);

    return (
        <div className="flex flex-col h-[50vh] overflow-hidden">
            <ChatMessageList
                messages={chat.messages}
                isLoading={chat.isLoading}
                currentUserId={chat.currentUserId}
                ownerId={ownerId}
                mountId={mountId}
                mediaFolderId={chat.mediaFolderId}
                emptyMessage=""
            />
            <ChatMessageInput
                onSend={chat.handleSendMessage}
                disabled={chat.disabled}
                readOnly={chat.readOnly}
                placeholder="Write a comment..."
                roomMembers={chat.roomMembers}
                currentUserEmail={chat.currentUserEmail}
                messageCount={chat.messages.length}
            />
        </div>
    );
}

export function CardDialog({isOpen, onClose, card, canWrite = true, yjsDoc, ownerId, mountId}: CardDialogProps) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    if (!card) return null;

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
                <DialogContent size="md" className="max-h-[70vh] flex flex-col p-0 gap-0">
                    <DialogHeader className="flex flex-row items-center gap-2 px-4 pt-4 pb-2">
                        <DialogTitle className="flex-1">
                            {card.title}
                            {canWrite && (
                                <TooltipButton
                                    icon={Pencil}
                                    tooltipText="Edit Card"
                                    onClick={() => setIsSettingsOpen(true)}
                                    className="h-7 w-7 -mt-1"
                                />
                            )}
                        </DialogTitle>
                    </DialogHeader>

                    {card.description && (
                        <div className="px-4 py-3 text-sm text-foreground">
                            <p className="whitespace-pre-line">{card.description}</p>
                        </div>
                    )}

                    <Separator className="my-2"/>

                    {card.chatName ? (
                        <CardChat ownerId={ownerId} mountId={mountId} chatName={card.chatName}/>
                    ) : (
                        <div className="px-4 pb-4 text-sm text-muted-foreground">No chat available for this card.</div>
                    )}
                </DialogContent>
            </Dialog>

            {card && canWrite && (
                <CardSettingsDialog
                    key={card.id}
                    isOpen={isSettingsOpen}
                    onClose={() => setIsSettingsOpen(false)}
                    cardId={card.id}
                    cardTitle={card.title}
                    cardDescription={card.description}
                    cardColor={card.color || ''}
                    yjsDoc={yjsDoc}
                />
            )}
        </>
    );
}
