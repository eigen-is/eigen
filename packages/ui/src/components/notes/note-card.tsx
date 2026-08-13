import { EIGEN_STICKIES_INDICATOR_MAP, isLightColor, lightenColor } from '@workspace/lib/constants';
import { cn } from '@workspace/ui/lib/utils';
import { Check, Paperclip } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { Card, CardContent } from '../card';
import { MemberAvatar } from '../comments/member-avatar';
import { Progress } from '../progress';

// TipTap's TaskItem always emits `data-checked="true|false"` on each task-list
// <li>; anchoring on `<li` prevents matching unrelated data-checked attributes.
const TASK_ITEMS_RE = /<li[^>]*\bdata-checked=/g;
const CHECKED_ITEMS_RE = /<li[^>]*\bdata-checked="true"/g;

type NoteCardProps = Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'color'> & {
    title: string;
    description?: string;
    color?: string | null;
    resolved?: boolean;
    replyCount?: number;
    coverThumbnailUrl?: string;
    attachmentCount?: number;
    assigneeEmail?: string | null;
    ref?: React.Ref<HTMLDivElement>;
};

export function NoteCard({
    title,
    description,
    color,
    resolved,
    replyCount,
    coverThumbnailUrl,
    attachmentCount,
    assigneeEmail,
    onClick,
    onContextMenu,
    className,
    style,
    ref,
    ...rest
}: NoteCardProps) {
    const total = description ? (description.match(TASK_ITEMS_RE) ?? []).length : 0;
    const checked = description ? (description.match(CHECKED_ITEMS_RE) ?? []).length : 0;

    return (
        <Card
            ref={ref}
            className={cn(
                'p-0 w-full shadow-md select-none rounded-none',
                color
                    ? // Inset shadow, not a border: the color bar must not shift the text.
                      // Dark mode mirrors the mail list row: 2px inset stripe in the saturated
                      // color + a 14% color-mix wash over --background (see --note-soft below).
                      'border-0 bg-(--note-bg) text-(--note-fg) dark:bg-(--note-soft) dark:text-card-foreground dark:shadow-[inset_2px_0_0_0_var(--note-indicator)]'
                    : 'border',
                onClick ? 'cursor-pointer' : '',
                className,
            )}
            style={{
                ...(color
                    ? ({
                          '--note-bg': lightenColor(color, 0.25),
                          '--note-fg': isLightColor(lightenColor(color, 0.25)) ? '#000' : '#fff',
                          '--note-indicator': EIGEN_STICKIES_INDICATOR_MAP.get(color) ?? color,
                          '--note-soft': 'color-mix(in oklab, var(--note-indicator) 14%, var(--background))',
                      } as React.CSSProperties)
                    : undefined),
                ...style,
            }}
            onClick={onClick}
            onContextMenu={onContextMenu}
            {...rest}
        >
            <CardContent className="p-3 text-sm relative">
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
                {(!!replyCount || !!attachmentCount || resolved || assigneeEmail) && (
                    <p className="text-xs mt-0.5 opacity-50 flex items-center gap-2">
                        {!!replyCount && (
                            <span>
                                {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                            </span>
                        )}
                        {!!attachmentCount && (
                            <span className="flex items-center gap-0.5">
                                <Paperclip className="h-3 w-3" /> {attachmentCount}
                            </span>
                        )}
                        {resolved && <Check className="h-3 w-3 ml-auto" />}
                        {assigneeEmail && <MemberAvatar email={assigneeEmail} className={resolved ? '' : 'ml-auto'} />}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
