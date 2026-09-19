import * as XLSX from 'xlsx';
import type {
  DailyResult,
  DsmTask,
  GraphEvent,
  GraphNode,
  JobState,
  TimeSource,
  WorkGraph,
} from './types';

const STATE_KEY = 'gitubGenJobState';
const MAX_GRAPH_DEPTH = 2;
const MAX_GRAPH_NODES = 24;
const ACTIVITY_CLUSTER_GAP_MINUTES = 90;
const ACTIVITY_CLUSTER_GAP_MS =
  ACTIVITY_CLUSTER_GAP_MINUTES * 60 * 1000;

type RelationKind = 'sub_issue' | 'parent_issue' | 'linked_pr';

type PageRelation = {
  url: string;
  kind: 'issue' | 'pull';
  relation: RelationKind;
};

type PageSnapshot = {
  pageUrl: string;
  kind: 'issue' | 'pull';
  events: Array<{
    timestamp: string;
    text: string;
  }>;
  relations: PageRelation[];
  noAccess: boolean;
  error?: string;
};

type QueueItem = {
  node: GraphNode;
  depth: number;
  mode: 'normal' | 'parent';
};

type StatusPair = {
  sourceUrl: string;
  startIso: string;
  endIso: string;
};

type WorkSegment = {
  kind: 'status' | 'activity';
  startIso: string;
  endIso: string;
  statusSourceUrls: string[];
  activitySourceUrls: string[];
  eventCount: number;
};

chrome.action.onClicked.addListener(async () => {
  const appUrl = chrome.runtime.getURL('app.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url === appUrl);

  if (typeof existing?.id === 'number') {
    await chrome.tabs.update(existing.id, { active: true });

    if (typeof existing.windowId === 'number') {
      await chrome.windows.update(existing.windowId, { focused: true });
    }

    return;
  }

  await chrome.tabs.create({
    url: appUrl,
    active: true,
  });
});

const initialState: JobState = {
  running: false,
  current: 0,
  total: 0,
  message: 'Belum ada job.',
};

let inMemoryRunning = false;

async function setState(state: JobState) {
  await chrome.storage.local.set({ [STATE_KEY]: state });

  try {
    await chrome.runtime.sendMessage({
      type: 'JOB_PROGRESS',
      state,
    });
  } catch {
    // App tab mungkin tertutup. State tetap disimpan.
  }
}

async function getState(): Promise<JobState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return (stored[STATE_KEY] as JobState | undefined) ?? initialState;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabComplete(tabId: number, timeoutMs = 30_000) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === 'complete') return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout menunggu GitHub selesai dimuat.'));
    }, timeoutMs);

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;

      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function canonicalGithubUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return `https://github.com${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return rawUrl.replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

async function scrapeGithubPageInBrowser(): Promise<PageSnapshot> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const loadMore = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) =>
      /^(load more|show more activity)/i.test(button.innerText.trim()),
    );

    if (!loadMore) break;

    loadMore.click();
    await new Promise((resolve) => setTimeout(resolve, 650));
  }

  const currentUrl =
    `https://github.com${window.location.pathname.replace(/\/$/, '')}`;
  const pathname = window.location.pathname;
  const kind: 'issue' | 'pull' = /\/pull\/\d+\/?$/.test(pathname)
    ? 'pull'
    : 'issue';

  const bodyText = document.body?.innerText ?? '';

  if (
    window.location.pathname.startsWith('/login') ||
    /sign in to github/i.test(bodyText) ||
    /page not found/i.test(bodyText)
  ) {
    return {
      pageUrl: currentUrl,
      kind,
      events: [],
      relations: [],
      noAccess: true,
      error: 'GitHub meminta login atau halaman tidak dapat diakses.',
    };
  }

  const eventRows = Array.from(
    document.querySelectorAll<HTMLElement>('relative-time[datetime]'),
  )
    .map((element) => {
      const container =
        element.closest<HTMLElement>('.TimelineItem') ||
        element.closest<HTMLElement>('[data-testid]') ||
        element.parentElement?.parentElement?.parentElement;

      const timestamp = element.getAttribute('datetime') ?? '';
      const text = container?.innerText?.trim() ?? '';

      const links = container
        ? Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'))
            .map((anchor) => {
              try {
                const url = new URL(anchor.href);
                if (url.hostname !== 'github.com') return null;

                const clean =
                  `https://github.com${url.pathname.replace(/\/$/, '')}`;

                if (
                  /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(url.pathname)
                ) {
                  return {
                    url: clean,
                    kind: 'issue' as const,
                  };
                }

                if (
                  /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
                ) {
                  return {
                    url: clean,
                    kind: 'pull' as const,
                  };
                }
              } catch {
                return null;
              }

              return null;
            })
            .filter(
              (
                link,
              ): link is {
                url: string;
                kind: 'issue' | 'pull';
              } => Boolean(link),
            )
        : [];

      return {
        timestamp,
        text,
        links,
      };
    })
    .filter((event) => event.timestamp && event.text);

  const uniqueEvents = Array.from(
    new Map(
      eventRows.map((event) => [
        `${event.timestamp}|${event.text.replace(/\s+/g, ' ')}`,
        event,
      ]),
    ).values(),
  ).sort(
    (a, b) =>
      new Date(a.timestamp).getTime() -
      new Date(b.timestamp).getTime(),
  );

  const relationMap = new Map<string, PageRelation>();

  if (kind === 'issue') {
    for (const event of uniqueEvents) {
      let relation: RelationKind | null = null;

      if (/added a sub-issue/i.test(event.text)) {
        relation = 'sub_issue';
      } else if (/added a parent issue/i.test(event.text)) {
        relation = 'parent_issue';
      } else if (/linked a pull request/i.test(event.text)) {
        relation = 'linked_pr';
      }

      if (!relation) continue;

      for (const link of event.links) {
        if (relation === 'linked_pr' && link.kind !== 'pull') continue;

        if (
          (relation === 'sub_issue' || relation === 'parent_issue') &&
          link.kind !== 'issue'
        ) {
          continue;
        }

        if (link.url === currentUrl) continue;

        relationMap.set(
          `${relation}|${link.url}`,
          {
            url: link.url,
            kind: link.kind,
            relation,
          },
        );
      }
    }
  }

  return {
    pageUrl: currentUrl,
    kind,
    events: uniqueEvents.map(({ timestamp, text }) => ({
      timestamp,
      text,
    })),
    relations: [...relationMap.values()],
    noAccess: false,
  };
}

