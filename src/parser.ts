import type { DsmTask } from './types';

const MONTHS: Record<string, number> = {
  januari: 1,
  january: 1,
  februari: 2,
  february: 2,
  maret: 3,
  march: 3,
  april: 4,
  mei: 5,
  may: 5,
  juni: 6,
  june: 6,
  juli: 7,
  july: 7,
  agustus: 8,
  august: 8,
  september: 9,
  oktober: 10,
  october: 10,
  november: 11,
  desember: 12,
  december: 12,
};

type DraftTask = {
  title: string;
  url: string;
  status: string;
  date: string;
  meetingTime: string;
};

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function parseDateLine(line: string): { date: string; time: string } | null {
  const match = line.match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+Pukul\s+(\d{1,2})[.:](\d{2}))?/i,
  );

  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];
  const year = Number(match[3]);

  if (!month) return null;

  const time =
    match[4] && match[5]
      ? `${pad(Number(match[4]))}:${match[5]}`
      : '';

  return {
    date: `${pad(day)}-${pad(month)}-${year}`,
    time,
  };
}

function getWeek(date: string) {
  const day = Number(date.slice(0, 2));
  return `Minggu ${Math.floor((day - 1) / 7) + 1}`;
}

function getSystemType(title: string) {
  const bracket = title.match(/^\s*\[([^\]]+)\]/)?.[1] ?? '';
  if (!bracket) return '';
  return bracket.split('-')[0].trim();
}

function getTicketType(title: string) {
  const afterBracket = title.includes(']')
    ? title.slice(title.indexOf(']') + 1)
    : title;

  return (
    afterBracket
      .match(/^\s*([A-Za-z0-9 _-]+?)\s*[:;]/)?.[1]
      ?.trim()
      .toUpperCase() ?? ''
  );
}

function looksLikeName(line: string, nextLine?: string) {
  if (!nextLine || !/^Task\s+\d+/i.test(nextLine)) return false;
  if (line.length > 60) return false;
  if (/^Task\s+/i.test(line)) return false;
  if (/GitHub|Status|Yang |Kendala|DAILY STANDUP|={2,}/i.test(line)) {
    return false;
  }
  return /^[A-Za-z][A-Za-z .'-]*$/.test(line);
}

function shouldAppendTitle(line: string) {
  return !/^(?:[●○•-]|GitHub\s*:|Status\s*:|Yang sudah|Yang akan|Kendala\s*:)/i.test(
    line,
  );
}

function toComparableDate(date: string) {
  const [day, month, year] = date.split('-');
  return `${year}-${month}-${day}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function parseDsmText(rawText: string, wantedAssignee: string): DsmTask[] {
  const lines = rawText
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const wanted = wantedAssignee.trim().toLowerCase();
  let currentDate = '';
  let currentMeetingTime = '';
  let currentPerson = '';
  let currentTask: DraftTask | null = null;

  const occurrences: DsmTask[] = [];

  const flushTask = () => {
    if (!currentTask?.url || !currentTask.title || !currentTask.date) {
      currentTask = null;
      return;
    }

    occurrences.push({
      assignee: wantedAssignee.trim(),
      systemType: getSystemType(currentTask.title),
      ticketTitle: currentTask.title.trim(),
      ticketUrl: currentTask.url,
      ticketType: getTicketType(currentTask.title),
      status: currentTask.status.trim(),
      priority: '',
      date: currentTask.date,
      week: getWeek(currentTask.date),
      dsmStatuses: currentTask.status.trim()
        ? [currentTask.status.trim()]
        : [],
      dsmTimes: currentTask.meetingTime
        ? [currentTask.meetingTime]
        : [],
    });

    currentTask = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1];

    const parsedDate = parseDateLine(line);
    if (parsedDate) {
      flushTask();
      currentDate = parsedDate.date;
      currentMeetingTime = parsedDate.time;
      continue;
    }

    if (looksLikeName(line, nextLine)) {
      flushTask();
      currentPerson = line.trim();
      continue;
    }

    const taskMatch = line.match(/^Task\s+\d+\s*\|\s*(.+)$/i);
    if (taskMatch) {
      flushTask();

      if (currentPerson.toLowerCase() === wanted) {
        currentTask = {
          title: taskMatch[1].trim(),
          url: '',
          status: '',
          date: currentDate,
          meetingTime: currentMeetingTime,
        };
      }

      continue;
    }

    if (!currentTask) continue;

    const githubMatch = line.match(
      /GitHub\s*:?[\s]*((?:https?:\/\/)?github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+)/i,
    );

    if (githubMatch) {
      currentTask.url = githubMatch[1].startsWith('http')
        ? githubMatch[1]
        : `https://${githubMatch[1]}`;
      continue;
    }

    const statusMatch = line.match(/Status\s*:\s*(.+)$/i);
    if (statusMatch) {
      currentTask.status = statusMatch[1].trim();
      continue;
    }

    if (!currentTask.url && shouldAppendTitle(line)) {
      currentTask.title = `${currentTask.title} ${line}`.trim();
    }
  }

  flushTask();

  // Satu URL boleh muncul berkali-kali dalam sebulan.
  // Yang digabung hanya kemunculan pada URL + tanggal yang sama (mis. DSM 11.00 dan 16.00).
  const daily = new Map<string, DsmTask>();

  for (const task of occurrences) {
    const key = `${task.ticketUrl}|${task.date}`;
    const existing = daily.get(key);

    if (!existing) {
      daily.set(key, task);
      continue;
    }

    daily.set(key, {
      ...existing,
      ticketTitle:
        task.ticketTitle.length > existing.ticketTitle.length
          ? task.ticketTitle
          : existing.ticketTitle,
      systemType: existing.systemType || task.systemType,
      ticketType: existing.ticketType || task.ticketType,
      status: task.status || existing.status,
      dsmStatuses: uniqueStrings([
        ...existing.dsmStatuses,
        ...task.dsmStatuses,
      ]),
      dsmTimes: uniqueStrings([
        ...existing.dsmTimes,
        ...task.dsmTimes,
      ]),
    });
  }

  return [...daily.values()].sort((a, b) => {
    const dateCompare = toComparableDate(a.date).localeCompare(
      toComparableDate(b.date),
    );

    if (dateCompare !== 0) return dateCompare;
    return a.ticketUrl.localeCompare(b.ticketUrl);
  });
}
