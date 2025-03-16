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
  labels: string[];
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

// Mock data for labels
export const mockLabels: Label[] = [
  { id: '1', name: 'Family', color: '#f87171' },
  { id: '2', name: 'Friends', color: '#60a5fa' },
  { id: '3', name: 'Work', color: '#4ade80' },
  { id: '4', name: 'Important', color: '#facc15' }
];

// Generate a placeholder avatar URL based on the contact's name
const getAvatarUrl = (firstName: string, lastName: string) => {
  return `https://ui-avatars.com/api/?name=${firstName}+${lastName}&background=random`;
};

// Mock data for contacts
export const mockContacts: Contact[] = [
  {
    id: '1',
    firstName: 'Alice',
    lastName: 'Johnson',
    email: ['alice.johnson@example.com'],
    phone: ['+31 6 12 34 56 78'],
    company: 'Tech Solutions',
    jobTitle: 'Software Developer',
    address: [
      {
        street: 'Keizersgracht 123',
        city: 'Amsterdam',
        zipCode: '1015 CW',
        country: 'Netherlands'
      }
    ],
    birthday: '1990-05-15',
    avatar: getAvatarUrl('Alice', 'Johnson'),
    labels: ['1', '3']
  },
  {
    id: '2',
    firstName: 'Bob',
    lastName: 'Smith',
    email: ['bob.smith@example.com', 'bob.personal@example.com'],
    phone: ['+31 6 23 45 67 89', '+31 20 123 4567'],
    company: 'Marketing Pro',
    jobTitle: 'Marketing Manager',
    birthday: '1985-08-20',
    avatar: getAvatarUrl('Bob', 'Smith'),
    labels: ['2']
  },
  {
    id: '3',
    firstName: 'Charlie',
    lastName: 'Brown',
    email: ['charlie.brown@example.com'],
    phone: ['+31 6 34 56 78 90'],
    company: 'Design Studio',
    jobTitle: 'UX Designer',
    address: [
      {
        street: 'Prinsengracht 456',
        city: 'Amsterdam',
        zipCode: '1016 HK',
        country: 'Netherlands'
      }
    ],
    avatar: getAvatarUrl('Charlie', 'Brown'),
    labels: ['2', '3']
  },
  {
    id: '4',
    firstName: 'Diana',
    lastName: 'Miller',
    email: ['diana.miller@example.com'],
    phone: ['+31 6 45 67 89 01'],
    company: 'Finance Group',
    jobTitle: 'Financial Analyst',
    avatar: getAvatarUrl('Diana', 'Miller'),
    labels: ['3', '4']
  },
  {
    id: '5',
    firstName: 'Edward',
    lastName: 'Wilson',
    email: ['edward.wilson@example.com'],
    phone: ['+31 6 56 78 90 12'],
    address: [
      {
        street: 'Herengracht 789',
        city: 'Amsterdam',
        zipCode: '1017 BT',
        country: 'Netherlands'
      }
    ],
    avatar: getAvatarUrl('Edward', 'Wilson'),
    labels: ['1']
  },
  {
    id: '6',
    firstName: 'Fiona',
    lastName: 'Garcia',
    email: ['fiona.garcia@example.com'],
    phone: ['+31 6 67 89 01 23'],
    company: 'Health Center',
    jobTitle: 'Physician',
    birthday: '1983-03-10',
    avatar: getAvatarUrl('Fiona', 'Garcia'),
    labels: ['4']
  },
  {
    id: '7',
    firstName: 'George',
    lastName: 'Martinez',
    email: ['george.martinez@example.com'],
    phone: ['+31 6 78 90 12 34'],
    company: 'Law Firm',
    jobTitle: 'Attorney',
    address: [
      {
        street: 'Singel 234',
        city: 'Amsterdam',
        zipCode: '1013 AE',
        country: 'Netherlands'
      }
    ],
    avatar: getAvatarUrl('George', 'Martinez'),
    labels: ['3']
  },
  {
    id: '8',
    firstName: 'Hannah',
    lastName: 'Lee',
    email: ['hannah.lee@example.com'],
    phone: ['+31 6 89 01 23 45'],
    company: 'Education Institute',
    jobTitle: 'Professor',
    birthday: '1975-12-05',
    avatar: getAvatarUrl('Hannah', 'Lee'),
    labels: ['2', '3']
  },
  {
    id: '9',
    firstName: 'Ian',
    lastName: 'Clark',
    email: ['ian.clark@example.com'],
    phone: ['+31 6 90 12 34 56'],
    avatar: getAvatarUrl('Ian', 'Clark'),
    labels: []
  },
  {
    id: '10',
    firstName: 'Jessica',
    lastName: 'Walker',
    email: ['jessica.walker@example.com'],
    phone: ['+31 6 01 23 45 67'],
    company: 'Creative Agency',
    jobTitle: 'Art Director',
    address: [
      {
        street: 'Leidsegracht 567',
        city: 'Amsterdam',
        zipCode: '1016 GX',
        country: 'Netherlands'
      }
    ],
    birthday: '1988-07-22',
    avatar: getAvatarUrl('Jessica', 'Walker'),
    labels: ['2', '4']
  },
  {
    id: '11',
    firstName: 'Kevin',
    lastName: 'Anderson',
    email: ['kevin.anderson@example.com'],
    phone: ['+31 6 12 34 56 78'],
    company: 'Construction Co.',
    jobTitle: 'Project Manager',
    avatar: getAvatarUrl('Kevin', 'Anderson'),
    labels: ['3']
  },
  {
    id: '12',
    firstName: 'Linda',
    lastName: 'Taylor',
    email: ['linda.taylor@example.com'],
    phone: ['+31 6 23 45 67 89'],
    company: 'Publishing House',
    jobTitle: 'Editor',
    birthday: '1980-09-18',
    address: [
      {
        street: 'Reguliersgracht 890',
        city: 'Amsterdam',
        zipCode: '1017 LT',
        country: 'Netherlands'
      }
    ],
    avatar: getAvatarUrl('Linda', 'Taylor'),
    labels: ['1', '4']
  },
  {
    id: '13',
    firstName: 'Michael',
    lastName: 'Thomas',
    email: ['michael.thomas@example.com'],
    phone: ['+31 6 34 56 78 90'],
    company: 'Sports Inc.',
    jobTitle: 'Coach',
    avatar: getAvatarUrl('Michael', 'Thomas'),
    labels: ['2']
  },
  {
    id: '14',
    firstName: 'Natalie',
    lastName: 'Robinson',
    email: ['natalie.robinson@example.com'],
    phone: ['+31 6 45 67 89 01'],
    birthday: '1992-04-30',
    avatar: getAvatarUrl('Natalie', 'Robinson'),
    labels: []
  },
  {
    id: '15',
    firstName: 'Oscar',
    lastName: 'White',
    email: ['oscar.white@example.com'],
    phone: ['+31 6 56 78 90 12'],
    company: 'Catering Services',
    jobTitle: 'Chef',
    address: [
      {
        street: 'Brouwersgracht 123',
        city: 'Amsterdam',
        zipCode: '1015 GG',
        country: 'Netherlands'
      }
    ],
    avatar: getAvatarUrl('Oscar', 'White'),
    labels: ['3']
  }
];