async function scrapePage(url: string): Promise<PageSnapshot> {
  let tabId: number | undefined;

  try {
    const tab = await chrome.tabs.create({
      url,
      active: false,
    });

    if (typeof tab.id !== 'number') {
      throw new Error('GitHub tab tidak memiliki tab id.');
    }

    tabId = tab.id;

    await waitForTabComplete(tabId);
    await delay(900);

    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeGithubPageInBrowser,
    });

    const result = injection[0]?.result as PageSnapshot | undefined;

    if (!result) {
      throw new Error('Tidak mendapat hasil dari DOM GitHub.');
    }

    return {
      ...result,
      pageUrl: canonicalGithubUrl(url),
    };
  } finally {
    if (typeof tabId === 'number') {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Tab mungkin sudah tertutup.
      }
    }
  }
}

async function crawlWorkGraph(rootUrl: string): Promise<WorkGraph> {
  const canonicalRoot = canonicalGithubUrl(rootUrl);
  const queue: QueueItem[] = [
    {
      node: {
        url: canonicalRoot,
        kind: 'issue',
        relation: 'root',
      },
      depth: 0,
      mode: 'normal',
    },
  ];

  const visited = new Set<string>();
  const nodes: GraphNode[] = [];
  const events: GraphEvent[] = [];
  const errors: string[] = [];

  while (queue.length > 0 && nodes.length < MAX_GRAPH_NODES) {
    const current = queue.shift()!;
    const nodeUrl = canonicalGithubUrl(current.node.url);

    if (visited.has(nodeUrl)) continue;
    visited.add(nodeUrl);

    try {
      const snapshot = await scrapePage(nodeUrl);

      nodes.push({
        ...current.node,
        url: nodeUrl,
      });

      if (snapshot.noAccess) {
        errors.push(`${nodeUrl}: ${snapshot.error ?? 'No access'}`);
        continue;
      }

      for (const event of snapshot.events) {
        events.push({
          sourceUrl: nodeUrl,
          sourceKind: current.node.kind,
          timestamp: event.timestamp,
          text: event.text,
        });
      }

      if (current.node.kind !== 'issue') continue;

      for (const relation of snapshot.relations) {
        const relatedUrl = canonicalGithubUrl(relation.url);

        if (visited.has(relatedUrl)) continue;

        if (relation.relation === 'linked_pr') {
          queue.push({
            node: {
              url: relatedUrl,
              kind: 'pull',
              relation: 'linked_pr',
            },
            depth: current.depth + 1,
            mode: current.mode,
          });
          continue;
        }

        if (current.depth >= MAX_GRAPH_DEPTH) continue;

        if (relation.relation === 'sub_issue') {
          // Kalau root ternyata naik ke parent, jangan menyapu sibling sub-issue.
          if (current.mode === 'parent') continue;

          queue.push({
            node: {
              url: relatedUrl,
              kind: 'issue',
              relation: 'sub_issue',
            },
            depth: current.depth + 1,
            mode: 'normal',
          });
          continue;
        }

        if (relation.relation === 'parent_issue') {
          queue.push({
            node: {
              url: relatedUrl,
              kind: 'issue',
              relation: 'parent_issue',
            },
            depth: current.depth + 1,
            mode: 'parent',
          });
        }
      }
    } catch (error) {
      errors.push(
        `${nodeUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (queue.length > 0) {
    errors.push(
      `Graph dipotong pada ${MAX_GRAPH_NODES} node untuk mencegah crawl berlebihan.`,
    );
  }

  return {
    rootUrl: canonicalRoot,
    nodes,
    events: events.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() -
        new Date(b.timestamp).getTime(),
    ),
    errors,
  };
}

function dsmDateToYmd(date: string) {
  const [day, month, year] = date.split('-');
  return `${year}-${month}-${day}`;
}

function eventDateWib(iso: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));

  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${value.year}-${value.month}-${value.day}`;
}

function eventMinutesWib(iso: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));

  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return Number(value.hour) * 60 + Number(value.minute);
}

function sessionMinutes(sessionTime: string) {
  const match = sessionTime.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) return null;

  return Number(match[1]) * 60 + Number(match[2]);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function rowKey(task: DsmTask) {
  return (
    `${canonicalGithubUrl(task.ticketUrl)}|${task.date}|` +
    `${task.sessionTime || 'NO_TIME'}`
  );
}

function startsWithActor(text: string, username: string) {
  const firstLine = text.split('\n')[0]?.trim().toLowerCase() ?? '';
  return firstLine === username.trim().toLowerCase();
}

function isNoiseActivity(text: string) {
  return /(?:assigned|mentioned this|subscribed|unsubscribed|added this to|removed this from|requested a review|review request removed)/i.test(
    text,
  );
}

function buildStatusPairs(graph: WorkGraph): StatusPair[] {
  const byIssue = new Map<string, GraphEvent[]>();

  for (const event of graph.events) {
    if (event.sourceKind !== 'issue') continue;

    const current = byIssue.get(event.sourceUrl) ?? [];
    current.push(event);
    byIssue.set(event.sourceUrl, current);
  }

  const pairs: StatusPair[] = [];

  for (const [sourceUrl, issueEvents] of byIssue) {
    const ordered = [...issueEvents].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() -
        new Date(b.timestamp).getTime(),
    );

    let openStart: GraphEvent | null = null;

    for (const event of ordered) {
      if (/\bto\s+In Progress\b/i.test(event.text)) {
        if (!openStart) {
          openStart = event;
        }
        continue;
      }

      if (
        openStart &&
        /\bto\s+(?:Ready to Review|Staging)\b/i.test(event.text) &&
        new Date(event.timestamp).getTime() >
          new Date(openStart.timestamp).getTime()
      ) {
        pairs.push({
          sourceUrl,
          startIso: openStart.timestamp,
          endIso: event.timestamp,
        });

        openStart = null;
      }
    }
  }

  return pairs.sort(
    (a, b) =>
      new Date(a.startIso).getTime() -
      new Date(b.startIso).getTime(),
  );
}

