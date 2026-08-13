import { cn } from '../../lib/utils.ts';

type KetProps = {
    className?: string;
    style?: React.CSSProperties;
};

export function Ket({ className, style, ...props }: KetProps) {
    return (
        <svg
            className={cn('inline align-baseline overflow-visible', className)}
            style={style}
            {...props}
            height="1em"
            viewBox="0 -8 14 22"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m3 0 4 7.5 -4 7.5" />
        </svg>
    );
}
