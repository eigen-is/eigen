'use client'

import { mockEmails } from "@/lib/mock-data";
import { EmailDataTable } from "@/components/mail/inbox/email-data-table";
import { emailColumns } from "@/components/mail/inbox/email-columns";
import { useClientRouter } from "@/app/client-provider";

export function InboxRoute() {
  const { navigate } = useClientRouter();
  
  // Handle row clicks to navigate to email detail
  const handleRowClick = (emailId: string) => {
    navigate(`/inbox/${emailId}`);
  };
  
  return (
    <div className="h-full p-4">
      <EmailDataTable 
        columns={emailColumns} 
        data={mockEmails} 
        onRowClick={(row) => handleRowClick(row.id)} 
      />
    </div>
  );
}
