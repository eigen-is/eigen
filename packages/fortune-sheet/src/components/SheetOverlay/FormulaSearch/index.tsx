import React, {useContext} from "react";
import {WorkbookContext} from "../../../context";

export const FormulaSearch: React.FC<React.HTMLAttributes<HTMLDivElement>> = (
    props
) => {
    const {context} = useContext(WorkbookContext);
    if (context.functionCandidates.length === 0) return null;

    return (
        <div
            {...props}
            id="luckysheet-formula-search-c"
            className="absolute border border-black/20 shadow-md text-xs bg-background z-[1003] w-[300px]"
        >
            {context.functionCandidates.map((v, index) => (
                <div
                    key={v.n}
                    data-func={v.n}
                    className={`bg-background px-2.5 py-1.5 cursor-pointer ${
                        index === 0 ? "block border-y border-[#ebebeb] bg-[#f5f5f5]" : ""
                    }`}
                >
                    <div className="text-sm text-[#222]">{v.n}</div>
                    <div className={`text-[#444] ${index === 0 ? "block" : "hidden"}`}>{v.d}</div>
                </div>
            ))}
        </div>
    );
};

