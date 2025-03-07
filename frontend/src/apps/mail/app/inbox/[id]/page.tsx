import { getEmailById } from "@/lib/mock-data";
import { notFound } from "next/navigation";
import { EmailDetail } from "@/components/mail/email-detail";

export default function EmailPage({ params }: { params: { id: string } }) {
  const email = getEmailById(params.id);
  
  if (!email) {
    notFound();
  }

  return <EmailDetail email={email} />;
}
