import * as XLSX from 'xlsx';
import type { DsmTask, JobState, TimelineResult } from './types';

const STATE_KEY = 'gitubGenJobState';


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
    // Popup mungkin sedang tertutup. State tetap disimpan.
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

async function scrapeTimelineInPage() {
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

  const bodyText = document.body?.innerText ?? '';
  const currentUrl = window.location.href;

  if (
    window.location.pathname.startsWith('/login') ||
    /sign in to github/i.test(bodyText) ||
    /page not found/i.test(bodyText)
  ) {
    return {
      ticketUrl: currentUrl,
      startIso: null,
      endIso: null,
      scrapeStatus: 'NO_ACCESS' as const,
      error: 'GitHub meminta login atau halaman tidak dapat diakses.',
    };
  }

  const events = Array.from(
    document.querySelectorAll<HTMLElement>('relative-time[datetime]'),
  )
    .map((element) => {
      const container =
        element.closest<HTMLElement>('.TimelineItem') ||
        element.closest<HTMLElement>('[data-testid]') ||
        element.parentElement?.parentElement?.parentElement;

      return {
        timestamp: element.getAttribute('datetime') ?? '',
        text: container?.innerText?.trim() ?? '',
      };
    })
    .filter((event) => event.timestamp && event.text);

  const deduped = Array.from(
    new Map(
      events.map((event) => [
        `${event.timestamp}|${event.text.replace(/\s+/g, ' ')}`,
        event,
      ]),
    ).values(),
  ).sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const start = deduped.find((event) =>
    /\bto\s+In Progress\b/i.test(event.text),
  );

  if (!start) {
    return {
      ticketUrl: currentUrl,
      startIso: null,
      endIso: null,
      scrapeStatus: 'NO_IN_PROGRESS' as const,
    };
  }

  const startMs = new Date(start.timestamp).getTime();

  const end = deduped.find(
    (event) =>
      /\bto\s+Ready to Review\b/i.test(event.text) &&
      new Date(event.timestamp).getTime() > startMs,
  );

  if (!end) {
    return {
      ticketUrl: currentUrl,
      startIso: start.timestamp,
      endIso: null,
      scrapeStatus: 'NO_READY_TO_REVIEW' as const,
    };
  }

  return {
    ticketUrl: currentUrl,
    startIso: start.timestamp,
    endIso: end.timestamp,
    scrapeStatus: 'OK' as const,
  };
}

async function scrapeIssue(ticketUrl: string): Promise<TimelineResult> {
  let tabId: number | undefined;

  try {
    const tab = await chrome.tabs.create({
      url: ticketUrl,
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
      func: scrapeTimelineInPage,
    });

    const result = injection[0]?.result as TimelineResult | undefined;

    if (!result) {
      throw new Error('Tidak mendapat hasil dari DOM GitHub.');
    }

    return {
      ...result,
      ticketUrl,
    };
  } catch (error) {
    return {
      ticketUrl,
      startIso: null,
      endIso: null,
      scrapeStatus: 'ERROR',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (typeof tabId === 'number') {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Tab mungkin sudah tertutup oleh user.
      }
    }
  }
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

async function buildAndDownload(
  tasks: DsmTask[],
  results: TimelineResult[],
) {
  const resultByUrl = new Map(results.map((result) => [result.ticketUrl, result]));

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
    const result = resultByUrl.get(task.ticketUrl);

    return [
      task.assignee,
      task.systemType,
      task.ticketTitle,
      task.ticketUrl,
      task.ticketType,
      task.status,
      task.priority,
      task.date,
      task.week,
      formatStartTime(result?.startIso ?? null),
      formatEndTime(result?.endIso ?? null),
      calculateHours(result?.startIso ?? null, result?.endIso ?? null),
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
    ['Ticket URL', 'Scrape Status', 'Start ISO', 'End ISO', 'Error'],
    ...results.map((result) => [
      result.ticketUrl,
      result.scrapeStatus,
      result.startIso ?? '',
      result.endIso ?? '',
      result.error ?? '',
    ]),
  ];

  const diagnosticsSheet = XLSX.utils.aoa_to_sheet(diagnostics);
  diagnosticsSheet['!cols'] = [
    { wch: 60 },
    { wch: 24 },
    { wch: 28 },
    { wch: 28 },
    { wch: 60 },
  ];
  XLSX.utils.book_append_sheet(workbook, diagnosticsSheet, 'Diagnostics');

  const base64 = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'base64',
  });

  const downloadId = await chrome.downloads.download({
    url: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`,
    filename: workbookFileName(tasks),
    saveAs: true,
  });

  return downloadId;
}

async function runJob(tasks: DsmTask[]) {
  inMemoryRunning = true;

  const results: TimelineResult[] = [];

  await setState({
    running: true,
    current: 0,
    total: tasks.length,
    message: 'Memulai scraping timeline GitHub...',
  });

  try {
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];

      await setState({
        running: true,
        current: index,
        total: tasks.length,
        currentUrl: task.ticketUrl,
        message: `Membuka issue ${index + 1}/${tasks.length}`,
      });

      const result = await scrapeIssue(task.ticketUrl);
      results.push(result);

      await setState({
        running: true,
        current: index + 1,
        total: tasks.length,
        currentUrl: task.ticketUrl,
        message: `Selesai ${index + 1}/${tasks.length}`,
      });
    }

    const downloadId = await buildAndDownload(tasks, results);

    const successCount = results.filter(
      (result) => result.scrapeStatus === 'OK',
    ).length;

    await setState({
      running: false,
      current: tasks.length,
      total: tasks.length,
      message: `Selesai. ${successCount}/${tasks.length} issue punya Start & End lengkap.`,
      finishedAt: new Date().toISOString(),
      downloadId,
    });
  } catch (error) {
    await setState({
      running: false,
      current: results.length,
      total: tasks.length,
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_JOB_STATE') {
    void getState().then((state) => sendResponse({ state }));
    return true;
  }

  if (message?.type === 'START_JOB') {
    void (async () => {
      const tasks = message.tasks as DsmTask[];

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
      void runJob(tasks);
    })();

    return true;
  }

  return undefined;
});
