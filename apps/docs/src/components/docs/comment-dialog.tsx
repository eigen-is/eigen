import {useState} from "react";
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";
import {Button} from "@workspace/ui/components/button";
import {Textarea} from "@workspace/ui/components/textarea";
import {useCreateChat} from "@workspace/lib/chat";
import {ChatMessageList, ChatMessageInput} from "@workspace/ui";
import {useChatRoom} from "@workspace/lib/chat";
import type {DrivePath} from "@workspace/lib/types/drive";

type CreateCommentDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    ownerId: string;
    mountId: string;
    chatFolderId: string;
    selectedText: string;
    onCommentCreated: (chatId: string) => void;
}

export function CreateCommentDialog({
                                        open,
                                        onOpenChange,
                                        ownerId,
                                        mountId,
                                        chatFolderId,
                                        selectedText,
                                        onCommentCreated,
                                    }: CreateCommentDialogProps) {
    const [comment, setComment] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const createChat = useCreateChat(ownerId, mountId);

    const handleSubmit = async () => {
        if (!comment.trim()) return;
        setIsSubmitting(true);

        try {
            const fileName = `comment-${Date.now()}`;
            const result = await createChat.mutateAsync({parentId: chatFolderId, fileName});
            const chatPath = result as DrivePath;

            if (chatPath?.id) {
                const {chatApi} = await import("@workspace/lib/api");
                await chatApi({ownerId})({mountId})({chatId: chatPath.id}).messages.post({
                    content: comment.trim(),
                });
                onCommentCreated(chatPath.id);
            }
        } finally {
            setIsSubmitting(false);
            setComment('');
            onOpenChange(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Add comment</DialogTitle>
                </DialogHeader>
                {selectedText && (
                    <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground italic border-l-2 border-primary">
                        "{selectedText.length > 100 ? selectedText.slice(0, 100) + '…' : selectedText}"
                    </div>
                )}
                <Textarea
                    autoFocus
                    placeholder="Write a comment..."
                    value={comment}
                    onChange={e => setComment(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSubmit();
                        }
                    }}
                    rows={3}
                />
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={handleSubmit} disabled={!comment.trim() || isSubmitting}>
                        Comment
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

type ViewCommentDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    ownerId: string;
    mountId: string;
    chatId: string;
}

export function ViewCommentDialog({
                                      open,
                                      onOpenChange,
                                      ownerId,
                                      mountId,
                                      chatId,
                                  }: ViewCommentDialogProps) {
    const chat = useChatRoom(ownerId, mountId, chatId);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[500px] max-h-[70vh] flex flex-col p-0 gap-0">
                <DialogHeader className="px-4 pt-4 pb-2">
                    <DialogTitle>Comment</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
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
                        placeholder="Reply..."
                        roomMembers={chat.roomMembers}
                        messageCount={chat.messages.length}
                    />
                </div>
            </DialogContent>
        </Dialog>
    );
}