function mergeOverlappingStatusPairs(
  pairs: StatusPair[],
): WorkSegment[] {
  const segments: WorkSegment[] = [];

  for (const pair of pairs) {
    const last = segments[segments.length - 1];
    const startMs = new Date(pair.startIso).getTime();
    const endMs = new Date(pair.endIso).getTime();

    if (
      last &&
      startMs <= new Date(last.endIso).getTime()
    ) {
      if (endMs > new Date(last.endIso).getTime()) {
        last.endIso = pair.endIso;
      }

      last.statusSourceUrls = uniqueStrings([
        ...last.statusSourceUrls,
        pair.sourceUrl,
      ]);
      last.eventCount += 2;
      continue;
    }

    segments.push({
      kind: 'status',
      startIso: pair.startIso,
      endIso: pair.endIso,
      statusSourceUrls: [pair.sourceUrl],
      activitySourceUrls: [],
      eventCount: 2,
    });
  }

  return segments;
}

function clusterActivityEvents(
  events: GraphEvent[],
): WorkSegment[] {
  const ordered = [...events].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() -
      new Date(b.timestamp).getTime(),
  );

  const clusters: GraphEvent[][] = [];

  for (const event of ordered) {
    const lastCluster = clusters[clusters.length - 1];

    if (!lastCluster) {
      clusters.push([event]);
      continue;
    }

    const previous = lastCluster[lastCluster.length - 1];
    const gap =
      new Date(event.timestamp).getTime() -
      new Date(previous.timestamp).getTime();

    if (gap < ACTIVITY_CLUSTER_GAP_MS) {
      lastCluster.push(event);
    } else {
      clusters.push([event]);
    }
  }

  return clusters.map((cluster) => ({
    kind: 'activity' as const,
    startIso: cluster[0].timestamp,
    endIso: cluster[cluster.length - 1].timestamp,
    statusSourceUrls: [],
    activitySourceUrls: uniqueStrings(
      cluster.map((event) => event.sourceUrl),
    ),
    eventCount: cluster.length,
  }));
}

