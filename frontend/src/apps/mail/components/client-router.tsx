'use client'

import { useClientRouter } from "@/app/client-provider";
import { HomeRoute } from "@/components/routes/home";
import { InboxRoute } from "@/components/routes/inbox";
import { EmailDetailRoute } from "@/components/routes/email-detail";

export function ClientRouter() {
  const { currentRoute } = useClientRouter();
  
  // Simple route matching
  if (currentRoute === '/') {
    return <HomeRoute />;
  }
  
  if (currentRoute === '/inbox') {
    return <InboxRoute />;
  }
  
  // Match email detail routes
  if (currentRoute.match(/^\/inbox\/[a-zA-Z0-9-]+$/)) {
    return <EmailDetailRoute />;
  }
  
  // 404 fallback
  return <div className="p-4">Page not found</div>;
}
