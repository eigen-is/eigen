import {useState} from "react";
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,} from "@workspace/ui/components/dialog";
import {Button} from "@workspace/ui/components/button";
import {Textarea} from "@workspace/ui/components/textarea";
import {useChatRoom, useCreateChat} from "@workspace/lib/chat";
import {ChatMessageInput, ChatMessageList} from "@workspace/ui";
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
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>Add Comment</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    {selectedText && (
                        <div className="rounded-lg bg-muted border-l-4 border-primary p-3">
                            <p className="text-sm text-muted-foreground italic">
                                "{selectedText.length > 100 ? selectedText.slice(0, 100) + '…' : selectedText}"
                            </p>
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
                        className="min-h-[80px] resize-none"
                    />
                </div>
                <DialogFooter className="flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={isSubmitting}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={!comment.trim() || isSubmitting}
                    >
                        {isSubmitting ? "Commenting..." : "Comment"}
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
            <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col p-0">
                <DialogHeader className="px-6 pt-6 pb-4">
                    <DialogTitle>Comment</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col flex-1 min-h-0 overflow-hidden px-6">
                    <ChatMessageList
                        messages={chat.messages}
                        isLoading={chat.isLoading}
                        currentUserId={chat.currentUserId}
                        ownerId={ownerId}
                        mountId={mountId}
                        emptyMessage=""
                        className="flex-1"
                    />
                    <div className="mt-4 pb-6">
                        <ChatMessageInput
                            onSend={chat.handleSendMessage}
                            disabled={chat.disabled}
                            readOnly={chat.readOnly}
                            placeholder="Reply..."
                            roomMembers={chat.roomMembers}
                            messageCount={chat.messages.length}
                        />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
