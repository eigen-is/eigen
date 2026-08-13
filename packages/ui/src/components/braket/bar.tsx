import { cn } from '../../lib/utils.ts';

type BarProps = {
    className?: string;
    style?: React.CSSProperties;
};

export function Bar({ className, style, ...props }: BarProps) {
    return (
        <svg
            className={cn('inline align-baseline overflow-visible', className)}
            style={style}
            {...props}
            height="1em"
            viewBox="0 -8 7 22"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m4 0 0 16" />
        </svg>
    );
}
