import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@workspace/ui/components/dialog";
import { UserPublicItem } from "@workspace/ui/components/layout/user-item";
import { TaskItem, CommentItem } from "./types";
import { Button } from "@workspace/ui/components/button";
import { Textarea } from "@workspace/ui/components/textarea";
import { ScrollArea } from "@workspace/ui/components/scroll-area";
import { nanoid } from "nanoid";
import * as Y from "yjs";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@workspace/lib/auth/auth-context.tsx";

interface TaskInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  task: TaskItem | null;
  yjsDoc: Y.Doc | null;
  ownerId: string;
  comments: Record<string, CommentItem>;
}

export function TaskInfoDialog({
  isOpen,
  onClose,
  task,
  yjsDoc,
  ownerId,
  comments,
}: TaskInfoDialogProps) {
  const [newComment, setNewComment] = useState("");
  const { user } = useAuth();

  if (!task) return null;

  // Get comments for this task only
  const taskComments = Object.values(comments)
    .filter((comment) => comment.taskId === task.id)
    .sort((a, b) => b.createdAt - a.createdAt); // Sort by newest first

  const handleAddComment = () => {
    if (!newComment.trim() || !yjsDoc || !task) return;
    
    yjsDoc.transact(() => {
      const commentId = `comment-${nanoid(10)}`;
      const now = Date.now();
      
      // Add to comments map in Yjs
      const commentsMap = yjsDoc.getMap("comments");
      const newCommentMap = new Y.Map();
      
      newCommentMap.set("id", commentId);
      newCommentMap.set("taskId", task.id);
      newCommentMap.set("text", newComment);
      newCommentMap.set("author", user?.email || '');
      newCommentMap.set("createdAt", now);
      
      commentsMap.set(commentId, newCommentMap);
    });
    
    setNewComment("");
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{task.title}</DialogTitle>
        </DialogHeader>
        
        {/* Task description */}
        {task.description && (
          <div className="mt-2 text-sm text-gray-700">
            <p className="whitespace-pre-line">{task.description}</p>
          </div>
        )}
        
        {/* Creator info */}
        <div className="mt-4">
          <h3 className="text-sm font-medium mb-1">Created by</h3>
          <UserPublicItem 
            email={task.creator} 
            label={formatDistanceToNow(task.createdAt, { addSuffix: true })}
          />
        </div>
        
        {/* Comments section */}
        <div className="mt-6">
          <h3 className="text-sm font-medium mb-3">Comments</h3>
          
          {/* New comment input */}
          <div className="mb-4">
            <Textarea
              placeholder="Write a comment..."
              value={newComment}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNewComment(e.target.value)}
              className="min-h-20 mb-2"
            />
            <div className="flex justify-end">
              <Button 
                onClick={handleAddComment} 
                disabled={!newComment.trim()}
                size="sm"
              >
                Add Comment
              </Button>
            </div>
          </div>
          
          {/* Comments list */}
          <ScrollArea className="h-64 rounded-md border p-2">
            {taskComments.length > 0 ? (
              <div className="space-y-4">
                {taskComments.map((comment) => (
                  <div key={comment.id} className="border-b pb-3">
                    <UserPublicItem
                      email={comment.author}
                      label={formatDistanceToNow(comment.createdAt, { addSuffix: true })}
                      className="mb-1"
                    />
                    <p className="text-sm text-gray-700 ml-10 whitespace-pre-line">
                      {comment.text}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                No comments yet
              </div>
            )}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
