import {useState} from 'react';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {CardItem} from './types';
import {Separator} from '@workspace/ui/components/separator';
import {Pencil} from 'lucide-react';
import {TooltipButton} from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import {CardSettingsDialog} from './card-settings-dialog';
import {ChatMessageInput, ChatMessageList} from '@workspace/ui';
import {useChatRoom} from '@workspace/lib/chat';
import * as Y from 'yjs';

type CardDialogProps = {
    isOpen: boolean;
    onClose: () => void;
    card: CardItem | null;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
}

function CardChat({ownerId, mountId, chatId}: {ownerId: string; mountId: string; chatId: string}) {
    const chat = useChatRoom(ownerId, mountId, chatId);

    return (
        <div className="flex flex-col h-[50vh] overflow-hidden">
            <ChatMessageList
                messages={chat.messages}
                isLoading={chat.isLoading}
                currentUserId={chat.currentUserId}
                ownerId={ownerId}
                mountId={mountId}
                emptyMessage=""
            />
            <ChatMessageInput
                onSend={chat.handleSendMessage}
                disabled={chat.disabled}
                readOnly={chat.readOnly}
                placeholder="Write a comment..."
                roomMembers={chat.roomMembers}
                messageCount={chat.messages.length}
            />
        </div>
    );
}

export function CardDialog({isOpen, onClose, card, yjsDoc, ownerId, mountId}: CardDialogProps) {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    if (!card) return null;

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
                <DialogContent size="md" className="max-h-[70vh] flex flex-col p-0 gap-0">
                    <DialogHeader className="flex flex-row items-center gap-2 px-4 pt-4 pb-2">
                        <DialogTitle className="flex-1">
                            {card.title}
                            <TooltipButton
                                icon={Pencil}
                                tooltipText="Edit Card"
                                onClick={() => setIsSettingsOpen(true)}
                                className="h-7 w-7 -mt-1"
                            />
                        </DialogTitle>
                    </DialogHeader>

                    {card.description && (
                        <div className="px-4 text-sm text-foreground">
                            <p className="whitespace-pre-line">{card.description}</p>
                        </div>
                    )}

                    <Separator className="my-2"/>

                    {card.chatId ? (
                        <CardChat ownerId={ownerId} mountId={mountId} chatId={card.chatId}/>
                    ) : (
                        <div className="px-4 pb-4 text-sm text-muted-foreground">
                            No chat available for this card.
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {card && (
                <CardSettingsDialog
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
