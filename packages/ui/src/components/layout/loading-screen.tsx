import {cn} from '../../lib/utils';
import {EigenLoader} from "./eigen-loader.tsx";

type LoadingScreenProps = {
    className?: string;
};


export function LoadingScreen({className}: LoadingScreenProps) {
    return (
        <>
            <div className="fixed inset-0 flex items-center justify-center bg-white">
                <EigenLoader className={cn("text-muted-foreground", className)}/>
            </div>
        </>
    );
}