// Helper functions
export const getContactsByLabel = (labelId: string) => {
  return mockContacts.filter(contact => contact.labels.includes(labelId));
};

export const getLabelById = (labelId: string) => {
  return mockLabels.find(label => label.id === labelId);
};

export const getContactById = (contactId: string) => {
  return mockContacts.find(contact => contact.id === contactId);
};

// Group contacts by first letter of last name
export const groupContactsByLetter = (sortBy: 'firstName' | 'lastName' = 'firstName') => {
  const grouped = mockContacts.reduce<Record<string, Contact[]>>((acc, contact) => {
    const sortField = sortBy === 'firstName' ? contact.firstName : contact.lastName;
    const firstLetter = sortField.charAt(0).toUpperCase();
    
    if (!acc[firstLetter]) {
      acc[firstLetter] = [];
    }
    
    acc[firstLetter].push(contact);
    return acc;
  }, {});
  
  // Sort contacts within each letter group
  Object.keys(grouped).forEach(letter => {
    grouped[letter].sort((a, b) => {
      const fieldA = sortBy === 'firstName' ? a.firstName : a.lastName;
      const fieldB = sortBy === 'firstName' ? b.firstName : b.lastName;
      return fieldA.localeCompare(fieldB);
    });
  });
  
  // Return a sorted array of letter-contacts pairs
  return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
};
