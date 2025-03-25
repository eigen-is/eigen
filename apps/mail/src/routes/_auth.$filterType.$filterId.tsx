import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {EmailDataTable} from "@/components/mail/inbox/email-data-table";
import {EmailDetail} from "@/components/mail/email-detail";
import {useMediaQuery} from "@/hooks/use-media-query";
import {useEmail} from "@/hooks/use-emails";
import {useMailboxExists} from "@/hooks/use-mailboxes";
import {Loader2} from "lucide-react";

export interface MailSearchParams {
  mailId?: string;
}

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
  component: MailRoute,
  validateSearch: (search: Record<string, unknown>) => {
    const mailId = typeof search.mailId === 'string' ? search.mailId : undefined;
    return { mailId } as MailSearchParams;
  },
});

function MailRoute() {
  const { filterType, filterId } = Route.useParams();
  const { mailId } = Route.useSearch();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isTablet = useMediaQuery('(min-width: 769px) and (max-width: 1024px)');
  const isDesktop = useMediaQuery('(min-width: 1025px)');
  
  // Determine the actual mailbox path based on the filter params
  const getMailboxPath = () => {
    if (filterType === 'box') {
      // Convert URL-friendly format back to mailbox format
      // e.g., 'inbox' -> 'INBOX', 'sent-items' -> 'Sent.Items'
      const mailboxMap: Record<string, string> = {
        'inbox': 'INBOX',
        'sent': 'Sent',
        'drafts': 'Drafts',
        'archive': 'Archive',
        'spam': 'Spam',
        'trash': 'Trash'
      };
      
      // Check if it's a predefined mailbox
      if (mailboxMap[filterId]) {
        return mailboxMap[filterId];
      }
      
      // Handle custom mailbox paths (convert dashes back to dots)
      return filterId.replace(/-/g, '.');
    }
    
    // Default to INBOX if not a box filter type
    return 'INBOX';
  };
  
  const requestedMailboxPath = getMailboxPath();
  
  // Check if the mailbox exists (this will use the case-insensitive check)
  const { data: mailboxExistsData, isLoading: checkingMailbox } = useMailboxExists(requestedMailboxPath);
  const mailboxExists = mailboxExistsData?.exists || false;
  
  // Use the correct case-sensitive mailbox path if it exists
  const mailboxPath = mailboxExistsData?.path || requestedMailboxPath;
  
  // Fetch email details if mailId is provided
  const { 
    data: selectedEmail, 
    isLoading: emailLoading, 
    error: emailError 
  } = useEmail(mailId || '');

  // Debug the selected email
  console.log(`Route: mailId=${mailId}, selectedEmail:`, selectedEmail);

  // Handle row click to navigate to email detail view
  const handleRowClick = (emailId: string) => {
    // Use the correct syntax for TanStack Router v5
    navigate({
      to: Route.fullPath,
      params: { filterType, filterId },
      search: { mailId: emailId } as any,
    });
  };
  
  // Handle back button click to return to inbox view
  const handleBackClick = () => {
    // Use the correct syntax for TanStack Router v5
    navigate({
      to: Route.fullPath,
      params: { filterType, filterId },
      search: { mailId: undefined } as any,
    });
  };
  
  // Determine layout based on screen size and whether an email is selected
  const showEmailList = !mailId || !isMobile;
  const showEmailDetail = !!mailId;
  
  // Show loading state while checking if mailbox exists
  if (checkingMailbox) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  
  // If mailbox doesn't exist, show error message
  if (filterType === 'box' && !mailboxExists) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">Mailbox Not Found</h2>
          <p className="text-muted-foreground mb-4">
            The mailbox "{requestedMailboxPath}" does not exist or is not accessible.
          </p>
          <button
            onClick={() => navigate({ 
              to: '/_auth/box/inbox' as any,
              search: {} as any
            })}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md"
          >
            Go to Inbox
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="flex h-full w-full">
      {/* Email list column - Middle column */}
      {showEmailList && (
        <div
          className={cn(
            "h-full border-r",
            // On mobile: full width when no email selected, hidden when email selected
            isMobile && !showEmailDetail ? "w-full" : isMobile && showEmailDetail ? "hidden" : "",
            // On tablet: 40% width when email selected
            isTablet && showEmailDetail ? "w-[40%]" : "",
            // On desktop: fixed width of 350px when email selected (like contacts app)
            isDesktop && showEmailDetail ? "w-[350px]" : "",
            // When no email selected and not mobile: full width
            !showEmailDetail && !isMobile ? "w-full" : ""
          )}
        >
          <EmailDataTable
            mailboxPath={mailboxPath}
            onRowClick={handleRowClick}
            activeRowId={mailId}
          />
        </div>
      )}
      
      {/* Email detail column - Right column */}
      {showEmailDetail && (
        <div
          className={cn(
            "h-full overflow-y-auto",
            // On mobile: full width when email selected
            isMobile ? "w-full" : "",
            // On tablet and desktop: remaining width when email selected
            !isMobile ? "flex-1" : ""
          )}
        >
          {emailLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : emailError ? (
            <div className="flex h-full items-center justify-center text-red-500">
              Error loading email. Please try again.
            </div>
          ) : selectedEmail ? (
            <EmailDetail
              email={selectedEmail}
              isMobile={isMobile}
              onBackClick={isMobile ? handleBackClick : undefined}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Select an email to view
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Helper function to conditionally join class names
function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