function intervalsOverlap(a: WorkSegment, b: WorkSegment) {
  return (
    new Date(a.startIso).getTime() <=
      new Date(b.endIso).getTime() &&
    new Date(b.startIso).getTime() <=
      new Date(a.endIso).getTime()
  );
}

function buildWorkSegmentsForDate(
  graph: WorkGraph,
  targetDate: string,
  githubUsername: string,
) {
  const statusPairs = buildStatusPairs(graph).filter(
    (pair) =>
      eventDateWib(pair.startIso) === targetDate &&
      eventDateWib(pair.endIso) === targetDate,
  );

  const statusSegments =
    mergeOverlappingStatusPairs(statusPairs);

  const activityEvents = Array.from(
    new Map(
      graph.events
        .filter(
          (event) =>
            event.sourceKind === 'pull' &&
            eventDateWib(event.timestamp) === targetDate &&
            startsWithActor(event.text, githubUsername) &&
            !isNoiseActivity(event.text),
        )
        .map((event) => [
          `${event.sourceUrl}|${event.timestamp}|${event.text.replace(/\s+/g, ' ')}`,
          event,
        ]),
    ).values(),
  );

  const activitySegments =
    clusterActivityEvents(activityEvents);

  const standaloneActivity: WorkSegment[] = [];

  for (const activitySegment of activitySegments) {
    const overlappingStatus = statusSegments.find((statusSegment) =>
      intervalsOverlap(statusSegment, activitySegment),
    );

    if (overlappingStatus) {
      overlappingStatus.activitySourceUrls = uniqueStrings([
        ...overlappingStatus.activitySourceUrls,
        ...activitySegment.activitySourceUrls,
      ]);
      overlappingStatus.eventCount +=
        activitySegment.eventCount;
      continue;
    }

    standaloneActivity.push(activitySegment);
  }

  return [...statusSegments, ...standaloneActivity].sort(
    (a, b) =>
      new Date(a.startIso).getTime() -
      new Date(b.startIso).getTime(),
  );
}

function segmentAnchorMinutes(segment: WorkSegment) {
  const start = eventMinutesWib(segment.startIso);
  const end = eventMinutesWib(segment.endIso);
  return (start + end) / 2;
}

