/** A file the teammate can read, as labelled sections the model can cite. */
export interface Doc {
  name: string;
  kind: 'text' | 'pdf' | 'docx' | 'pptx' | 'xlsx';
  /** Headings, slide titles or sheet names, at most `MAX_OUTLINE`. */
  outline: string[];
  /** `label` is what the footer and the model see: "p. 3", "slide 2", "sheet Budget", "part 4". */
  sections: { label: string; text: string }[];
}

export type FileReadCode = 'missing' | 'tooBig' | 'unsupported' | 'unreadable';

export class FileReadError extends Error {
  constructor(readonly code: FileReadCode, message: string) {
    super(message);
    this.name = 'FileReadError';
  }
}

export const MAX_OUTLINE = 100;

/** The default cap for a file on disk and for a web PDF (spec: 50 MB). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
