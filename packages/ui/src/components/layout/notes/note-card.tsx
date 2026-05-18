import { isLightColor, lightenColor } from '@workspace/lib/constants';
import { cn } from '@workspace/ui/lib/utils';
import type { HTMLAttributes, ReactNode } from 'react';
import { Card, CardContent } from '../../card';
import { Progress } from '../../progress';

// TipTap's TaskItem always emits `data-checked="true|false"` on each task-list
// <li>; anchoring on `<li` prevents matching unrelated data-checked attributes.
const TASK_ITEMS_RE = /<li[^>]*\bdata-checked=/g;
const CHECKED_ITEMS_RE = /<li[^>]*\bdata-checked="true"/g;

type NoteCardProps = Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'color'> & {
    title: string;
    description?: string;
    color?: string | null;
    statusIcon?: ReactNode;
    replyCount?: number;
    replyLabel?: string;
    ref?: React.Ref<HTMLDivElement>;
};

export function NoteCard({
    title,
    description,
    color,
    statusIcon,
    replyCount,
    replyLabel,
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
                color ? 'border-0' : 'border',
                onClick ? 'cursor-pointer' : '',
                className,
            )}
            style={{
                backgroundColor: color ? lightenColor(color, 0.25) : undefined,
                color: color ? (isLightColor(lightenColor(color, 0.25)) ? '#000' : '#fff') : undefined,
                ...style,
            }}
            onClick={onClick}
            onContextMenu={onContextMenu}
            {...rest}
        >
            <CardContent className="p-3 text-sm relative">
                {statusIcon && <span className="absolute top-2 right-2">{statusIcon}</span>}
                <span className={cn('line-clamp-2', statusIcon && 'pr-5')}>{title}</span>
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
                {!!replyCount && (
                    <p className="text-xs mt-0.5 opacity-50">
                        {replyCount} {replyLabel || (replyCount === 1 ? 'reply' : 'replies')}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
