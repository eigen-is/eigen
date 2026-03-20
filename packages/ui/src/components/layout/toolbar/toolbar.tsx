import {ReactNode} from "react";

export function Toolbar({ children }: { children: ReactNode }) {
    return  (
        <div className="flex items-center justify-between w-full gap-1 no-print">
        {children}
    </div>);
}