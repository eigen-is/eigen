import React, {useCallback, useEffect, useRef} from "react";

type ContentEditableProps = Omit<
    React.HTMLAttributes<HTMLDivElement>,
    "onChange"
> & {
    initialContent?: string;
    innerRef?: (e: HTMLDivElement | null) => void;
    onChange?: (html: string, isBlur?: boolean) => void;
    onBlur?: (e: React.FocusEvent<HTMLDivElement, Element>) => void;
    autoFocus?: boolean;
    allowEdit?: boolean;
};

export const ContentEditable: React.FC<ContentEditableProps> = ({
    innerRef,
    onChange,
    onBlur,
    autoFocus,
    allowEdit: allowEditProp,
    initialContent,
    ...restProps
}) => {
    const lastHtml = useRef("");
    const root = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (autoFocus) {
            root.current?.focus();
        }
    }, [autoFocus]);

    // UNSAFE_componentWillUpdate
    useEffect(() => {
        if (initialContent && root.current != null) {
            root.current.innerHTML = initialContent;
        }
    }, [initialContent]);

    const fnEmitChange = useCallback(
        (__: any, isBlur?: boolean) => {
            let html;

            if (root.current != null) {
                html = root.current.innerHTML;
            }
            if (onChange && html !== lastHtml.current) {
                onChange(html || "", isBlur);
            }
            lastHtml.current = html || "";
        },
        [root, onChange]
    );

    const allowEdit = allowEditProp ?? true;

    return (
        <div
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            {...restProps}
            ref={(e) => {
                root.current = e;
                innerRef?.(e);
            }}
            tabIndex={0}
            onInput={fnEmitChange}
            onBlur={(e) => {
                fnEmitChange(null, true);
                onBlur?.(e);
            }}
            contentEditable={allowEdit}
        />
    );
};
