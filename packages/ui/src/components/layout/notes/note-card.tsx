import { lightenColor } from '@workspace/lib/constants';
import type { HTMLAttributes, ReactNode } from 'react';
import { Card, CardContent } from '../../card';
import { isLightColor } from '../media/color-picker';

type NoteCardProps = HTMLAttributes<HTMLDivElement> & {
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
    return (
        <Card
            ref={ref}
            className={`p-0 w-full shadow-md select-none rounded-none cursor-pointer ${!color ? 'border' : 'border-0'} ${className || ''}`}
            style={{
                backgroundColor: color ? lightenColor(color, 0.25) : undefined,
                color: color ? (isLightColor(color) ? '#000' : '#fff') : undefined,
                ...style,
            }}
            onClick={onClick}
            onContextMenu={onContextMenu}
            {...rest}
        >
            <CardContent className="p-3 text-sm relative">
                {statusIcon && <span className="absolute top-2 right-2">{statusIcon}</span>}
                <span className={`line-clamp-2 ${statusIcon ? 'pr-5' : ''}`}>{title}</span>
                {description && <p className="text-xs mt-1 line-clamp-2 opacity-70">{description}</p>}
                {replyCount && replyCount > 0 && (
                    <p className="text-xs mt-0.5 opacity-50">
                        {replyCount} {replyLabel || (replyCount === 1 ? 'reply' : 'replies')}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