function assignSegmentsToTasks(
  tasks: DsmTask[],
  segments: WorkSegment[],
) {
  const assignments = new Map<string, number>();
  const usedTasks = new Set<number>();
  const usedSegments = new Set<number>();

  const candidates: Array<{
    taskIndex: number;
    segmentIndex: number;
    score: number;
  }> = [];

  tasks.forEach((task, taskIndex) => {
    const anchor = sessionMinutes(task.sessionTime);

    segments.forEach((segment, segmentIndex) => {
      const segmentAnchor = segmentAnchorMinutes(segment);

      const distance =
        anchor === null
          ? segmentIndex * 60
          : Math.abs(segmentAnchor - anchor);

      // Status pair adalah bukti lebih kuat, jadi beri bonus kecil.
      const score =
        distance - (segment.kind === 'status' ? 30 : 0);

      candidates.push({
        taskIndex,
        segmentIndex,
        score,
      });
    });
  });

  candidates.sort((a, b) => a.score - b.score);

  for (const candidate of candidates) {
    if (
      usedTasks.has(candidate.taskIndex) ||
      usedSegments.has(candidate.segmentIndex)
    ) {
      continue;
    }

    assignments.set(
      rowKey(tasks[candidate.taskIndex]),
      candidate.segmentIndex,
    );

    usedTasks.add(candidate.taskIndex);
    usedSegments.add(candidate.segmentIndex);
  }

  return assignments;
}

function resultFromSegment(
  task: DsmTask,
  graph: WorkGraph,
  segment: WorkSegment | undefined,
  clusterIndex: number | null,
): DailyResult {
  const rootUrl = canonicalGithubUrl(task.ticketUrl);

  const relatedIssueUrls = uniqueStrings(
    graph.nodes
      .filter((node) => node.kind === 'issue')
      .map((node) => node.url),
  );

  const relatedPrUrls = uniqueStrings(
    graph.nodes
      .filter((node) => node.kind === 'pull')
      .map((node) => node.url),
  );

  if (!segment) {
    return {
      rowKey: rowKey(task),
      rootUrl,
      date: task.date,
      sessionTime: task.sessionTime,
      startIso: null,
      endIso: null,
      timeSource: 'DSM_ONLY',
      statusSourceUrls: [],
      activitySourceUrls: [],
      activityCount: 0,
      clusterIndex: null,
      clusterStartIso: null,
      clusterEndIso: null,
      relatedIssueUrls,
      relatedPrUrls,
      graphErrors: graph.errors,
    };
  }

  let timeSource: TimeSource;
  let startIso: string | null = null;
  let endIso: string | null = null;

  if (segment.kind === 'status') {
    timeSource =
      segment.statusSourceUrls.length === 1 &&
      segment.statusSourceUrls[0] === rootUrl
        ? 'ROOT_ISSUE_STATUS'
        : 'RELATED_ISSUE_STATUS';

    startIso = segment.startIso;
    endIso = segment.endIso;
  } else if (segment.eventCount >= 2) {
    timeSource = 'RELATED_ACTIVITY';
    startIso = segment.startIso;
    endIso = segment.endIso;
  } else {
    timeSource = 'INSUFFICIENT_ACTIVITY';
  }

  return {
    rowKey: rowKey(task),
    rootUrl,
    date: task.date,
    sessionTime: task.sessionTime,
    startIso,
    endIso,
    timeSource,
    statusSourceUrls: segment.statusSourceUrls,
    activitySourceUrls: segment.activitySourceUrls,
    activityCount: segment.eventCount,
    clusterIndex,
    clusterStartIso: segment.startIso,
    clusterEndIso: segment.endIso,
    relatedIssueUrls,
    relatedPrUrls,
    graphErrors: graph.errors,
  };
}

function resolveRows(
  tasks: DsmTask[],
  graphs: Map<string, WorkGraph>,
  githubUsername: string,
) {
  const grouped = new Map<string, DsmTask[]>();

  for (const task of tasks) {
    const key =
      `${canonicalGithubUrl(task.ticketUrl)}|${task.date}`;
    const current = grouped.get(key) ?? [];
    current.push(task);
    grouped.set(key, current);
  }

  const results: DailyResult[] = [];

  for (const group of grouped.values()) {
    const orderedTasks = [...group].sort((a, b) => {
      const aMinutes = sessionMinutes(a.sessionTime);
      const bMinutes = sessionMinutes(b.sessionTime);

      if (aMinutes === null && bMinutes === null) return 0;
      if (aMinutes === null) return 1;
      if (bMinutes === null) return -1;
      return aMinutes - bMinutes;
    });

    const rootUrl =
      canonicalGithubUrl(orderedTasks[0].ticketUrl);

    const graph =
      graphs.get(rootUrl) ??
      ({
        rootUrl,
        nodes: [],
        events: [],
        errors: ['Work graph tidak tersedia.'],
      } satisfies WorkGraph);

    const targetDate = dsmDateToYmd(orderedTasks[0].date);

    const segments = buildWorkSegmentsForDate(
      graph,
      targetDate,
      githubUsername,
    );

    const assignments = assignSegmentsToTasks(
      orderedTasks,
      segments,
    );

    for (const task of orderedTasks) {
      const segmentIndex =
        assignments.get(rowKey(task)) ?? null;

      results.push(
        resultFromSegment(
          task,
          graph,
          segmentIndex === null
            ? undefined
            : segments[segmentIndex],
          segmentIndex === null
            ? null
            : segmentIndex + 1,
        ),
      );
    }
  }

  return results;
}

