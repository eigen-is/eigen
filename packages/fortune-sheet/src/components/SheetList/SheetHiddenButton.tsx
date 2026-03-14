import {api, Sheet} from "../../core";
import {CSSProperties, useCallback, useContext} from "react";
import {EyeOff} from "lucide-react";
import {WorkbookContext} from "../../context";

type Props = {
    style?: CSSProperties;
    sheet?: Sheet;
};

export function SheetHiddenButton({style, sheet}: Props) {
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
            {sheet?.hide === 1 && (
                <EyeOff
                    width={16}
                    height={16}
                    style={{
                        marginTop: "7px",
                    }}
                    aria-hidden="true"
                />
            )}
        </div>
    );
}

