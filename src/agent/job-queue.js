function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(now) {
  return typeof now === 'string' ? now : (now ?? new Date()).toISOString();
}

export function normalizeAgentJobs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((job) => job && typeof job.id === 'string' && typeof job.segmentId === 'string')
    .map((job) => ({
      ...job,
      status: job.status === 'running' ? 'pending' : job.status,
      attempts: Number.isInteger(job.attempts) ? job.attempts : 0,
    }));
}

export function recoverAgentJobs(value) {
  return normalizeAgentJobs(value).map((job) => job.status === 'failed'
    ? { ...job, status: 'pending' }
    : job);
}

export function createAgentJob({
  segmentId,
  evidenceId,
  transcript,
  section,
  selectedId = null,
  locale = 'zh-CN',
}, now) {
  if (!segmentId) throw new Error('agent-job-segment-required');
  const timestamp = nowIso(now);
  return {
    id: `agent-${segmentId}`,
    segmentId,
    evidenceId: evidenceId ?? null,
    transcript: String(transcript ?? '').trim(),
    section: section ?? 'life',
    selectedId,
    locale,
    status: 'pending',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    appliedAt: null,
    lastError: null,
  };
}

export function enqueueAgentJob(jobs, job) {
  const current = normalizeAgentJobs(jobs);
  if (current.some((candidate) => candidate.segmentId === job.segmentId)) return current;
  return [...current, clone(job)];
}

export function claimNextAgentJob(jobs, now) {
  const current = normalizeAgentJobs(jobs);
  const index = current.findIndex((job) => job.status === 'pending');
  if (index < 0) return { jobs: current, job: null };
  const timestamp = nowIso(now);
  current[index] = {
    ...current[index],
    status: 'running',
    attempts: current[index].attempts + 1,
    updatedAt: timestamp,
    lastError: null,
  };
  return { jobs: current, job: clone(current[index]) };
}

export function completeAgentJob(jobs, jobId, now) {
  const timestamp = nowIso(now);
  return normalizeAgentJobs(jobs).map((job) => job.id === jobId
    ? { ...job, status: 'applied', updatedAt: timestamp, appliedAt: timestamp, lastError: null }
    : job);
}

export function failAgentJob(jobs, jobId, error, { retry = true, now } = {}) {
  const timestamp = nowIso(now);
  return normalizeAgentJobs(jobs).map((job) => job.id === jobId
    ? {
        ...job,
        status: retry ? 'pending' : 'failed',
        updatedAt: timestamp,
        lastError: error instanceof Error ? error.message : String(error),
      }
    : job);
}

export function nextPendingAgentJob(jobs) {
  return normalizeAgentJobs(jobs).find((job) => job.status === 'pending') ?? null;
}
