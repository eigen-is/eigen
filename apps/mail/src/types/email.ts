// Define the Email type for the mail app
export interface Email {
  id: string;
  read: boolean;
  isRead?: boolean; // API uses isRead, our UI uses read
  seen?: boolean;   // For UI display of read/unread status
  starred: boolean;
  flagged?: boolean; // For UI display of starred/flagged status
  from: {
    name: string;
    email: string;
    text?: string;  // Display text for the sender
    value?: Array<{
      name?: string;
      address?: string;
    }>;
  } | string;
  to?: {
    name: string;
    email: string;
    text?: string;  // Display text for the recipient
    value?: Array<{
      name?: string;
      address?: string;
    }>;
  } | string;
  subject: string;
  preview: string;
  content?: string;
  text?: string;    // Plain text content from API
  html?: string;    // HTML content from API
  hasAttachment: boolean;
  attachments?: Array<{
    filename: string;
    contentType?: string;
    size?: number;
    content?: string;
  }>;
  date: string;
  important?: boolean;
  flags?: string[];
}
