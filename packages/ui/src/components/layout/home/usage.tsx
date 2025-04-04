import {useState} from "react";
import {Progress} from "@workspace/ui/components/progress";
import {Button} from "@workspace/ui/components/button";
import {ChevronDown, ChevronUp} from "lucide-react";
import {useHomeSize} from "@workspace/lib/home";

// Type definition for storage data
export interface StorageData {
    used: number;
    max: number;
    drive?: number;
    mail?: number;
    contacts?: number;

    [key: string]: number | undefined;
}

interface StorageUsageProps {
    className?: string;
}

export function StorageUsage({className = ""}: StorageUsageProps) {
    // Get storage usage data
    const {data: storageData, isLoading: storageLoading} = useHomeSize();
    const [showDetails, setShowDetails] = useState(false);

    // Format bytes to human-readable format
    const formatBytes = (bytes: number) => {
        if (bytes === 0) return "0 Bytes";
        const k = 1024;
        const sizes = ["Bytes", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    };

    return (
        <div className={`p-3 border-t ${className}`}>
            <div className="cursor-pointer" onClick={() => setShowDetails(!showDetails)}>
                <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-medium text-muted-foreground">Storage</span>
                    <span className="text-xs text-muted-foreground">
            {storageLoading
                ? "..."
                : storageData
                    ? `${formatBytes(storageData.used)} / ${formatBytes(storageData.max)}`
                    : "Unknown"}
          </span>
                </div>
                <Progress
                    value={storageLoading || !storageData ? 0 : (storageData.used / storageData.max) * 100}
                    className="h-1.5"
                />
                <div className="flex justify-end mt-0.5">
                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0">
                        {showDetails ? (
                            <ChevronUp className="h-3 w-3"/>
                        ) : (
                            <ChevronDown className="h-3 w-3"/>
                        )}
                    </Button>
                </div>
            </div>

            <div
                className={`overflow-hidden transition-all duration-300 ease-in-out ${
                    showDetails ? "max-h-36 opacity-100" : "max-h-0 opacity-0"
                }`}
            >
                <div className="space-y-2 mt-2 text-xs">
                    {storageData && Object.entries(storageData)
                        .filter(([key, value]) => key !== "used" && key !== "max" && value !== undefined)
                        .map(([key, value]) => (
                            <div key={key} className="flex justify-between">
                                <span className="text-muted-foreground capitalize">{key}</span>
                                <span>{formatBytes(value as number)}</span>
                            </div>
                        ))}
                </div>
            </div>
        </div>
    );
}
