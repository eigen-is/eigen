export type Address = {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
};

export type Contact = {
    id: string;
    firstName: string;
    lastName: string;
    email: string[];
    phone: string[];
    company?: string;
    jobTitle?: string;
    address?: Address[];
    birthday?: string;
    notes?: string;
    avatar?: string;
    labels?: string[];
    eigenId?: string;
};
