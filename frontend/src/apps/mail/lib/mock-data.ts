import { Email } from "@/types";

export const mockEmails: Email[] = [
  {
    id: "1",
    read: false,
    starred: true,
    from: { name: "'Nanette Kappers' v.", email: "nanette.kappers@example.com" },
    subject: "[Important] - Changes to Time Tracking - follow-up",
    preview: "Hi Team, Following up on the time tracking update below that Ignacio Laubert...",
    hasAttachment: false,
    date: "6 Mar",
    important: true
  },
  {
    id: "2",
    read: false,
    starred: false,
    from: { name: "Wiese Schellevis", email: "wiese.schellevis@example.com" },
    subject: "Updated Invitation: Monthly Team Meeting",
    preview: "@ Monthly from 17:00 to 21:00 on Thursday (CET) (experience-team@...",
    hasAttachment: false,
    date: "6 Mar"
  },
  {
    id: "3",
    read: false,
    starred: true,
    from: { name: "Claudia Lazzarini", email: "claudia.lazzarini@example.com" },
    subject: "Updated Invitation: [Option 1] EMEA Growth Conversation & Goal Setting Training",
    preview: "@ Mon 10 Mar 2025 14:30 - 15:00 (CET)...",
    hasAttachment: false,
    date: "6 Mar"
  },
  {
    id: "4",
    read: false,
    starred: false,
    from: { name: "Google Cloud", email: "cloud-noreply@google.com" },
    subject: "[Action Advised] Migrate to Gemini 2.0 starting April 2025",
    preview: "We're discontinuing certain Generative AI models on Vertex AI. MY...",
    hasAttachment: false,
    date: "6 Mar"
  },
  {
    id: "5",
    read: false,
    starred: false,
    from: { name: "Wiese Schellevis", email: "wiese.schellevis@example.com" },
    subject: "Information about your NS Business Card",
    preview: "Dear Monks, You are receiving this email as you currently hold an NS Business...",
    hasAttachment: false,
    date: "5 Mar"
  },
  {
    id: "6",
    read: false,
    starred: false,
    from: { name: "Lina Sabastiniate", email: "lina.sabastiniate@example.com" },
    subject: "ISO Security Audit 6-7 March",
    preview: "Dear Hilversum Monks, Information security audit will take place in the Hilversum office on 6-7 Ma...",
    hasAttachment: false,
    date: "5 Mar"
  },
  {
    id: "7",
    read: false,
    starred: false,
    from: { name: "Rob Wagner", email: "rob.wagner@example.com" },
    subject: "Invitation: Rob x Robert - Defense 3D models",
    preview: "@ Wed 5 Mar 2025 14:00 - 16:00 (CET) (Reinder Nijhoff) - Rob x Robert - Defense 3...",
    hasAttachment: true,
    date: "4 Mar"
  },
  {
    id: "8",
    read: false,
    starred: true,
    from: { name: "Claudia Lazzarini", email: "claudia.lazzarini@example.com" },
    subject: "Invitation: [Option 1] EMEA Growth Conversation & Goal Setting Training",
    preview: "@ Wed 12 Mar 2025 10:00 - 10:30 (CET) (Reinder Nijhoff) - [Option 1] EMEA Growth Conversation & Goal Setting Training @ Fri 7 Mar 2025 10:00 - 10:30 (CET) (Reinder Nij...",
    hasAttachment: false,
    date: "4 Mar"
  },
  {
    id: "9",
    read: false,
    starred: false,
    from: { name: "Claudia Lazzarini", email: "claudia.lazzarini@example.com" },
    subject: "Invitation: [Option 1] EMEA Growth Conversation & Goal Setting Training",
    preview: "@ Fri Mar 7, 2025 10am - 10:30am (GMT+1) (all-employees@...",
    hasAttachment: false,
    date: "4 Mar"
  },
  {
    id: "10",
    read: false,
    starred: false,
    from: { name: "'Claudia Lazzarini'", email: "claudia.lazzarini@example.com" },
    subject: "Kicking Off 2025 Goal Setting",
    preview: "Hello Monks, We hope you are all doing well! We wanted to kick off Goal Setting for 2025 in Workda...",
    hasAttachment: false,
    date: "4 Mar"
  }
];

export async function getEmailById(id: string): Promise<Email | undefined> {
  return mockEmails.find(email => email.id === id);
};
