"use client"
import { UserPublicItem } from "../user-item"
import type { DriveACL, DrivePath } from "@apps/api-server/types/drive"
import { cn } from "@workspace/ui/lib/utils"
import { useMemo } from "react"
import { usePublicUser} from "@workspace/lib/public"   

export interface DriveAccessListProps {
  acl: DriveACL[] | null
  path: DrivePath
  className?: string
}

export function DriveAccessList({
  acl,
  path,
  className,
}: DriveAccessListProps) {
  const owner = usePublicUser(path.ownerId);

  // Combine owner and ACL list, ensuring owner is first and not duplicated
  const accessList = useMemo(() => {
    if (!owner.data) return [];
    
    const ownerAccess = {
      email: owner.data.email || '',
      read: true,
      write: true,
      public: false,
    }

    const accessList = [ownerAccess];
  
    if (acl && acl.length > 0) {
      // Add only non-owner users from ACL
      acl.forEach((access) => {
        if (access.email !== owner.data?.email) {
          accessList.push({
            email: access.email,
            read: access.read,
            write: access.write,
            public: access.public,
          })
        }
      })
    }

    return accessList;
    }, [acl, owner]);

  return (
    <div className={cn("space-y-4", className)}>
      <h3 className="text-base font-medium">People with access</h3>
      
      <div className="space-y-2">
        {accessList.map((access) => (
          <UserPublicItem          
            key={access.email}
            email={access.email} // Using userId as email for now
            label={access.email === path.ownerId ? "Owner" : (
              <AccessLabel access={access} />
            )}
          />
        ))}
      </div>

      <div className="pt-2 border-t mt-4">
        <h4 className="text-sm font-medium mb-2">General access</h4>
        <div className="flex items-center">
          <div className="p-1 border rounded-md mr-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <path d="M7 12h10" />
              <path d="M12 7v10" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium">Restricted</p>
            <p className="text-xs text-gray-500">Only people with access can open with the link</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// Component to display the appropriate access label
function AccessLabel({ access }: { access: DriveACL }) {
  if (access.write) {
    return <span>Editor</span>
  }
  if (access.read) {
    return <span>Viewer</span>
  }
  return null
}
