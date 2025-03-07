import { Star, Paperclip } from 'lucide-react';
import Link from 'next/link';

export type Email = {
  id: string;
  read: boolean;
  starred: boolean;
  from: {
    name: string;
    email: string;
  };
  subject: string;
  preview: string;
  hasAttachment: boolean;
  date: string;
  labels?: string[];
  important?: boolean;
};

interface EmailListProps {
  emails: Email[];
}

export function EmailList({ emails }: EmailListProps) {
  return (
    <div className="w-full">
      <div className="border-b">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-4">
            <input type="checkbox" className="h-4 w-4" />
            <button className="text-gray-500 hover:text-gray-700">
              <span className="sr-only">Refresh</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
                <path d="M21 3v5h-5"></path>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
                <path d="M8 16H3v5"></path>
              </svg>
            </button>
            <button className="text-gray-500 hover:text-gray-700">
              <span className="sr-only">More</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1"></circle>
                <circle cx="12" cy="5" r="1"></circle>
                <circle cx="12" cy="19" r="1"></circle>
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">1-50 of 4,430</span>
            <div className="flex items-center gap-2">
              <button className="text-gray-500 hover:text-gray-700">
                <span className="sr-only">Previous</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </button>
              <button className="text-gray-500 hover:text-gray-700">
                <span className="sr-only">Next</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div>
        {emails.map((email) => (
          <Link 
            key={email.id} 
            href={`/inbox/${email.id}`}
            className={`flex items-center border-b hover:bg-gray-50 transition-colors ${!email.read ? 'font-semibold bg-blue-50' : ''}`}
          >
            <div className="p-4 flex items-center gap-4 w-full">
              <input type="checkbox" className="h-4 w-4" />
              <button className="text-gray-400 hover:text-yellow-400">
                <Star size={18} fill={email.starred ? "gold" : "none"} color={email.starred ? "gold" : "currentColor"} />
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className={`truncate w-48 ${!email.read ? 'font-semibold' : ''}`}>
                    {email.important && <span className="text-yellow-500 mr-1">!</span>}
                    {email.from.name}
                  </span>
                  <span className="text-sm text-gray-500 whitespace-nowrap">{email.date}</span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate max-w-md">
                      {email.subject} - <span className="text-gray-500">{email.preview}</span>
                    </span>
                    {email.hasAttachment && <Paperclip size={14} className="text-gray-400" />}
                  </div>
                  {email.labels && email.labels.length > 0 && (
                    <div className="flex gap-1">
                      {email.labels.map((label) => (
                        <span 
                          key={label} 
                          className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600 whitespace-nowrap"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
