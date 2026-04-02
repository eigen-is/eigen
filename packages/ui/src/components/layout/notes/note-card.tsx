import { lightenColor } from '@workspace/lib/constants';
import type { ReactNode } from 'react';
import { Card, CardContent } from '../../card';
import { isLightColor } from '../media/color-picker';

type NoteCardProps = {
    title: string;
    description?: string;
    color?: string | null;
    statusIcon?: ReactNode;
    replyCount?: number;
    onClick?: (e: React.MouseEvent) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    className?: string;
    style?: React.CSSProperties;
    ref?: React.Ref<HTMLDivElement>;
};

export function NoteCard({
    title,
    description,
    color,
    statusIcon,
    replyCount,
    onClick,
    onContextMenu,
    className,
    style,
    ref,
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
        >
            <CardContent className="p-3 text-sm relative">
                {statusIcon && <span className="absolute top-2 right-2">{statusIcon}</span>}
                <span className={`line-clamp-2 ${statusIcon ? 'pr-5' : ''}`}>{title}</span>
                {description && (
                    <p className="text-xs mt-1 line-clamp-2" style={{ opacity: 0.7 }}>
                        {description}
                    </p>
                )}
                {!!replyCount && replyCount > 0 && (
                    <p className="text-xs mt-0.5" style={{ opacity: 0.5 }}>
                        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
