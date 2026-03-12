import {api, Sheet} from "../../core";
import React, {CSSProperties, useCallback, useContext} from "react";
import {SVGIcon} from "../icon-map";
import WorkbookContext from "../../context";

type Props = {
    style?: CSSProperties;
    sheet?: Sheet;
};

const SheetHiddenButton: React.FC<Props> = ({style, sheet}) => {
    const {context, setContext} = useContext(WorkbookContext);
    const showSheet = useCallback(() => {
        if (context.allowEdit === false) return;
        if (!sheet) return;
        setContext((ctx) => {
            api.showSheet(ctx, sheet.id as string);
        });
    }, [context.allowEdit, setContext, sheet]);

    return (
        <div
            style={style}
            onClick={(e) => {
                e.stopPropagation();
                showSheet();
            }}
            tabIndex={0}
            className="mr-[15px] inline-flex absolute right-0 justify-end hover:bg-muted"
        >
            {sheet?.hide === 1 ? (
                <SVGIcon
                    name="hidden"
                    width={16}
                    height={16}
                    style={{
                        marginTop: "7px",
                    }}
                />
            ) : (
                ""
            )}
        </div>
    );
};

export default SheetHiddenButton;
