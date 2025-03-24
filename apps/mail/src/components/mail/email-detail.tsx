import {Archive, ArrowLeft, Forward, MoreHorizontal, Paperclip, Reply, ReplyAll, Trash2} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {Button} from "@workspace/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";

// Define the Email interface locally to avoid import issues
interface Email {
  id: string;
  read: boolean;
  starred: boolean;
  from: {
    name: string;
    email: string;
  };
  subject: string;
  preview: string;
  hasAttachment: boolean;
  date: string;
  important?: boolean;
  labels?: string[];
}

interface EmailDetailProps {
  email: Email;
  isMobile?: boolean;
  className?: string;
  onBackClick?: () => void;
}

export function EmailDetail({ email, isMobile, className, onBackClick, ...props }: EmailDetailProps) {
  if (!email) return null;
  
  return (
    <div className={cn("flex flex-col h-full bg-white", className)} {...props}>
      {/* Action toolbar */}
      <div className="h-12 flex items-center justify-between px-4 border-b">
        <div className="flex items-center gap-1">
          {/* Mobile back button when needed */}
          {isMobile && onBackClick && (
            <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={onBackClick} title="Back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          
          {/* Left side icons */}
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Reply">
            <Reply className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Reply All">
            <ReplyAll className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Forward">
            <Forward className="h-4 w-4" />
          </Button>
        </div>
        
        <div className="flex items-center gap-1">
          {/* Right side icons */}
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Archive">
            <Archive className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Delete">
            <Trash2 className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="More Options">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>Mark as unread</DropdownMenuItem>
              <DropdownMenuItem>Mark as spam</DropdownMenuItem>
              <DropdownMenuItem>Print</DropdownMenuItem>
              <DropdownMenuItem>Add to favorites</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      
      <div className="p-4 flex-1 overflow-auto">
        {/* Email header info */}
        <div className="space-y-4 mb-6">
          <div>
            <h1 className="text-xl font-medium text-gray-900 mb-1">{email.subject}</h1>
            
            <div className="flex items-center mt-4">
              {/* Profile image/avatar placeholder */}
              <div className="h-10 w-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 font-medium">
                {email.from.name[0]}
              </div>
              
              <div className="ml-3 flex-1">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{email.from.name}</p>
                    <p className="text-xs text-gray-500">{email.from.email}</p>
                  </div>
                  <p className="text-xs text-gray-500 mt-1 sm:mt-0">{email.date}</p>
                </div>
              </div>
            </div>
          </div>
          
          {/* Attachments (if any) */}
          {email.hasAttachment && (
            <div className="bg-gray-50 p-3 rounded-md">
              <div className="flex items-center space-x-2 mb-2 text-sm text-gray-600">
                <Paperclip className="h-4 w-4" />
                <span>Attachments</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {/* Mock attachment placeholders */}
                <div className="border border-gray-200 rounded p-2 flex items-center bg-white">
                  <div className="w-8 h-8 bg-blue-100 rounded flex items-center justify-center text-blue-600 mr-2">
                    PDF
                  </div>
                  <div className="text-xs truncate">
                    <p className="font-medium">Document.pdf</p>
                    <p className="text-gray-500">245 KB</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        
        {/* Email content */}
        <div className="prose max-w-none text-sm text-gray-700">
          <p>Hello,</p>
          <p>{email.preview}</p>
          <p className="mt-4">Best regards,<br />{email.from.name}</p>
        </div>
      </div>
    </div>
  );
}
