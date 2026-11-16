// A card as it sits on a board or in a list, such as a sticky: its cover image, title, a preview of the
// description, how far its checklist is done, and a muted footer with an unread dot, replies, attachments and
// the assignee, whose avatar gets a ring in the app's color on an open card assigned to the viewer. A deleted
// comment keeps the uncolored frame and only its title. The caller handles a click, usually by opening
// NoteCardDialog.

import { useAuth } from '@workspace/lib/auth';
import { EIGEN_STICKIES_INDICATOR_MAP, lightenColor, readableTextColor } from '@workspace/lib/constants/colors';
import { countTaskItems } from '@workspace/lib/html';
import { cn } from '@workspace/ui/lib/utils';
import { Check, Paperclip } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { Card, CardContent } from '../card';
import { DeletedComment } from '../comments/deleted-comment';
import { MemberAvatar } from '../comments/member-avatar';
import { Progress } from '../progress';
import { UnreadDot } from '../unread-dot';

type NoteCardProps = Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'color'> & {
    title: string;
    description?: string;
    color?: string | null;
    resolved?: boolean;
    replyCount?: number;
    unread?: boolean;
    coverThumbnailUrl?: string;
    attachmentCount?: number;
    assigneeEmail?: string | null;
    deleted?: boolean;
    ref?: React.Ref<HTMLDivElement>;
};

export function NoteCard({
    title,
    description,
    color,
    resolved,
    replyCount,
    unread,
    coverThumbnailUrl,
    attachmentCount,
    assigneeEmail,
    deleted,
    onClick,
    onContextMenu,
    className,
    style,
    ref,
    ...rest
}: NoteCardProps) {
    const { user } = useAuth();
    const { checked, total } = countTaskItems(description ?? '');
    const frameColor = deleted ? null : color;
    // Open only, as the toolbar badge counts: a resolved card asks nothing more of you. The server stores the assignee
    // in lowercase.
    const onMyPlate = !resolved && assigneeEmail === user?.email.toLowerCase();

    return (
        <Card
            ref={ref}
            className={cn(
                'p-0 w-full shadow-md select-none rounded-none',
                frameColor
                    ? // An inset shadow, not a border, so the color bar doesn't shift the text. In dark mode the
                      // card looks like a mail list row: a 2px stripe in the full color over a faint wash of it.
                      'border-0 bg-(--note-bg) text-(--note-fg) dark:bg-(--note-soft) dark:text-card-foreground dark:shadow-[inset_2px_0_0_0_var(--note-indicator)]'
                    : 'border',
                onClick ? 'cursor-pointer' : '',
                className,
            )}
            style={{
                ...(frameColor
                    ? {
                          '--note-bg': lightenColor(frameColor, 0.25),
                          '--note-fg': readableTextColor(lightenColor(frameColor, 0.25)),
                          '--note-indicator': EIGEN_STICKIES_INDICATOR_MAP.get(frameColor) ?? frameColor,
                          '--note-soft': 'color-mix(in oklab, var(--note-indicator) 14%, var(--background))',
                      }
                    : undefined),
                ...style,
            }}
            onClick={onClick}
            onContextMenu={onContextMenu}
            {...rest}
        >
            <CardContent className="p-3 text-sm">
                {deleted ? (
                    <DeletedComment title={title} />
                ) : (
                    <>
                        {coverThumbnailUrl && (
                            <img
                                src={coverThumbnailUrl}
                                alt=""
                                draggable={false}
                                className="mb-2 h-20 w-full object-cover rounded-sm"
                            />
                        )}
                        <span className="line-clamp-2">{title}</span>
                        {description && (
                            <div
                                className="text-xs mt-1 max-h-24 overflow-hidden opacity-70 pointer-events-none [&>*+*]:mt-1.5 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
                                dangerouslySetInnerHTML={{ __html: description }}
                            />
                        )}
                        {total > 0 && (
                            <div className="mt-2 flex items-center gap-2 opacity-60">
                                <Progress
                                    value={(checked / total) * 100}
                                    className="flex-1 h-1 bg-current/20"
                                    indicatorClassName="bg-current"
                                />
                                <span className="text-xs tabular-nums">
                                    {checked}/{total}
                                </span>
                            </div>
                        )}
                        {(unread || !!replyCount || !!attachmentCount || resolved || assigneeEmail) && (
                            <p className="text-xs mt-2 flex items-center gap-2">
                                {unread && <UnreadDot className="static shrink-0" />}
                                {!!replyCount && (
                                    <span className="opacity-50">
                                        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                                    </span>
                                )}
                                {!!attachmentCount && (
                                    <span className="flex items-center gap-0.5 opacity-50">
                                        <Paperclip className="h-3 w-3" /> {attachmentCount}
                                    </span>
                                )}
                                {resolved && <Check className="h-3 w-3 ml-auto opacity-50" />}
                                {assigneeEmail && (
                                    <MemberAvatar
                                        email={assigneeEmail}
                                        className={cn(
                                            !resolved && 'ml-auto',
                                            onMyPlate ? 'ring-1 ring-(--app-current-color)' : 'opacity-50',
                                        )}
                                    />
                                )}
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
