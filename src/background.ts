import * as XLSX from 'xlsx';
import type {
  DsmTask,
  EpisodeResult,
  GraphEvent,
  GraphNode,
  JobState,
  TimeSource,
  WorkEpisode,
  WorkGraph,
} from './types';

const STATE_KEY = 'gitubGenJobState';
const MAX_GRAPH_DEPTH = 2;
const MAX_GRAPH_NODES = 24;

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
  key: string;
  sourceUrl: string;
  startIso: string;
  endIso: string;
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

function classifyGithubUrl(url: string): 'issue' | 'pull' | null {
  try {
    const pathname = new URL(url).pathname;
    if (/^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(pathname)) {
      return 'issue';
    }
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(pathname)) {
      return 'pull';
    }
  } catch {
    return null;
  }

  return null;
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

  const currentUrl = `https://github.com${window.location.pathname.replace(/\/$/, '')}`;
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

                const clean = `https://github.com${url.pathname.replace(/\/$/, '')}`;

                if (
                  /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(url.pathname)
                ) {
                  return { url: clean, kind: 'issue' as const };
                }

                if (
                  /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
                ) {
                  return { url: clean, kind: 'pull' as const };
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
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
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
          // Saat naik ke parent issue, jangan ikut menyapu sibling sub-issue.
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
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    ),
    errors,
  };
}

