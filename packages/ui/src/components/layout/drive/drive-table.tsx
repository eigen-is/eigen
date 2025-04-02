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
  return (
    <div className="flex-1 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[50%]">Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Modified</TableHead>
            <TableHead className="w-[50px]"></TableHead>
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
              <TableCell>Folder</TableCell>
              <TableCell>-</TableCell>
              <TableCell>-</TableCell>
            </TableRow>
          )}

          {items.map((item) => (
            <TableRow
              key={item.id}
              className={cn(
                "cursor-pointer hover:bg-muted/50",
                activeItemId === item.id && "bg-muted"
              )}
              onClick={() => onItemClick?.(item)}
            >
              <TableCell className="font-medium">
                <div className="flex items-center">
                  {getFileIcon && getFileIcon(
                    item.mimeType,
                    item.type,
                    {
                      className: "h-4 w-4 mr-2 text-muted-foreground",
                      ...(item.type === 'folder' ? {
                        className: "h-4 w-4 mr-2 text-app",
                        fill: "var(--app-drive-light-color)"
                      } : {})
                    }
                  )}
                  <span className="truncate">{item.name}</span>
                </div>
              </TableCell>
              <TableCell>
                {item.type === 'folder' ? 'Folder' :
                  item.type === 'eigendocs' ? 'EigenDocs' : 'File'}
              </TableCell>
              <TableCell>
                {item.updatedAt ?
                  formatDistanceToNow(new Date(item.updatedAt instanceof Date ? item.updatedAt : new Date(item.updatedAt)), { addSuffix: true }) :
                  'Unknown'}
              </TableCell>
              <TableCell>
                {/* Context menu removed as requested */}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
