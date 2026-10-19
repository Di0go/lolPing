import type { PingId } from '../pings';

/** One thread as stored: its asks and answers, with a 512 px thumbnail of each ask's screen. */
export interface ThreadRecord {
  id: string;
  title: string;
  started: number;
  lastActivity: number;
  app: string;
  windowTitle: string;
  profile: string;
  entries: {
    at: number;
    intent: PingId;
    words: string | null;
    line: string;
    markdown: string;
    /** base64 JPEG, 512 px */
    thumb: string;
  }[];
}
