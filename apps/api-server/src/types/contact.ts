export interface Contact {
    id: string;
    firstName: string;
    lastName: string;
    email: string[];
    phone: string[];
    company?: string;
    jobTitle?: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      zipCode?: string;
      country?: string;
    }[];
    birthday?: string;
    notes?: string;
    avatar?: string;
    labels?: string[];
    eigenId?: string;
  }