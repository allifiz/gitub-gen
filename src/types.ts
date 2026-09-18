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
  dsmStatuses: string[];
  dsmTimes: string[];
};

export type WorkEpisode = {
  id: string;
  rootUrl: string;
  assignee: string;
  systemType: string;
  ticketTitle: string;
  ticketType: string;
  priority: string;
  status: string;
  date: string;
  week: string;
  dsmDates: string[];
  dsmStatuses: string[];
  dsmTimes: string[];
};

export type GraphNodeKind = 'issue' | 'pull';

export type GraphNode = {
  url: string;
  kind: GraphNodeKind;
  relation:
    | 'root'
    | 'sub_issue'
    | 'parent_issue'
    | 'linked_pr';
};

export type GraphEvent = {
  sourceUrl: string;
  sourceKind: GraphNodeKind;
  timestamp: string;
  text: string;
};

export type WorkGraph = {
  rootUrl: string;
  nodes: GraphNode[];
  events: GraphEvent[];
  errors: string[];
};

export type TimeSource =
  | 'ROOT_ISSUE_STATUS'
  | 'RELATED_ISSUE_STATUS'
  | 'RELATED_PR_ACTIVITY'
  | 'PR_ACTIVITY_PARTIAL'
  | 'DSM_ONLY';

export type EpisodeResult = {
  episodeId: string;
  rootUrl: string;
  startIso: string | null;
  endIso: string | null;
  timeSource: TimeSource;
  statusSourceUrls: string[];
  activitySourceUrls: string[];
  relatedIssueUrls: string[];
  relatedPrUrls: string[];
  graphErrors: string[];
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
