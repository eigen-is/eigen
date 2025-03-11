import {createFileRoute, useNavigate} from "@tanstack/react-router";
import {EmailDataTable} from "@/components/mail/inbox/email-data-table.tsx";
import {emailColumns} from "@/components/mail/inbox/email-columns.tsx";
import {mockEmails} from "@/lib/mock-data.ts";

export const Route = createFileRoute('/_auth/inbox')({
  component: RouteComponent,
})


function RouteComponent() {
  const navigate = useNavigate();
  const handleRowClick = async (emailId: string) => {
    // navigate(`/inbox/${emailId}`);
    await navigate({to: `/inbox/${emailId}`});
  };

  return <div className="h-full p-4">
    <EmailDataTable
        columns={emailColumns}
        data={mockEmails}
        onRowClick={(row) => handleRowClick(row.id)}
    />
  </div>
}
