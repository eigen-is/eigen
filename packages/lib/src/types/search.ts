import type { DrivePath } from './drive';
import type { EmailSummary } from './mail';

export type SearchSource = 'mail' | 'file';

export type SearchResponse = {
    mail: EmailSummary[];
    file: DrivePath[];
};
