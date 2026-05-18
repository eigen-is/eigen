import { getTaskStats } from '@workspace/lib/comments';
import { isLightColor, lightenColor } from '@workspace/lib/constants';
import { cn } from '@workspace/ui/lib/utils';
import { type HTMLAttributes, type ReactNode, useMemo } from 'react';
import { Card, CardContent } from '../../card';
import { Progress } from '../../progress';
import { LightEditor } from '../editor/light-editor';

type NoteCardProps = Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'color'> & {
    title: string;
    description?: string;
    color?: string | null;
    statusIcon?: ReactNode;
    replyCount?: number;
    replyLabel?: string;
    // Fires after a read-only checkbox click inside `description`. Receives the
    // post-toggle HTML. Pass `undefined` to keep the description inert (e.g.
    // when the user has no write permission, or in drag-preview overlays).
    onDescriptionChange?: (html: string) => void;
    ref?: React.Ref<HTMLDivElement>;
};

export function NoteCard({
    title,
    description,
    color,
    statusIcon,
    replyCount,
    replyLabel,
    onDescriptionChange,
    onClick,
    onContextMenu,
    className,
    style,
    ref,
    ...rest
}: NoteCardProps) {
    const taskStats = useMemo(
        () => (description ? getTaskStats(description) : { total: 0, checked: 0 }),
        [description],
    );

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
                    <div className="text-xs mt-1 max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
                        <LightEditor
                            key={description}
                            content={description}
                            editable={false}
                            toolbar="none"
                            taskList
                            proseStyle={false}
                            containerClassName="relative opacity-70"
                            className="min-h-0 [&>*+*]:mt-1.5"
                            onCheckedChange={onDescriptionChange}
                        />
                    </div>
                )}
                {taskStats.total > 0 && (
                    <div className="mt-2 flex items-center gap-2 opacity-60">
                        <Progress
                            value={(taskStats.checked / taskStats.total) * 100}
                            className="flex-1 h-1 bg-current/20"
                            indicatorClassName="bg-current"
                        />
                        <span className="text-xs tabular-nums">
                            {taskStats.checked}/{taskStats.total}
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
