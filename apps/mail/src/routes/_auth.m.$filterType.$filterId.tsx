import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { EmailDataTable } from "../components/mail/inbox/email-data-table.tsx";
import { emailColumns } from "../components/mail/inbox/email-columns.tsx";
import { mockEmails, getEmailById } from "../lib/mock-data.ts";
import { EmailDetail } from "../components/mail/email-detail.tsx";
import { useMediaQuery } from "../hooks/use-media-query";
import { useEffect, useState } from "react";

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

// Define search params type
export interface MailSearchParams {
  mailId?: string;
}

export const Route = createFileRoute('/_auth/m/$filterType/$filterId')({
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
  const isTablet = useMediaQuery('(max-width: 1024px) and (min-width: 769px)');
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [loading, setLoading] = useState(false);
  
  // Load email when mailId changes
  useEffect(() => {
    async function loadEmail() {
      if (mailId) {
        setLoading(true);
        try {
          const email = await getEmailById(mailId);
          setSelectedEmail(email);
        } catch (error) {
          console.error('Failed to load email:', error);
          // Navigate back to list if email not found
          navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: {},
          });
        } finally {
          setLoading(false);
        }
      } else {
        setSelectedEmail(null);
      }
    }
    
    loadEmail();
  }, [mailId, filterType, filterId, navigate]);
  
  // Filter emails based on filter type and ID
  let filteredEmails = mockEmails;
  
  if (filterType === 'label') {
    // Filter emails by label
    filteredEmails = mockEmails.filter(email => 
      email.labels?.some((label: string) => label.toLowerCase() === filterId.toLowerCase())
    );
  } else if (filterType === 'filter') {
    // Handle predefined filters
    if (filterId === 'starred') {
      filteredEmails = mockEmails.filter(email => email.starred);
    }
    // Additional filters can be added here
  }
  
  // Handle row click to show email details
  const handleRowClick = (emailId: string) => {
    navigate({
      to: Route.fullPath,
      params: { filterType, filterId },
      search: (prev) => ({ ...prev, mailId: emailId }),
    });
  };
  
  // Handle back navigation (mainly for mobile)
  const handleBackToList = () => {
    navigate({
      to: Route.fullPath,
      params: { filterType, filterId },
      search: {},
    });
  };
  
  // Show loading status
  if (loading && mailId) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Loading email...</p>
      </div>
    );
  }
  
  // On mobile: If a mailId is provided, show only the email detail view
  if (isMobile && mailId && selectedEmail) {
    return (
      <div className="flex flex-col h-full">
        <EmailDetail 
          email={selectedEmail}
          isMobile={true}
          onBackClick={handleBackToList}
        />
      </div>
    );
  } else if (isMobile && mailId) {
    // On mobile but email not loaded yet
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Loading email...</p>
      </div>
    );
  }
  
  // On mobile: Show full-width email list
  if (isMobile) {
    return (
      <div className="flex-1 h-full w-full">
        <EmailDataTable
          columns={emailColumns}
          data={filteredEmails}
          onRowClick={handleRowClick}
          activeRowId={mailId}
        />
      </div>
    );
  }
  
  // Calculate list width based on device type
  const getListWidthClass = () => {
    if (isTablet) {
      return "w-[320px]"; // Narrower on tablet for more space for content
    } else {
      return "w-[400px]"; // Default on desktop
    }
  };
  
  // Desktop/Tablet: Two-column layout (sidebar already handled in _auth.tsx)
  return (
    <div className="flex h-full w-full">
      {/* Email list column */}
      <div className={`
        flex flex-col ${getListWidthClass()} border-r h-full overflow-hidden
      `}>
        <EmailDataTable
          columns={emailColumns}
          data={filteredEmails}
          onRowClick={handleRowClick}
          activeRowId={mailId}
        />
      </div>
      
      {/* Email details column */}
      <div className="flex-1 h-full overflow-hidden">
        {mailId && selectedEmail ? (
          <div className="h-full">
            <EmailDetail 
              email={selectedEmail} 
              className="border-none h-full"
            />
          </div>
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <p className="text-muted-foreground">Select an email to view details</p>
          </div>
        )}
      </div>
    </div>
  );
}
