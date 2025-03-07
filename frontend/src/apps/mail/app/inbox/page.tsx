import { mockEmails } from "@/lib/mock-data";
import { EmailDataTable } from "@/components/mail/inbox/email-data-table";
import { emailColumns } from "@/components/mail/inbox/email-columns";

export default function InboxPage() {
  return (
    <div className="h-full p-4">
      <EmailDataTable columns={emailColumns} data={mockEmails} />
    </div>
  );
}
