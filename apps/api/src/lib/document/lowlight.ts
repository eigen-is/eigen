import { common, createLowlight } from 'lowlight';

// The backend's one highlighter: a language the docx writer writes is one its reader knows. Loading it loads every
// grammar, so the main thread imports it only lazily, through what highlights.
export const lowlight = createLowlight(common);
