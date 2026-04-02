import { lightenColor } from '@workspace/lib/constants';
import type { CommentEntry } from '@workspace/lib/types/chat';
import { Check, Circle } from 'lucide-react';
import { Card, CardContent } from '../../card';
import { isLightColor } from '../media/color-picker';

type CommentCardProps = {
    comment: CommentEntry;
    anchorText?: string;
    onClick?: () => void;
};

export function CommentCard({ comment, anchorText, onClick }: CommentCardProps) {
    const color = comment.color;
    const title = anchorText || comment.chatName;
    const description = comment.lastAuthorEmail ? `Comment by ${comment.lastAuthorEmail.split('@')[0]}` : undefined;

    return (
        <Card
            className={`p-0 w-full shadow-md select-none rounded-none cursor-pointer ${!color ? 'border' : 'border-0'}`}
            style={{
                backgroundColor: color ? lightenColor(color, 0.25) : undefined,
                color: color ? (isLightColor(color) ? '#000' : '#fff') : undefined,
            }}
            onClick={onClick}
        >
            <CardContent className="p-3 text-sm relative">
                <span className="absolute top-2 right-2">
                    {comment.status === 'resolved' ? (
                        <Check className="h-3.5 w-3.5 opacity-50" />
                    ) : (
                        <Circle className="h-2.5 w-2.5 fill-current opacity-40" />
                    )}
                </span>
                <span className="line-clamp-2 pr-5">{title}</span>
                {description && (
                    <p className="text-xs mt-1 line-clamp-1" style={{ opacity: 0.7 }}>
                        {description}
                    </p>
                )}
                {comment.messageCount > 1 && (
                    <p className="text-xs mt-0.5" style={{ opacity: 0.5 }}>
                        {comment.messageCount - 1} {comment.messageCount === 2 ? 'reply' : 'replies'}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
