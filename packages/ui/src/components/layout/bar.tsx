import {cn} from "@workspace/ui/lib/utils";

interface BarProps {
    className?: string
    style?: React.CSSProperties
}

export function Bar({
                        className,
                        style,
                        ...props
                    }: BarProps) {
    return (
        <svg
            className={cn("inline align-baseline overflow-visible", className)}
            style={style}
            {...props}
            height="1rem"
            viewBox="0 0 8 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m4 2 0 16"/>
        </svg>
    )
}