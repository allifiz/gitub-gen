import * as mammoth from 'mammoth';
import { parseDsmText } from './parser';
import type { DsmTask, JobState } from './types';

const assigneeInput = document.querySelector<HTMLInputElement>('#assignee')!;
const githubUsernameInput =
  document.querySelector<HTMLInputElement>('#githubUsername')!;
const fileInput = document.querySelector<HTMLInputElement>('#dsmFile')!;
const generateButton = document.querySelector<HTMLButtonElement>('#generate')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const detailEl = document.querySelector<HTMLElement>('#detail')!;
const progressBar = document.querySelector<HTMLElement>('#progressBar')!;
const previewCard = document.querySelector<HTMLElement>('#previewCard')!;
const issueCount = document.querySelector<HTMLElement>('#issueCount')!;
const preview = document.querySelector<HTMLElement>('#preview')!;

let parsedTasks: DsmTask[] = [];
let running = false;

function setProgress(state: JobState) {
  running = state.running;
  generateButton.disabled = running || !fileInput.files?.[0];

  const percent =
    state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;

  progressBar.style.width = `${percent}%`;
  statusEl.textContent = state.running
    ? `Memproses ${state.current}/${state.total}`
    : state.message;
  detailEl.textContent = state.currentUrl
    ? state.currentUrl
    : state.message;
}

function renderPreview(tasks: DsmTask[]) {
  previewCard.classList.remove('hidden');
  issueCount.textContent = String(tasks.length);
  preview.replaceChildren();

  for (const task of tasks.slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'preview-item';

    const title = document.createElement('strong');
    title.textContent = task.ticketTitle;

    const meta = document.createElement('span');
    meta.textContent = `${task.date} · ${task.status || 'status kosong'}`;

    item.append(title, meta);
    preview.append(item);
  }

  if (tasks.length > 8) {
    const more = document.createElement('div');
    more.className = 'preview-item';

    const text = document.createElement('span');
    text.textContent = `+${tasks.length - 8} issue lainnya`;

    more.append(text);
    preview.append(more);
  }
}

async function parseSelectedFile() {
  const file = fileInput.files?.[0];

  if (!file) {
    parsedTasks = [];
    generateButton.disabled = true;
    previewCard.classList.add('hidden');
    statusEl.textContent = 'Pilih file DSM.';
    detailEl.textContent = 'Belum ada job.';
    return;
  }

  statusEl.textContent = 'Membaca DSM...';
  detailEl.textContent = file.name;
  generateButton.disabled = true;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer });

    parsedTasks = parseDsmText(value, assigneeInput.value || 'Allief');

    if (parsedTasks.length === 0) {
      throw new Error(
        `Tidak menemukan GitHub issue untuk assignee "${assigneeInput.value}".`,
      );
    }

    renderPreview(parsedTasks);
    statusEl.textContent = 'Siap generate.';
    const uniqueRoots = new Set(parsedTasks.map((task) => task.ticketUrl)).size;
    detailEl.textContent =
      `${parsedTasks.length} entri harian dari ${uniqueRoots} root issue ditemukan.`;
    generateButton.disabled = running;
  } catch (error) {
    parsedTasks = [];
    statusEl.textContent = 'Gagal membaca DSM.';
    detailEl.textContent =
      error instanceof Error ? error.message : 'Unknown error';
    generateButton.disabled = true;
  }
}

fileInput.addEventListener('change', () => {
  void parseSelectedFile();
});

assigneeInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) {
    void parseSelectedFile();
  }
});

generateButton.addEventListener('click', async () => {
  if (running || parsedTasks.length === 0) return;

  generateButton.disabled = true;
  statusEl.textContent = 'Memulai browser automation...';
  detailEl.textContent =
    'Issue akan dibuka di background tab lalu ditutup otomatis.';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_JOB',
      tasks: parsedTasks,
      githubUsername:
        githubUsernameInput.value.trim() || 'allifgobimbel',
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Gagal memulai job.');
    }
  } catch (error) {
    statusEl.textContent = 'Gagal memulai.';
    detailEl.textContent =
      error instanceof Error ? error.message : 'Unknown error';
    generateButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'JOB_PROGRESS') {
    setProgress(message.state as JobState);
  }
});

async function restoreState() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_JOB_STATE',
    });

    if (response?.state) {
      setProgress(response.state as JobState);
    }
  } catch {
    // Background worker belum aktif. Halaman aplikasi tetap bisa digunakan.
  }
}

void restoreState();
