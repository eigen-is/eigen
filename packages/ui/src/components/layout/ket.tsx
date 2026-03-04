import {cn} from "@workspace/ui/lib/utils";

interface BraProps {
    className?: string
    style?: React.CSSProperties
}

export function Ket({
                        className,
                        style,
                        ...props
                    }: BraProps) {
    return (
        <svg
            className={cn("inline align-baseline overflow-visible", className)}
            style={style}
            {...props}
            height="1rem"
            viewBox="0 0 14 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m3 2 4 7.5 -4 7.5"/>
        </svg>
    )
}