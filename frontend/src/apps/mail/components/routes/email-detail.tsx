'use client'

import { useEffect, useState } from "react";
import { getEmailById } from "@/lib/mock-data";
import { EmailDetail } from "@/components/mail/email-detail";
import { useClientRouter } from "@/app/client-provider";

export function EmailDetailRoute() {
  const { currentRoute } = useClientRouter();
  const [email, setEmail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const fetchEmail = async () => {
      setLoading(true);
      // Extract email ID from the route
      const emailId = currentRoute.split('/').pop();
      if (emailId) {
        const data = await getEmailById(emailId);
        setEmail(data);
      }
      setLoading(false);
    };
    
    fetchEmail();
  }, [currentRoute]);
  
  if (loading) {
    return <div className="p-4">Loading...</div>;
  }
  
  if (!email) {
    return <div className="p-4">Email not found</div>;
  }
  
  return <EmailDetail email={email} />;
}
