import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { recoverAgentJobs } from '../agent/job-queue.js';
import { normalizeConversation } from '../agent/conversation-context.js';

const STATE_PATH = 'memory/state.json';
const TIMELINE_PATH = 'memory/timeline.md';
const FACTS_PATH = 'memory/facts.json';
const EVIDENCE_PATH = 'memory/evidence.json';
const AGENT_JOBS_PATH = 'memory/agent-jobs.json';
const CONVERSATION_PATH = 'memory/conversation.json';
const WEB_STORAGE_KEY = 'my-life-community.memory.v1';

export const isNativeApp = Capacitor.isNativePlatform();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(value, fallback) {
  if (!value || typeof value !== 'object') return clone(fallback);

  return {
    version: 2,
    profile: value.profile ?? fallback.profile,
    timeline: Array.isArray(value.timeline) ? value.timeline : [],
    peopleEntries: Array.isArray(value.peopleEntries) ? value.peopleEntries : [],
    placeEntries: Array.isArray(value.placeEntries) ? value.placeEntries : [],
    facts: Array.isArray(value.facts) ? value.facts : [],
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    conversation: normalizeConversation(value.conversation ?? fallback.conversation),
    agentJobs: recoverAgentJobs(value.agentJobs),
    updatedAt: value.updatedAt ?? null,
  };
}

async function ensureDirectory(path, directory) {
  try {
    await Filesystem.mkdir({ path, directory, recursive: true });
  } catch {
    // Existing directories are already ready for use.
  }
}

export function timelineToMarkdown(timeline) {
  const sections = timeline.map((entry) => [
    `## ${entry.time}`,
    '',
    entry.text,
    '',
  ].join('\n'));

  return ['# 我的一生', '', ...sections].join('\n').trimEnd() + '\n';
}

