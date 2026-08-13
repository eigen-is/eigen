import { cn } from '../../lib/utils';

type EigenLogoProps = {
    className?: string;
    style?: React.CSSProperties;
};

export function EigenLogo({ className, style, ...props }: EigenLogoProps) {
    return (
        <svg
            className={cn('inline align-baseline overflow-visible', className)}
            style={style}
            {...props}
            height="1em"
            viewBox="4 -1.5 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m9 0 -4 7.5 4 7.5" />
            <path d="m17 0 4 7.5 -4 7.5" />
        </svg>
    );
}
