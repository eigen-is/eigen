import {useMemo} from "react";
import {Unlock, UserRoundPlus} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {UserPublicAvatar} from "../user-public-avatar";
import {type DriveACL, type DrivePath} from "@workspace/lib/types/drive";
import {Tooltip, TooltipContent, TooltipTrigger} from "@workspace/ui/components/tooltip";
import {useBreadcrumb} from "@workspace/lib/drive";

export type DriveShareSummaryProps = {
    path: DrivePath;
    onClick?: () => void;
    showIconOnHover?: boolean;
}

export function DriveShareSummary({
                                      path,
                                      onClick,
                                      showIconOnHover = true,
                                  }: DriveShareSummaryProps) {
    const {data: breadcrumbData} = useBreadcrumb(path.ownerId, path.mountId, path.id);

    const ancestorAcl = useMemo<DriveACL[]>(() => {
        if (!breadcrumbData || breadcrumbData.length === 0) return [];
        const seen = new Set<string>();
        const result: DriveACL[] = [];
        for (const ancestor of breadcrumbData) {
            if (!ancestor.acl) continue;
            for (const acl of ancestor.acl) {
                const key = acl.id.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                result.push(acl);
            }
        }
        return result;
    }, [breadcrumbData]);

    const allEntries = useMemo(() => {
        const seen = new Set<string>();
        const result: DriveACL[] = [];
        for (const acl of [...(path.acl || []), ...(ancestorAcl || [])]) {
            const key = acl.id.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push(acl);
            }
        }
        return result;
    }, [path.acl, ancestorAcl]);

    const hasEntries = allEntries.length > 0;
    const isPublic = path.visibility !== 'private';
    const isShared = hasEntries || isPublic;

    return (
        <div
            className={cn(
                "flex items-center gap-1 cursor-pointer",
            )}
            onClick={(e) => {
                e.stopPropagation();
                onClick?.();
            }}
        >
            {isShared ? (
                <div className="flex items-center gap-1">
                    <UserPublicAvatar
                        email={path.ownerId}
                        size="sm"
                        className="position-relative"
                        style={{zIndex: 0}}
                    />
                    {isPublic && (
                        <Tooltip delayDuration={300}>
                            <TooltipTrigger asChild>
                                <span
                                    className="-ml-4 h-6 w-6 rounded-full flex items-center justify-center bg-gray-100 position-relative"
                                    style={{zIndex: 1}}
                                >
                                    <Unlock className="h-3 w-3 text-primary"/>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>Anyone with the link can access</TooltipContent>
                        </Tooltip>
                    )}
                    {allEntries.slice(0, isPublic ? 2 : 3).map((access, index) =>
                        <UserPublicAvatar
                            key={access.id}
                            email={access.id}
                            size="sm"
                            className="-ml-4 position-relative"
                            style={{zIndex: (isPublic ? 2 : 1) + index}}
                        />
                    )}
                    {allEntries.length > (isPublic ? 2 : 3) && (
                        <span className="text-xs text-muted-foreground ml-1">
                            +{allEntries.length - (isPublic ? 2 : 3)}
                        </span>
                    )}
                </div>
            ) : (
                showIconOnHover && (
                    <div className="invisible group-hover:visible">
                        <UserRoundPlus className="h-4 w-4 text-muted-foreground"/>
                    </div>
                )
            )}
        </div>
    );
}