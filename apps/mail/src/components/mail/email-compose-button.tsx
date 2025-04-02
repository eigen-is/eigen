import { Button } from "@workspace/ui/components/button";
import { MailPlus } from "lucide-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCreateDraft } from "@workspace/lib/mail";

// Import route to get correct path information
import { Route as FilterRoute } from '../../routes/_auth.$filterType.$filterId';

interface EmailComposeButtonProps {
  condensed: boolean;
}

export function EmailComposeButton({ condensed }: EmailComposeButtonProps) {
  // Get the current route parameters using useParams
  const { filterType, filterId } = useParams({
    from: '/_auth/$filterType/$filterId',
  });
  
  const navigate = useNavigate();
  const createDraft = useCreateDraft();
  
  const handleComposeClick = async () => {
    try {
      // Create an empty draft email
      const draftId = await createDraft.mutateAsync({});
      
      // Navigate to the current filter with the new draft ID as mailId parameter
      if (draftId) {
        navigate({
          to: FilterRoute.fullPath,
          params: { filterType, filterId },
          search: { mailId: draftId },
        });
      }
    } catch (error) {
      console.error("Failed to create draft email:", error);
    }
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
