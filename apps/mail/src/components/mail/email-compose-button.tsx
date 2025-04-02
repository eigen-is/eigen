import { Button } from "@workspace/ui/components/button";
import { MailPlus } from "lucide-react";
import { useParams } from "@tanstack/react-router";

interface EmailComposeButtonProps {
  condensed: boolean;
}

export function EmailComposeButton({ condensed }: EmailComposeButtonProps) {
  // Get the current route parameters using useParams
  const { filterType, filterId } = useParams({
    from: '/_auth/$filterType/$filterId',
  });
  
  const handleComposeClick = () => {
    // You can use filterType and filterId here for context-aware compose functionality
    console.log("Composing email with context:", { filterType, filterId });
    
    // Add your compose email logic here
    // For example:
    // if (filterType === "label") { ... }
    // if (filterType === "mailbox" && filterId === "drafts") { ... }
  };
  
  return (
    <Button 
      variant="default" 
      size={condensed ? "icon" : "default"}
      className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
      onClick={handleComposeClick}
    >
      <MailPlus className="h-4 w-4" />
      {!condensed && <span>Compose</span>}
    </Button>
  );
}
