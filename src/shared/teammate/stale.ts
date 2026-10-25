import type { Rect } from './coords';

/** The window in front: its id (as the foreground reply's), caption, screen box and process id. */
export interface FrontWindow {
  window: string;
  title: string;
  box: Rect;
  pid: number;
}
