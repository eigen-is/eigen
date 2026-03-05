import {useState} from "react";
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";
import {TaskItem} from "./types";
import {Separator} from "@workspace/ui/components/separator";
import {Pencil} from "lucide-react";
import {TooltipButton} from "@workspace/ui/components/layout/toolbar/tooltip-button.tsx";
import {TaskSettingsDialog} from "./task-settings-dialog";
import {ChatMessageList, ChatMessageInput} from "@workspace/ui";
import {useChatRoom} from "@workspace/lib/chat";
import * as Y from "yjs";

interface TaskInfoDialogProps {
    isOpen: boolean;
    onClose: () => void;
    task: TaskItem | null;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
}

function TaskChat({ownerId, mountId, chatId}: { ownerId: string; mountId: string; chatId: string }) {
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

export function TaskInfoDialog({
                                   isOpen,
                                   onClose,
                                   task,
                                   yjsDoc,
                                   ownerId,
                                   mountId,
                               }: TaskInfoDialogProps) {
    const [isTaskSettingsOpen, setIsTaskSettingsOpen] = useState(false);

    if (!task) return null;

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
                <DialogContent className="sm:max-w-[500px] max-h-[70vh] flex flex-col p-0 gap-0">
                    <DialogHeader className="flex flex-row items-center gap-2 px-4 pt-4 pb-2">
                        <DialogTitle className="flex-1">{task.title} <TooltipButton
                            icon={Pencil}
                            tooltipText="Edit Task"
                            onClick={() => setIsTaskSettingsOpen(true)}
                            className="h-7 w-7 -mt-1"
                        /></DialogTitle>
                    </DialogHeader>

                    {task.description && (
                        <div className="px-4 text-sm text-gray-700">
                            <p className="whitespace-pre-line">{task.description}</p>
                        </div>
                    )}

                    <Separator className="my-2"/>

                    {task.chatId ? (
                        <TaskChat ownerId={ownerId} mountId={mountId} chatId={task.chatId}/>
                    ) : (
                        <div className="px-4 pb-4 text-sm text-muted-foreground">
                            No chat available for this task.
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {task && (
                <TaskSettingsDialog
                    isOpen={isTaskSettingsOpen}
                    onClose={() => setIsTaskSettingsOpen(false)}
                    taskId={task.id}
                    taskTitle={task.title}
                    taskDescription={task.description}
                    yjsDoc={yjsDoc}
                />
            )}
        </>
    );
}
