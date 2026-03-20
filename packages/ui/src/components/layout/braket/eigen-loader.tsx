import {cn} from '../../../lib/utils.ts';

type EigenLoaderProps = {
    className?: string;
};

export function EigenLoader({className}: EigenLoaderProps) {
    return (
        <svg
            className={cn("inline text-muted-foreground", className)}
            height="1em"
            viewBox="0 -8 28 22"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <g>
                <path d="m9 0 -4 7.5 4 7.5"/>
                <animateTransform attributeName="transform" type="translate" values="0,0;-6,0;0,0" dur="1.5s"
                                  begin="0.3s" repeatCount="indefinite"/>
            </g>
            <g>
                <path d="m17 0 4 7.5 -4 7.5"/>
                <animateTransform attributeName="transform" type="translate" values="0,0;6,0;0,0" dur="1.5s"
                                  begin="0.3s" repeatCount="indefinite"/>
            </g>
        </svg>
    );
}
