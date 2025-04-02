import React, { useMemo } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Button } from "@workspace/ui/components/button";
import { cn } from "@workspace/ui/lib/utils";
import { ChevronLeft } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// Define the interface for a drive path item
export interface DrivePathItem {
  id: string;
  name: string;
  type: string;
  parentId?: string;
  ownerId: string;
  labels: string[];
  mimeType: string;
  size: number;
  thumbnail: string;
  acl: any;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// Props for the DriveTable component
export interface DriveTableProps {
  items: DrivePathItem[];
  currentPath?: DrivePathItem | null;
  activeItemId?: string;
  onItemClick?: (item: DrivePathItem) => void;
  getFileIcon?: (mimeType: string, type: string, props?: any) => React.ReactNode;
}

export function DriveTable({
  items = [],
  currentPath,
  activeItemId,
  onItemClick,
  getFileIcon
}: DriveTableProps) {

  // Sort items: folders first, then sort alphabetically by name
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      // First sort by type (folders first)
      if (a.type === 'folder' && b.type !== 'folder') {
        return -1;
      }
      if (a.type !== 'folder' && b.type === 'folder') {
        return 1;
      }
      
      // Then sort alphabetically by name
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [items]);

  return (
    <div className="flex-1 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[75%]">Name</TableHead>
            <TableHead className="w-[10%] hidden sm:table-cell">Type</TableHead>
            <TableHead className="w-[15%] hidden sm:table-cell">Modified</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* Parent folder navigation row */}
          {currentPath?.parentId && (
            <TableRow
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => onItemClick?.({
                id: currentPath.parentId || '',
                name: '..',
                type: 'folder',
                parentId: undefined,
                ownerId: '',
                labels: [],
                mimeType: 'folder',
                size: 0,
                thumbnail: '',
                acl: null,
                createdAt: new Date(),
                updatedAt: new Date()
              })}
            >
              <TableCell className="font-medium">
                <div className="flex items-center">
                  <ChevronLeft className="h-4 w-4 mr-2 text-muted-foreground" />
                  <span>..</span>
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">Folder</TableCell>
              <TableCell className="hidden sm:table-cell">-</TableCell>
            </TableRow>
          )}

          {sortedItems.map((item) => (
            <TableRow
              key={item.id}
              className={cn(
                "cursor-pointer hover:bg-muted/50",
                activeItemId === item.id && "bg-muted"
              )}
              onClick={() => onItemClick?.(item)}
            >
              <TableCell className="font-medium">
                <div className="flex items-center max-w-full overflow-hidden">
                  {getFileIcon && getFileIcon(
                    item.mimeType,
                    item.type,
                    {
                      className: "h-4 w-4 mr-2 text-muted-foreground flex-shrink-0",
                      ...(item.type === 'folder' ? {
                        className: "h-4 w-4 mr-2 text-app flex-shrink-0",
                        fill: "var(--app-drive-light-color)"
                      } : {})
                    }
                  )}
                  <span className="truncate max-w-[calc(100%-1.5rem)]">{item.name}</span>
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {item.type === 'folder' ? 'Folder' :
                  item.type === 'eigendocs' ? 'EigenDocs' : 'File'}
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {item.updatedAt ?
                  formatDistanceToNow(new Date(item.updatedAt instanceof Date ? item.updatedAt : new Date(item.updatedAt)), { addSuffix: true }) :
                  'Unknown'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
