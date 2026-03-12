import React, {useEffect, useRef} from "react";

type Props = React.PropsWithChildren<{
    onClick?: (
        e: React.MouseEvent<HTMLDivElement, MouseEvent>,
        container: HTMLDivElement
    ) => void;
    onMouseLeave?: (
        e: React.MouseEvent<HTMLDivElement, MouseEvent>,
        container: HTMLDivElement
    ) => void;
    onMouseEnter?: (
        e: React.MouseEvent<HTMLDivElement, MouseEvent>,
        container: HTMLDivElement
    ) => void;
}>;

export const Menu: React.FC<Props> = ({
                                          onClick,
                                          onMouseLeave,
                                          onMouseEnter,
                                          children,
                                      }) => {
    useEffect(() => {
        const element = document.querySelector("[data-context-menu-item]");
        if (element) {
            (element as HTMLDivElement).focus();
        }
    }, []);

    const containerRef = useRef<HTMLDivElement>(null);
    return (
        <div
            ref={containerRef}
            data-context-menu-item
            className="luckysheet-cols-menuitem luckysheet-mousedown-cancel relative text-foreground cursor-pointer m-0 py-0.5 pl-2 pr-6 whitespace-nowrap align-middle select-none hover:bg-accent"
            onClick={(e) => onClick?.(e, containerRef.current!)}
            onMouseLeave={(e) => onMouseLeave?.(e, containerRef.current!)}
            onMouseEnter={(e) => onMouseEnter?.(e, containerRef.current!)}
            tabIndex={0}
        >
            <div
                className="luckysheet-cols-menuitem-content luckysheet-mousedown-cancel relative cursor-pointer m-0 py-1.5 px-2 whitespace-nowrap select-none">
                {children}
            </div>
        </div>
    );
};