export async function loadMemoryState(fallback) {
  if (!isNativeApp) {
    const saved = window.localStorage.getItem(WEB_STORAGE_KEY);
    if (!saved) return clone(fallback);

    try {
      return normalizeState(JSON.parse(saved), fallback);
    } catch {
      return clone(fallback);
    }
  }

  try {
    const result = await Filesystem.readFile({
      path: STATE_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    return normalizeState(JSON.parse(String(result.data)), fallback);
  } catch {
    return clone(fallback);
  }
}

export async function persistMemoryState(state) {
  const snapshot = {
    ...state,
    version: 2,
    updatedAt: new Date().toISOString(),
  };

  if (!isNativeApp) {
    window.localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(snapshot));
    return snapshot;
  }

  await ensureDirectory('memory', Directory.Data);
  await Promise.all([
    Filesystem.writeFile({
      path: STATE_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: JSON.stringify(snapshot, null, 2),
    }),
    Filesystem.writeFile({
      path: TIMELINE_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: timelineToMarkdown(snapshot.timeline),
    }),
    Filesystem.writeFile({
      path: FACTS_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: JSON.stringify(snapshot.facts, null, 2),
    }),
    Filesystem.writeFile({
      path: EVIDENCE_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: JSON.stringify(snapshot.evidence, null, 2),
    }),
    Filesystem.writeFile({
      path: AGENT_JOBS_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: JSON.stringify(snapshot.agentJobs ?? [], null, 2),
    }),
    Filesystem.writeFile({
      path: CONVERSATION_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: JSON.stringify(snapshot.conversation ?? normalizeConversation(null), null, 2),
    }),
  ]);

  return snapshot;
}

function downloadWebFile(contents, filename, mimeType) {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const EXPORT_COPY = {
  'zh-CN': {
    lifeTitle: '我的一生',
    peopleTitle: '我认识的人',
    placesTitle: '我去过的地方',
    untitled: '还没有标题',
    lifeSlug: '我的一生',
    peopleSlug: '我认识的人',
    placesSlug: '我去过的地方',
    backupSlug: '我的一生-完整备份',
    backupTitle: '完整备份（含录音）',
    backupDialog: '保存完整备份和录音',
    markdownDialog: '导出 Markdown',
  },
  'zh-TW': {
    lifeTitle: '我的一生',
    peopleTitle: '我認識的人',
    placesTitle: '我去過的地方',
    untitled: '還沒有標題',
    lifeSlug: '我的一生',
    peopleSlug: '我認識的人',
    placesSlug: '我去過的地方',
    backupSlug: '我的一生-完整備份',
    backupTitle: '完整備份（含錄音）',
    backupDialog: '儲存完整備份和錄音',
    markdownDialog: '匯出 Markdown',
  },
  en: {
    lifeTitle: 'My Life',
    peopleTitle: 'People I Know',
    placesTitle: 'Places I Have Been',
    untitled: 'Untitled',
    lifeSlug: 'my-life',
    peopleSlug: 'people-i-know',
    placesSlug: 'places-i-have-been',
    backupSlug: 'my-life-full-backup',
    backupTitle: 'Full backup (with recordings)',
    backupDialog: 'Save full backup and recordings',
    markdownDialog: 'Export Markdown',
  },
};

function exportCopy(locale) {
  return EXPORT_COPY[locale] ?? EXPORT_COPY['zh-CN'];
}

function entriesToMarkdown(title, entries, untitled) {
  const sections = entries.map((entry) => [
    `## ${String(entry.time || untitled).trim()}`,
    '',
    String(entry.text || '').trim(),
    '',
  ].join('\n'));

  return [`# ${title}`, '', ...sections].join('\n').trimEnd() + '\n';
}

export function sectionToMarkdown(state, section, locale = 'zh-CN') {
  const copy = exportCopy(locale);
  if (section === 'life') {
    return entriesToMarkdown(copy.lifeTitle, state.timeline ?? [], copy.untitled);
  }
  if (section === 'people') {
    return entriesToMarkdown(copy.peopleTitle, state.peopleEntries ?? [], copy.untitled);
  }
  if (section === 'places') {
    return entriesToMarkdown(copy.placesTitle, state.placeEntries ?? [], copy.untitled);
  }
  throw new Error(`unsupported-markdown-section:${section}`);
}

export async function exportFullBackup(state, locale = 'zh-CN') {
  const date = new Date().toISOString().slice(0, 10);
  const copy = exportCopy(locale);
  const filename = `${copy.backupSlug}-${date}.json`;
  const backup = JSON.stringify({
    exportedAt: new Date().toISOString(),
    timelineMarkdown: sectionToMarkdown(state, 'life', locale),
    ...state,
  }, null, 2);

  if (!isNativeApp) {
    downloadWebFile(backup, filename, 'application/json');
    return;
  }

  await ensureDirectory('exports', Directory.Cache);
  await Filesystem.writeFile({
    path: `exports/${filename}`,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    data: backup,
  });
  const backupFile = await Filesystem.getUri({
    path: `exports/${filename}`,
    directory: Directory.Cache,
  });
  const audioFiles = state.evidence
    .map((entry) => entry.audioUri)
    .filter((uri) => typeof uri === 'string' && uri.length > 0);

  await Share.share({
    title: copy.backupTitle,
    dialogTitle: copy.backupDialog,
    files: [backupFile.uri, ...audioFiles],
  });
}

export async function exportSectionMarkdown(state, section, locale = 'zh-CN') {
  const date = new Date().toISOString().slice(0, 10);
  const copy = exportCopy(locale);
  const slugs = {
    life: copy.lifeSlug,
    people: copy.peopleSlug,
    places: copy.placesSlug,
  };
  const filename = `${slugs[section] ?? section}-${date}.md`;
  const markdown = sectionToMarkdown(state, section, locale);

  if (!isNativeApp) {
    downloadWebFile(markdown, filename, 'text/markdown');
    return;
  }

  await ensureDirectory('exports', Directory.Cache);
  await Filesystem.writeFile({
    path: `exports/${filename}`,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    data: markdown,
  });
  const markdownFile = await Filesystem.getUri({
    path: `exports/${filename}`,
    directory: Directory.Cache,
  });
  await Share.share({
    title: filename,
    dialogTitle: copy.markdownDialog,
    files: [markdownFile.uri],
  });
}
