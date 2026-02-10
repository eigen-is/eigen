import {useState} from "react";
import {Progress} from "@workspace/ui/components/progress";
import {useHomeSize} from "@workspace/lib/home";
import {EigenLoader} from "@workspace/ui";
import {cn} from "@workspace/ui/lib/utils";
import {formatFileSize} from "@workspace/ui/lib/formatFileSize";

export type StorageData = {
    used: number;
    max: number;
    drive?: number;
    mail?: number;
    contacts?: number;
    [key: string]: number | undefined;
}

type StorageUsageProps = {
    className?: string;
    condensed?: boolean;
}

const getStorageUsageColor = (storageUsed: number): string => {
    if (!storageUsed || isNaN(storageUsed) || storageUsed === Infinity) return "";
    else if (storageUsed > 0.85) return "bg-red-500";
    else if (storageUsed > 0.65) return "bg-yellow-500";
    return "";
};

export function StorageUsage({className = "", condensed = false}: StorageUsageProps) {
    // Get storage usage data
    const {data: storageData, isLoading: storageLoading} = useHomeSize();
    const [showDetails, setShowDetails] = useState(false);

    return (
        <div className={cn(`p-3 select-none cursor-pointer`, className)} onClick={() => setShowDetails(!showDetails)}>
            <div>
                {!condensed && <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-medium text-muted-foreground">Storage</span>
                    <span className="text-xs text-muted-foreground">
                        {storageLoading
                            ? <EigenLoader/>
                            : storageData
                                ? `${formatFileSize(storageData.used)} / ${formatFileSize(storageData.max)}`
                                : "Unknown"}
                    </span>
                </div>}
                <Progress
                    value={storageLoading || !storageData ? 0 : (storageData.used / storageData.max) * 100}
                    indicatorClassName={getStorageUsageColor(storageLoading || !storageData ? 0 : (storageData.used / storageData.max))}
                    className="h-1.5"
                />
            </div>

            <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                    (showDetails && !condensed) ? "max-h-36 opacity-100" : "max-h-0 opacity-0"
                }`}
            >
                <div className="space-y-2 mt-2 text-xs">
                    {storageData && Object.entries(storageData)
                        .filter(([key, value]) => key !== "used" && key !== "max" && value !== undefined)
                        .map(([key, value]) => (
                            <div key={key} className="flex justify-between">
                                <span className="text-muted-foreground capitalize">{key}</span>
                                <span>{formatFileSize(value as number)}</span>
                            </div>
                        ))}
                </div>
            </div>
        </div>
    );
}