function getParts(iso: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));

  return Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
}

function formatStartTime(iso: string | null) {
  if (!iso) return '';

  const p = getParts(iso);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function formatEndTime(iso: string | null) {
  if (!iso) return '';

  const p = getParts(iso);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

function calculateHours(
  startIso: string | null,
  endIso: string | null,
) {
  if (!startIso || !endIso) return '';

  const hours =
    (new Date(endIso).getTime() -
      new Date(startIso).getTime()) /
    3_600_000;

  return Number(hours.toFixed(10));
}

function workbookFileName(tasks: DsmTask[]) {
  const firstDate = tasks[0]?.date ?? '';
  const [, month = '', year = ''] = firstDate.split('-');

  const monthNames: Record<string, string> = {
    '01': 'Januari',
    '02': 'Februari',
    '03': 'Maret',
    '04': 'April',
    '05': 'Mei',
    '06': 'Juni',
    '07': 'Juli',
    '08': 'Agustus',
    '09': 'September',
    '10': 'Oktober',
    '11': 'November',
    '12': 'Desember',
  };

  const monthName = monthNames[month] ?? month ?? 'KPI';
  return `KPI-${monthName}-${year || 'Export'}.xlsx`;
}

function compareTasksChronologically(a: DsmTask, b: DsmTask) {
  const dateCompare = dsmDateToYmd(a.date).localeCompare(
    dsmDateToYmd(b.date),
  );

  if (dateCompare !== 0) return dateCompare;

  const aMinutes = sessionMinutes(a.sessionTime);
  const bMinutes = sessionMinutes(b.sessionTime);

  if (aMinutes === null && bMinutes === null) return 0;
  if (aMinutes === null) return 1;
  if (bMinutes === null) return -1;

  return aMinutes - bMinutes;
}

function buildUniqueTicketRows(
  tasks: DsmTask[],
  resultByRow: Map<string, DailyResult>,
) {
  const grouped = new Map<string, DsmTask[]>();

  for (const task of tasks) {
    const url = canonicalGithubUrl(task.ticketUrl);
    const current = grouped.get(url) ?? [];
    current.push(task);
    grouped.set(url, current);
  }

  return [...grouped.entries()]
    .map(([ticketUrl, group]) => {
      const ordered = [...group].sort(compareTasksChronologically);
      const first = ordered[0];
      const last = ordered[ordered.length - 1];

      const bestTitle = ordered.reduce((best, task) =>
        task.ticketTitle.length > best.ticketTitle.length
          ? task
          : best,
      ).ticketTitle;

      const lastStatus =
        [...ordered]
          .reverse()
          .find((task) => task.status.trim())?.status ?? '';

      const systemType =
        ordered.find((task) => task.systemType.trim())?.systemType ?? '';

      const ticketType =
        ordered.find((task) => task.ticketType.trim())?.ticketType ?? '';

      const priority =
        [...ordered]
          .reverse()
          .find((task) => task.priority.trim())?.priority ?? '';

      const rowResults = ordered
        .map((task) => resultByRow.get(rowKey(task)))
        .filter((result): result is DailyResult => Boolean(result));

      const starts = rowResults
        .map((result) => result.startIso)
        .filter((value): value is string => Boolean(value))
        .sort(
          (a, b) =>
            new Date(a).getTime() - new Date(b).getTime(),
        );

      const ends = rowResults
        .map((result) => result.endIso)
        .filter((value): value is string => Boolean(value))
        .sort(
          (a, b) =>
            new Date(a).getTime() - new Date(b).getTime(),
        );

      let totalHour = 0;
      let completeRows = 0;

      for (const result of rowResults) {
        const hour = calculateHours(
          result.startIso,
          result.endIso,
        );

        if (typeof hour === 'number') {
          totalHour += hour;
          completeRows += 1;
        }
      }

      return {
        sortTask: first,
        row: [
          first.assignee,
          systemType,
          bestTitle,
          ticketUrl,
          ticketType,
          lastStatus,
          priority,
          first.date,
          first.week,
          formatStartTime(starts[0] ?? null),
          formatEndTime(ends[ends.length - 1] ?? null),
          completeRows > 0
            ? Number(totalHour.toFixed(10))
            : '',
          ordered.length,
        ],
      };
    })
    .sort((a, b) =>
      compareTasksChronologically(a.sortTask, b.sortTask),
    )
    .map((item) => item.row);
}

async function buildAndDownload(
  tasks: DsmTask[],
  results: DailyResult[],
) {
  const resultByRow = new Map(
    results.map((result) => [result.rowKey, result]),
  );

  const headers = [
    'Assignee',
    'Type',
    'Ticket Title',
    'Ticket URL',
    'Type',
    'Status',
    'Priority',
    'Date',
    'Week',
    'Start Time',
    'End Time',
    'Hour',
  ];

  const rows = tasks.map((task) => {
    const result = resultByRow.get(rowKey(task));

    return [
      task.assignee,
      task.systemType,
      task.ticketTitle,
      canonicalGithubUrl(task.ticketUrl),
      task.ticketType,
      task.status,
      task.priority,
      task.date,
      task.week,
      formatStartTime(result?.startIso ?? null),
      formatEndTime(result?.endIso ?? null),
      calculateHours(
        result?.startIso ?? null,
        result?.endIso ?? null,
      ),
    ];
  });

  const workbook = XLSX.utils.book_new();
  const kpiSheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  kpiSheet['!cols'] = [
    { wch: 12 },
    { wch: 14 },
    { wch: 58 },
    { wch: 58 },
    { wch: 14 },
    { wch: 20 },
    { wch: 12 },
    { wch: 13 },
    { wch: 12 },
    { wch: 22 },
    { wch: 22 },
    { wch: 14 },
  ];

  XLSX.utils.book_append_sheet(workbook, kpiSheet, 'KPI');

  const uniqueHeaders = [
    'Assignee',
    'Type',
    'Ticket Title',
    'Ticket URL',
    'Type',
    'Status',
    'Priority',
    'Date',
    'Week',
    'First Start Time',
    'Last End Time',
    'Total Hour',
    'Occurrence Count',
  ];

  const uniqueRows = buildUniqueTicketRows(
    tasks,
    resultByRow,
  );

  const uniqueSheet = XLSX.utils.aoa_to_sheet([
    uniqueHeaders,
    ...uniqueRows,
  ]);

  uniqueSheet['!cols'] = [
    { wch: 12 },
    { wch: 14 },
    { wch: 58 },
    { wch: 58 },
    { wch: 14 },
    { wch: 20 },
    { wch: 12 },
    { wch: 13 },
    { wch: 12 },
    { wch: 22 },
    { wch: 22 },
    { wch: 14 },
    { wch: 18 },
  ];

  XLSX.utils.book_append_sheet(
    workbook,
    uniqueSheet,
    'Rekap Tiket Unik',
  );

  const diagnostics = [
    [
      'Row Key',
      'Root Ticket',
      'Date',
      'DSM Session',
      'DSM Statuses',
      'Time Source',
      'Cluster #',
      'Cluster Start ISO',
      'Cluster End ISO',
      'Status Sources',
      'Activity Sources',
      'Activity Count',
      'Related Issues',
      'Related PRs',
      'Start ISO',
      'End ISO',
      'Graph Errors',
    ],
    ...tasks.map((task) => {
      const result = resultByRow.get(rowKey(task));

      return [
        rowKey(task),
        canonicalGithubUrl(task.ticketUrl),
        task.date,
        task.sessionTime,
        task.dsmStatuses.join(' -> '),
        result?.timeSource ?? 'DSM_ONLY',
        result?.clusterIndex ?? '',
        result?.clusterStartIso ?? '',
        result?.clusterEndIso ?? '',
        result?.statusSourceUrls.join('\n') ?? '',
        result?.activitySourceUrls.join('\n') ?? '',
        result?.activityCount ?? 0,
        result?.relatedIssueUrls.join('\n') ?? '',
        result?.relatedPrUrls.join('\n') ?? '',
        result?.startIso ?? '',
        result?.endIso ?? '',
        result?.graphErrors.join('\n') ?? '',
      ];
    }),
  ];

  const diagnosticsSheet =
    XLSX.utils.aoa_to_sheet(diagnostics);

  diagnosticsSheet['!cols'] = [
    { wch: 78 },
    { wch: 58 },
    { wch: 14 },
    { wch: 14 },
    { wch: 34 },
    { wch: 28 },
    { wch: 12 },
    { wch: 28 },
    { wch: 28 },
    { wch: 58 },
    { wch: 58 },
    { wch: 14 },
    { wch: 58 },
    { wch: 58 },
    { wch: 28 },
    { wch: 28 },
    { wch: 70 },
  ];

  XLSX.utils.book_append_sheet(
    workbook,
    diagnosticsSheet,
    'Diagnostics',
  );

  const base64 = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'base64',
  });

  return chrome.downloads.download({
    url:
      'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' +
      base64,
    filename: workbookFileName(tasks),
    saveAs: true,
  });
}

