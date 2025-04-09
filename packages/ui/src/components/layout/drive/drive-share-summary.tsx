import { Link } from "lucide-react";
import { cn } from "@workspace/ui/lib/utils";

export interface Acl {
  email: string;
  // Add other ACL properties as needed
}

export interface DriveShareSummaryProps {
  acl?: Acl[] | null;
  onClick?: () => void;
  showIconOnHover?: boolean;
}

export function DriveShareSummary({
  acl,
  onClick,
  showIconOnHover = true,
}: DriveShareSummaryProps) {
  const isShared = acl && acl.length > 0;
  
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
        <div className="text-sm text-muted-foreground">
          {acl.map((access) => access.email).join(", ")}
        </div>
      ) : (
        showIconOnHover && (
          <div className="invisible group-hover:visible">
            <Link className="h-4 w-4 text-muted-foreground" />
          </div>
        )
      )}
    </div>
  );
}