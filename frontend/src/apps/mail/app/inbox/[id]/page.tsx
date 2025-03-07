import { getEmailById } from "@/lib/mock-data";
import { notFound } from "next/navigation";
import { EmailDetail } from "@/components/mail/email-detail";

export default async function EmailPage({ params }: { params: Promise<{ id: string }> }) {
  const {id} = await params;
  const email = await getEmailById(id);
  
  if (!email) {
    notFound();
  }

  return <EmailDetail email={email} />;
}