async function runJob(
  tasks: DsmTask[],
  githubUsername: string,
) {
  inMemoryRunning = true;

  const canonicalTasks = tasks.map((task) => ({
    ...task,
    ticketUrl: canonicalGithubUrl(task.ticketUrl),
  }));

  const rootUrls = uniqueStrings(
    canonicalTasks.map((task) => task.ticketUrl),
  );

  const graphs = new Map<string, WorkGraph>();

  await setState({
    running: true,
    current: 0,
    total: rootUrls.length,
    message:
      `Membangun work graph untuk ${rootUrls.length} root issue...`,
  });

  try {
    for (let index = 0; index < rootUrls.length; index += 1) {
      const rootUrl = rootUrls[index];

      await setState({
        running: true,
        current: index,
        total: rootUrls.length,
        currentUrl: rootUrl,
        message:
          `Crawl graph ${index + 1}/${rootUrls.length}`,
      });

      const graph = await crawlWorkGraph(rootUrl);
      graphs.set(rootUrl, graph);

      await setState({
        running: true,
        current: index + 1,
        total: rootUrls.length,
        currentUrl: rootUrl,
        message:
          `Selesai graph ${index + 1}/${rootUrls.length}`,
      });
    }

    const results = resolveRows(
      canonicalTasks,
      graphs,
      githubUsername,
    );

    const downloadId = await buildAndDownload(
      canonicalTasks,
      results,
    );

    const completeCount = results.filter(
      (result) => result.startIso && result.endIso,
    ).length;

    await setState({
      running: false,
      current: rootUrls.length,
      total: rootUrls.length,
      message:
        `Selesai. ${canonicalTasks.length} row KPI dibuat; ` +
        `${completeCount} punya Start & End lengkap.`,
      finishedAt: new Date().toISOString(),
      downloadId,
    });
  } catch (error) {
    await setState({
      running: false,
      current: graphs.size,
      total: rootUrls.length,
      message:
        error instanceof Error
          ? `Job gagal: ${error.message}`
          : 'Job gagal.',
      finishedAt: new Date().toISOString(),
    });
  } finally {
    inMemoryRunning = false;
  }
}

chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse) => {
    if (message?.type === 'GET_JOB_STATE') {
      void getState().then((state) =>
        sendResponse({ state }),
      );
      return true;
    }

    if (message?.type === 'START_JOB') {
      void (async () => {
        const tasks = message.tasks as DsmTask[];
        const githubUsername = String(
          message.githubUsername || 'allifgobimbel',
        ).trim();

        if (!Array.isArray(tasks) || tasks.length === 0) {
          sendResponse({
            ok: false,
            error: 'Task DSM kosong.',
          });
          return;
        }

        if (inMemoryRunning) {
          sendResponse({
            ok: false,
            error: 'Masih ada job yang berjalan.',
          });
          return;
        }

        sendResponse({ ok: true });
        void runJob(tasks, githubUsername);
      })();

      return true;
    }

    return undefined;
  },
);
