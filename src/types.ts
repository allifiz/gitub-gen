export type DsmTask = {
  assignee: string;
  systemType: string;
  ticketTitle: string;
  ticketUrl: string;
  ticketType: string;
  status: string;
  priority: string;
  date: string;
  week: string;
};

export type TimelineResult = {
  ticketUrl: string;
  startIso: string | null;
  endIso: string | null;
  scrapeStatus:
    | 'OK'
    | 'NO_IN_PROGRESS'
    | 'NO_READY_TO_REVIEW'
    | 'NO_ACCESS'
    | 'ERROR';
  error?: string;
};

export type JobState = {
  running: boolean;
  current: number;
  total: number;
  currentUrl?: string;
  message: string;
  finishedAt?: string;
  downloadId?: number;
};
