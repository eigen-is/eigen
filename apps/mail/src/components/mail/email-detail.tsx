import {Archive, ArrowLeft, Forward, MoreHorizontal, Paperclip, Reply, ReplyAll, Trash2} from "lucide-react";
import {cn} from "@workspace/ui/lib/utils";
import {Button} from "@workspace/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {Email} from "@/types/email";
import {format} from "date-fns";

interface EmailDetailProps {
  email: Email;
  isMobile?: boolean;
  className?: string;
  onBackClick?: () => void;
}

export function EmailDetail({ email, isMobile, className, onBackClick, ...props }: EmailDetailProps) {
  if (!email) {
    console.log('No email provided to EmailDetail component');
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Email data not available
      </div>
    );
  }
  
  console.log('Rendering EmailDetail with email:', email);
  
  // Handle different from formats from the API
  let fromName = 'Unknown';
  let fromEmail = 'unknown@example.com';
  
  // Extract from information
  if (typeof email.from === 'object') {
    if (email.from.name) {
      fromName = email.from.name;
      fromEmail = email.from.email || 'unknown@example.com';
    } else if (email.from.value && Array.isArray(email.from.value) && email.from.value.length > 0) {
      // Handle the structure from the screenshot
      const firstFrom = email.from.value[0];
      fromName = firstFrom.name || firstFrom.address || 'Unknown';
      fromEmail = firstFrom.address || 'unknown@example.com';
    } else if (email.from.email) {
      fromName = email.from.name || email.from.email;
      fromEmail = email.from.email;
    }
  } else if (typeof email.from === 'string') {
    fromName = email.from;
    fromEmail = email.from;
  }
  
  // Format date
  let formattedDate = 'Unknown date';
  try {
    if (email.date) {
      const dateValue = new Date(email.date);
      formattedDate = format(dateValue, "MMMM d, yyyy 'at' h:mm a");
    }
  } catch (error) {
    console.error('Error formatting date:', error);
  }
  
  // Get email content
  const emailContent = email.html || email.text || email.preview || '';
  
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
              <Button variant="ghost" size="icon" className="h-8 w-8" title="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>Mark as unread</DropdownMenuItem>
              <DropdownMenuItem>Move to folder</DropdownMenuItem>
              <DropdownMenuItem>Add label</DropdownMenuItem>
              <DropdownMenuItem>Print</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      
      {/* Email content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl mx-auto">
          {/* Email header */}
          <div className="mb-6">
            <h1 className="text-xl font-semibold mb-4">
              {email.subject ? String(email.subject) : '(No subject)'}
            </h1>
            
            <div className="flex items-start">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium mr-3 mt-1">
                {fromName.charAt(0).toUpperCase()}
              </div>
              
              <div className="flex-1 min-w-0">
                <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
                  <div>
                    <p className="font-medium">{fromName}</p>
                    <p className="text-sm text-muted-foreground">{fromEmail}</p>
                  </div>
                  <p className="text-sm text-muted-foreground whitespace-nowrap">
                    {formattedDate}
                  </p>
                </div>
              </div>
            </div>
          </div>
          
          {/* Email body */}
          <div className="prose prose-sm max-w-none">
            {email.html ? (
              <div dangerouslySetInnerHTML={{ __html: email.html }} />
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>
                {emailContent}
              </div>
            )}
          </div>
          
          {/* Attachments */}
          {email.attachments && email.attachments.length > 0 && (
            <div className="mt-6 pt-6 border-t">
              <h3 className="font-medium mb-3 flex items-center gap-2">
                <Paperclip className="h-4 w-4" />
                Attachments ({email.attachments.length})
              </h3>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {email.attachments.map((attachment: any, index: number) => (
                  <div 
                    key={index}
                    className="flex items-center p-3 border rounded-md hover:bg-muted/50 cursor-pointer"
                  >
                    <Paperclip className="h-4 w-4 mr-2 text-muted-foreground" />
                    <span className="text-sm truncate">
                      {attachment.filename || `Attachment ${index + 1}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
