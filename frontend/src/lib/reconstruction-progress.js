export const RECONSTRUCTION_STAGES = Object.freeze([
  { id: 'image-analysis', label: 'Image Analysis', weight: 12 },
  { id: 'geometry-extraction', label: 'Geometry Extraction', weight: 18 },
  { id: 'dataset-matching', label: 'Dataset Matching', weight: 12 },
  { id: 'gemini-reconstruction', label: 'Gemini Reconstruction', weight: 28 },
  { id: 'mesh-generation', label: 'Mesh Generation', weight: 20 },
  { id: 'validation', label: 'Validation', weight: 10 },
]);

const STAGE_BY_ID = new Map(RECONSTRUCTION_STAGES.map((stage) => [stage.id, stage]));
const TOTAL_WEIGHT = RECONSTRUCTION_STAGES.reduce((sum, stage) => sum + stage.weight, 0);

export const RECONSTRUCTION_IDLE = 'idle';
export const RECONSTRUCTION_RUNNING = 'running';
export const RECONSTRUCTION_FAILED = 'failed';
export const RECONSTRUCTION_CANCELLED = 'cancelled';
export const RECONSTRUCTION_COMPLETE = 'complete';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createReconstructionProgress(attempt = 1, status = RECONSTRUCTION_RUNNING) {
  return {
    attempt,
    status,
    percent: 0,
    stageStatuses: {},
    currentStage: RECONSTRUCTION_STAGES[0].id,
    message: '',
  };
}

export function getReconstructionStageLabel(stageId) {
  return STAGE_BY_ID.get(stageId)?.label || (stageId ? String(stageId) : 'Reconstruction');
}

function calculatePercent(stageStatuses) {
  let earned = 0;
  for (const stage of RECONSTRUCTION_STAGES) {
    const state = stageStatuses[stage.id];
    if (!state) continue;
    if (state.status === RECONSTRUCTION_COMPLETE || state.status === 'skipped') {
      earned += stage.weight;
      continue;
    }
    if (state.status === RECONSTRUCTION_RUNNING && state.total > 0) {
      const fraction = clamp(state.completed / state.total, 0, 0.99);
      earned += stage.weight * fraction;
    }
  }
  return Math.round(clamp((earned / TOTAL_WEIGHT) * 100, 0, 100));
}

function findCurrentStage(stageStatuses) {
  const running = RECONSTRUCTION_STAGES.find((stage) => stageStatuses[stage.id]?.status === RECONSTRUCTION_RUNNING);
  if (running) return running.id;
  const pending = RECONSTRUCTION_STAGES.find((stage) => {
    const status = stageStatuses[stage.id]?.status;
    return !status || (status !== RECONSTRUCTION_COMPLETE && status !== 'skipped' && status !== RECONSTRUCTION_FAILED);
  });
  return (pending || RECONSTRUCTION_STAGES[RECONSTRUCTION_STAGES.length - 1]).id;
}

/**
 * Reduces real pipeline events into display state. Percentages are weighted by
 * completed stages/tasks only; no wall-clock estimates are involved.
 */
export function applyReconstructionEvent(previous = createReconstructionProgress(), event = {}) {
  const attempt = event.attempt || previous.attempt || 1;
  let state = attempt === previous.attempt
    ? { ...previous, stageStatuses: { ...previous.stageStatuses } }
    : createReconstructionProgress(attempt, RECONSTRUCTION_RUNNING);

  if (event.type === 'cancelled') {
    return {
      ...state,
      status: RECONSTRUCTION_CANCELLED,
      message: event.message || 'Reconstruction cancelled.',
    };
  }

  if (event.type === 'failed') {
    return {
      ...state,
      status: RECONSTRUCTION_FAILED,
      message: event.message || 'Reconstruction failed.',
    };
  }

  const stageId = event.stage;
  if (!stageId || !STAGE_BY_ID.has(stageId)) return state;

  const status = event.status || RECONSTRUCTION_RUNNING;
  const completed = Number(event.completed);
  const total = Number(event.total);

  state.stageStatuses[stageId] = {
    status,
    ...(Number.isFinite(completed) ? { completed } : {}),
    ...(Number.isFinite(total) && total > 0 ? { total } : {}),
  };

  const nextPercent = calculatePercent(state.stageStatuses);
  state.percent = status === RECONSTRUCTION_FAILED
    ? previous.percent
    : Math.max(previous.attempt === attempt ? previous.percent : 0, nextPercent);
  state.currentStage = stageId;

  if (status === RECONSTRUCTION_FAILED) {
    state.status = RECONSTRUCTION_FAILED;
    state.message = event.message || `${getReconstructionStageLabel(stageId)} failed.`;
  } else {
    state.status = RECONSTRUCTION_RUNNING;
    state.message = event.message || '';
  }

  const allComplete = RECONSTRUCTION_STAGES.every((stage) => {
    const stageState = state.stageStatuses[stage.id];
    return stageState && (stageState.status === RECONSTRUCTION_COMPLETE || stageState.status === 'skipped');
  });
  if (allComplete) {
    state.status = RECONSTRUCTION_COMPLETE;
    state.percent = 100;
    state.currentStage = RECONSTRUCTION_STAGES[RECONSTRUCTION_STAGES.length - 1].id;
    state.message = event.message || 'Model generated and validated.';
  }

  state.currentStage = state.status === RECONSTRUCTION_COMPLETE
    ? state.currentStage
    : findCurrentStage(state.stageStatuses);

  return state;
}
