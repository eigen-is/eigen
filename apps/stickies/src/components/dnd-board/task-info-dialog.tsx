import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { TaskItem, CommentItem } from "./types";
import { Button } from "@workspace/ui/components/button";
import { Textarea } from "@workspace/ui/components/textarea";
import { ScrollArea } from "@workspace/ui/components/scroll-area";
import { nanoid } from "nanoid";
import * as Y from "yjs";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@workspace/lib/auth/auth-context.tsx";
import { useAvatar } from "@workspace/lib/media";
import { UserAvatar } from "@workspace/ui/components/layout/user-avatar";
import { cn } from "@workspace/ui/lib/utils";
import { Separator } from "@workspace/ui/components/separator";
import React from "react";
import { Pencil } from "lucide-react";
import { TooltipButton } from "@workspace/ui/components/layout/tooltip-button/tooltip-button";
import { TaskSettingsDialog } from "./task-settings-dialog";

interface TaskInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  task: TaskItem | null;
  yjsDoc: Y.Doc | null;
  ownerId: string;
}

export function TaskInfoDialog({
  isOpen,
  onClose,
  task,
  yjsDoc,
  ownerId,
}: TaskInfoDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { user } = useAuth();

  // --- Yjs comments observer ---
  const [yjsComments, setYjsComments] = useState<Record<string, CommentItem>>({});

  useEffect(() => {
    if (!yjsDoc) return;
    const commentsMap = yjsDoc.getMap("comments");

    // Helper to convert Y.Map to CommentItem
    const mapToComment = (map: Y.Map<any>): CommentItem => ({
      id: map.get("id"),
      taskId: map.get("taskId"),
      text: map.get("text"),
      author: map.get("author"),
      createdAt: map.get("createdAt"),
    });

    // Initial load
    const loadComments = () => {
      const result: Record<string, CommentItem> = {};
      commentsMap.forEach((value, key) => {
        if (value instanceof Y.Map) {
          result[key] = mapToComment(value);
        }
      });
      setYjsComments(result);
    };
    loadComments();

    // Observer
    const observer = () => {
      loadComments();
    };
    commentsMap.observe(observer);
    return () => {
      commentsMap.unobserve(observer);
    };
  }, [yjsDoc]);

  if (!task) return null;

  // Memoize taskComments to keep array reference stable for React.memo
  const taskComments = useMemo(() => {
    return Object.values(yjsComments)
      .filter((c) => c.taskId === task?.id)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [yjsComments, task?.id]);

  const handleAddComment = () => {
    const value = textareaRef.current?.value.trim() ?? "";
    if (!value || !yjsDoc || !task) return;
    yjsDoc.transact(() => {
      const commentId = `comment-${nanoid(10)}`;
      const now = Date.now();
      const commentsMap = yjsDoc.getMap("comments");
      const newCommentMap = new Y.Map();
      newCommentMap.set("id", commentId);
      newCommentMap.set("taskId", task.id);
      newCommentMap.set("text", value);
      newCommentMap.set("author", user?.email || '');
      newCommentMap.set("createdAt", now);
      commentsMap.set(commentId, newCommentMap);
    });
    if (textareaRef.current) textareaRef.current.value = "";
  };

  // State to track textarea focus
  const [textareaHasFocus, setTextareaHasFocus] = useState(false);

  // Task edit state
  const [isTaskSettingsOpen, setIsTaskSettingsOpen] = useState(false);

  const UserRow = React.memo(function UserRow({
    email,
    timeLabel,
    leftLabel,
    className,
    children,
  }: {
    email: string,
    timeLabel: string,
    leftLabel?: string,
    className?: string,
    children?: React.ReactNode,
  }) {
    const { data } = useAvatar(email, { enabled: true });
    return (
      <div className={cn("flex items-top", className)}>
        <UserAvatar name={data?.name || email} email={data?.email || email} imageUrl={data?.avatar} size="md" />
        <div className="ml-3 flex-1">
          <div className="flex justify-between items-baseline">
            <p className="text-sm font-medium text-gray-900">
              {leftLabel ? `${leftLabel} ` : ''}
              {data?.name || email}
            </p>
            <span className="text-xs text-gray-500 whitespace-nowrap ml-4 mr-2">{timeLabel}</span>
          </div>
          {children && (
            <div className="text-sm text-gray-700 whitespace-pre-line mt-0.5 mr-2">{children}</div>
          )}
        </div>
      </div>
    );
  });

  const CommentRow = React.memo(function CommentRow({ comment }: { comment: CommentItem }) {
    return (
      <UserRow
        email={comment.author}
        timeLabel={formatDistanceToNow(comment.createdAt, { addSuffix: true })}
      >
        {comment.text}
      </UserRow>
    );
  });

  const TaskCommentList = React.memo(function TaskCommentList({ taskComments, creator, createdAt }: { taskComments: CommentItem[], creator: string, createdAt: Date }) {
    return (
      <ScrollArea className="h-100 rounded-md p-2">
        <div className="space-y-4">
          {taskComments.map((comment) => (
            <React.Fragment key={comment.id}>
              <CommentRow comment={comment} />
              <Separator />
            </React.Fragment>
          ))}
          <UserRow
            email={creator}
            timeLabel={formatDistanceToNow(createdAt, { addSuffix: true })}
            leftLabel="Created by"
          />
        </div>
      </ScrollArea>
    );
  });

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
        <DialogContent>
          <DialogHeader className="flex flex-row items-center gap-2">
            <DialogTitle className="flex-1">{task.title} <TooltipButton
              icon={Pencil}
              tooltipText="Edit Task"
              onClick={() => setIsTaskSettingsOpen(true)}
              className="h-7 w-7 -mt-1"
            /></DialogTitle>
            
          </DialogHeader>

          {/* Task description */}
          <div className="mt-2 text-sm text-gray-700">
            <p className="whitespace-pre-line">{task.description ?? ''}</p>
          </div>

          <Separator/>

          {/* Comments section */}
          <div>
            {/* New comment input (avatar left, textarea, button) */}
            <div className="mb-4 flex items-start gap-3">
              <UserAvatar
                name={user?.name || user?.email || ''}
                email={user?.email || ''}
                imageUrl={user?.avatar}
                size="md"
                className="mt-1"
              />
              <div className="flex-1">
                <Textarea
                  placeholder="Write a comment..."
                  ref={textareaRef}
                  className="min-h-20 mb-2"
                  onFocus={() => setTextareaHasFocus(true)}
                  onBlur={() => setTextareaHasFocus(false)}
                  autoFocus={false}
                />
                <div className="flex justify-end">
                  <Button
                    onClick={handleAddComment}
                    size="sm"
                    className={`transform transition-all duration-200 ease-in-out ${
                      textareaHasFocus 
                        ? "opacity-100 translate-y-0" 
                        : "opacity-0 translate-y-2 pointer-events-none h-0"
                    }`}
                  >
                    Add Comment
                  </Button>
                </div>
              </div>
            </div>

            {/* Comments list (no border, compact) */}
            <TaskCommentList taskComments={taskComments} creator={task.creator} createdAt={new Date(task.createdAt)} />
          </div>
        </DialogContent>
      </Dialog>

      {/* Task settings dialog */}
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