function normalizeStatus(status: string) {
  return status.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isInProgress(status: string) {
  const normalized = normalizeStatus(status);
  return /\bin\s*(?:progress|porgress)\b/i.test(normalized);
}

function isReadyToReview(status: string) {
  return /\bready\s+to\s+review\b/i.test(normalizeStatus(status));
}

function isTerminalStatus(status: string) {
  const normalized = normalizeStatus(status);

  return (
    isReadyToReview(status) ||
    /\bstaging\b/i.test(normalized) ||
    /\bdeployed\b/i.test(normalized) ||
    /\bdone\b/i.test(normalized)
  );
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function buildWorkEpisodes(tasks: DsmTask[]): WorkEpisode[] {
  const grouped = new Map<string, DsmTask[]>();

  for (const task of tasks) {
    const rootUrl = canonicalGithubUrl(task.ticketUrl);
    const current = grouped.get(rootUrl) ?? [];
    current.push({
      ...task,
      ticketUrl: rootUrl,
    });
    grouped.set(rootUrl, current);
  }

  const episodes: WorkEpisode[] = [];

  for (const [rootUrl, group] of grouped) {
    const ordered = [...group].sort((a, b) =>
      dsmDateToYmd(a.date).localeCompare(dsmDateToYmd(b.date)),
    );

    let index = 0;
    let episodeNumber = 1;

    while (index < ordered.length) {
      const startTask = ordered[index];
      const hasInProgress = startTask.dsmStatuses.some(isInProgress);

      let endIndex = index;

      if (hasInProgress) {
        for (let cursor = index; cursor < ordered.length; cursor += 1) {
          if (ordered[cursor].dsmStatuses.some(isTerminalStatus)) {
            endIndex = cursor;
            break;
          }
        }
      }

      const episodeTasks = ordered.slice(index, endIndex + 1);
      const finalTask = episodeTasks[episodeTasks.length - 1];
      const bestTitle = episodeTasks.reduce((best, task) =>
        task.ticketTitle.length > best.ticketTitle.length ? task : best,
      ).ticketTitle;

      episodes.push({
        id: `${rootUrl}|episode-${episodeNumber}`,
        rootUrl,
        assignee: startTask.assignee,
        systemType: startTask.systemType,
        ticketTitle: bestTitle,
        ticketType: startTask.ticketType,
        priority: startTask.priority,
        status: finalTask.status,
        date: startTask.date,
        week: startTask.week,
        dsmDates: uniqueStrings(episodeTasks.map((task) => task.date)),
        dsmStatuses: uniqueStrings(
          episodeTasks.flatMap((task) => task.dsmStatuses),
        ),
        dsmTimes: uniqueStrings(
          episodeTasks.flatMap((task) => task.dsmTimes),
        ),
      });

      index = endIndex + 1;
      episodeNumber += 1;
    }
  }

  return episodes.sort((a, b) => {
    const dateCompare = dsmDateToYmd(a.date).localeCompare(
      dsmDateToYmd(b.date),
    );

    if (dateCompare !== 0) return dateCompare;
    return a.rootUrl.localeCompare(b.rootUrl);
  });
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
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    let openStart: GraphEvent | null = null;

    for (const event of ordered) {
      if (/\bto\s+In Progress\b/i.test(event.text)) {
        openStart = event;
        continue;
      }

      if (
        openStart &&
        /\bto\s+Ready to Review\b/i.test(event.text) &&
        new Date(event.timestamp).getTime() >
          new Date(openStart.timestamp).getTime()
      ) {
        pairs.push({
          key: `${sourceUrl}|${openStart.timestamp}|${event.timestamp}`,
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
      new Date(a.startIso).getTime() - new Date(b.startIso).getTime(),
  );
}

function eventBelongsToEpisode(
  timestamp: string,
  episode: WorkEpisode,
) {
  const dates = new Set(episode.dsmDates.map(dsmDateToYmd));
  return dates.has(eventDateWib(timestamp));
}

function startsWithActor(text: string, username: string) {
  const firstLine = text.split('\n')[0]?.trim().toLowerCase() ?? '';
  return firstLine === username.trim().toLowerCase();
}

function resolveEpisodeResults(
  episodes: WorkEpisode[],
  graphs: Map<string, WorkGraph>,
  githubUsername: string,
): EpisodeResult[] {
  const results: EpisodeResult[] = [];

  const episodesByRoot = new Map<string, WorkEpisode[]>();
  for (const episode of episodes) {
    const current = episodesByRoot.get(episode.rootUrl) ?? [];
    current.push(episode);
    episodesByRoot.set(episode.rootUrl, current);
  }

  for (const [rootUrl, rootEpisodes] of episodesByRoot) {
    const graph =
      graphs.get(rootUrl) ??
      ({
        rootUrl,
        nodes: [],
        events: [],
        errors: ['Work graph tidak tersedia.'],
      } satisfies WorkGraph);

    const statusPairs = buildStatusPairs(graph);
    const usedPairs = new Set<string>();

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

    for (const episode of rootEpisodes) {
      const matchingPairs = statusPairs.filter((pair) => {
        if (usedPairs.has(pair.key)) return false;

        return (
          eventBelongsToEpisode(pair.startIso, episode) ||
          eventBelongsToEpisode(pair.endIso, episode)
        );
      });

      if (matchingPairs.length > 0) {
        for (const pair of matchingPairs) {
          usedPairs.add(pair.key);
        }

        const startIso = matchingPairs
          .map((pair) => pair.startIso)
          .sort(
            (a, b) =>
              new Date(a).getTime() - new Date(b).getTime(),
          )[0];

        const endIso = matchingPairs
          .map((pair) => pair.endIso)
          .sort(
            (a, b) =>
              new Date(b).getTime() - new Date(a).getTime(),
          )[0];

        const statusSourceUrls = uniqueStrings(
          matchingPairs.map((pair) => pair.sourceUrl),
        );

        const timeSource: TimeSource =
          statusSourceUrls.length === 1 &&
          statusSourceUrls[0] === rootUrl
            ? 'ROOT_ISSUE_STATUS'
            : 'RELATED_ISSUE_STATUS';

        results.push({
          episodeId: episode.id,
          rootUrl,
          startIso,
          endIso,
          timeSource,
          statusSourceUrls,
          activitySourceUrls: [],
          relatedIssueUrls,
          relatedPrUrls,
          graphErrors: graph.errors,
        });

        continue;
      }

      const prEvents = graph.events
        .filter(
          (event) =>
            episode.dsmDates.length === 1 &&
            event.sourceKind === 'pull' &&
            startsWithActor(event.text, githubUsername) &&
            eventBelongsToEpisode(event.timestamp, episode),
        )
        .sort(
          (a, b) =>
            new Date(a.timestamp).getTime() -
            new Date(b.timestamp).getTime(),
        );

      const uniqueActivity = Array.from(
        new Map(
          prEvents.map((event) => [
            `${event.sourceUrl}|${event.timestamp}|${event.text.replace(/\s+/g, ' ')}`,
            event,
          ]),
        ).values(),
      );

      if (uniqueActivity.length >= 2) {
        results.push({
          episodeId: episode.id,
          rootUrl,
          startIso: uniqueActivity[0].timestamp,
          endIso: uniqueActivity[uniqueActivity.length - 1].timestamp,
          timeSource: 'RELATED_PR_ACTIVITY',
          statusSourceUrls: [],
          activitySourceUrls: uniqueStrings(
            uniqueActivity.map((event) => event.sourceUrl),
          ),
          relatedIssueUrls,
          relatedPrUrls,
          graphErrors: graph.errors,
        });

        continue;
      }

      if (uniqueActivity.length === 1) {
        results.push({
          episodeId: episode.id,
          rootUrl,
          startIso: uniqueActivity[0].timestamp,
          endIso: null,
          timeSource: 'PR_ACTIVITY_PARTIAL',
          statusSourceUrls: [],
          activitySourceUrls: [uniqueActivity[0].sourceUrl],
          relatedIssueUrls,
          relatedPrUrls,
          graphErrors: graph.errors,
        });

        continue;
      }

      results.push({
        episodeId: episode.id,
        rootUrl,
        startIso: null,
        endIso: null,
        timeSource: 'DSM_ONLY',
        statusSourceUrls: [],
        activitySourceUrls: [],
        relatedIssueUrls,
        relatedPrUrls,
        graphErrors: graph.errors,
      });
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

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
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

function calculateHours(startIso: string | null, endIso: string | null) {
  if (!startIso || !endIso) return '';

  const hours =
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000;

  return Number(hours.toFixed(10));
}

function workbookFileName(episodes: WorkEpisode[]) {
  const firstDate = episodes[0]?.date ?? '';
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

async function buildAndDownload(
  episodes: WorkEpisode[],
  results: EpisodeResult[],
) {
  const resultByEpisode = new Map(
    results.map((result) => [result.episodeId, result]),
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

  const rows = episodes.map((episode) => {
    const result = resultByEpisode.get(episode.id);

    return [
      episode.assignee,
      episode.systemType,
      episode.ticketTitle,
      episode.rootUrl,
      episode.ticketType,
      episode.status,
      episode.priority,
      episode.date,
      episode.week,
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

  const diagnostics = [
    [
      'Episode ID',
      'Root Ticket',
      'DSM Dates',
      'DSM Statuses',
      'DSM Times',
      'Time Source',
      'Status Sources',
      'Activity Sources',
      'Related Issues',
      'Related PRs',
      'Start ISO',
      'End ISO',
      'Graph Errors',
    ],
    ...episodes.map((episode) => {
      const result = resultByEpisode.get(episode.id);

      return [
        episode.id,
        episode.rootUrl,
        episode.dsmDates.join(', '),
        episode.dsmStatuses.join(' -> '),
        episode.dsmTimes.join(', '),
        result?.timeSource ?? 'DSM_ONLY',
        result?.statusSourceUrls.join('\n') ?? '',
        result?.activitySourceUrls.join('\n') ?? '',
        result?.relatedIssueUrls.join('\n') ?? '',
        result?.relatedPrUrls.join('\n') ?? '',
        result?.startIso ?? '',
        result?.endIso ?? '',
        result?.graphErrors.join('\n') ?? '',
      ];
    }),
  ];

  const diagnosticsSheet = XLSX.utils.aoa_to_sheet(diagnostics);
  diagnosticsSheet['!cols'] = [
    { wch: 38 },
    { wch: 58 },
    { wch: 24 },
    { wch: 34 },
    { wch: 20 },
    { wch: 26 },
    { wch: 58 },
    { wch: 58 },
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
    url: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`,
    filename: workbookFileName(episodes),
    saveAs: true,
  });
}

async function runJob(
  tasks: DsmTask[],
  githubUsername: string,
) {
  inMemoryRunning = true;

  const episodes = buildWorkEpisodes(tasks);
  const rootUrls = uniqueStrings(
    episodes.map((episode) => episode.rootUrl),
  );
  const graphs = new Map<string, WorkGraph>();

  await setState({
    running: true,
    current: 0,
    total: rootUrls.length,
    message: `Membangun work graph untuk ${rootUrls.length} root issue...`,
  });

  try {
    for (let index = 0; index < rootUrls.length; index += 1) {
      const rootUrl = rootUrls[index];

      await setState({
        running: true,
        current: index,
        total: rootUrls.length,
        currentUrl: rootUrl,
        message: `Crawl graph ${index + 1}/${rootUrls.length}`,
      });

      const graph = await crawlWorkGraph(rootUrl);
      graphs.set(rootUrl, graph);

      await setState({
        running: true,
        current: index + 1,
        total: rootUrls.length,
        currentUrl: rootUrl,
        message: `Selesai graph ${index + 1}/${rootUrls.length}`,
      });
    }

    const results = resolveEpisodeResults(
      episodes,
      graphs,
      githubUsername,
    );

    const downloadId = await buildAndDownload(episodes, results);

    const completeCount = results.filter(
      (result) => result.startIso && result.endIso,
    ).length;

    await setState({
      running: false,
      current: rootUrls.length,
      total: rootUrls.length,
      message:
        `Selesai. ${episodes.length} work episode dibuat; ` +
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
      void getState().then((state) => sendResponse({ state }));
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
