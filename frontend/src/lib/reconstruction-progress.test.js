import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReconstructionEvent,
  createReconstructionProgress,
  getReconstructionStageLabel,
  RECONSTRUCTION_CANCELLED,
  RECONSTRUCTION_COMPLETE,
  RECONSTRUCTION_FAILED,
  RECONSTRUCTION_RUNNING,
} from './reconstruction-progress.js';

function completeStages(progress, stageIds) {
  return stageIds.reduce(
    (state, stage) => applyReconstructionEvent(state, { stage, status: 'complete' }),
    progress
  );
}

test('progress follows stage completion and reaches 100% only after validation', () => {
  let progress = createReconstructionProgress(1);
  assert.equal(progress.percent, 0);

  progress = applyReconstructionEvent(progress, {
    stage: 'image-analysis',
    status: 'running',
    completed: 0,
    total: 2,
  });
  assert.equal(progress.percent, 0);
  assert.equal(progress.currentStage, 'image-analysis');

  progress = applyReconstructionEvent(progress, {
    stage: 'image-analysis',
    status: 'running',
    completed: 1,
    total: 2,
  });
  assert.equal(progress.percent, 6);

  progress = applyReconstructionEvent(progress, {
    stage: 'image-analysis',
    status: 'complete',
    completed: 2,
    total: 2,
  });
  assert.equal(progress.percent, 12);

  progress = completeStages(progress, [
    'geometry-extraction',
    'dataset-matching',
    'gemini-reconstruction',
    'mesh-generation',
  ]);
  assert.equal(progress.percent, 90);
  assert.equal(progress.status, RECONSTRUCTION_RUNNING);
  assert.equal(progress.currentStage, 'validation');

  progress = applyReconstructionEvent(progress, { stage: 'validation', status: 'complete' });
  assert.equal(progress.percent, 100);
  assert.equal(progress.status, RECONSTRUCTION_COMPLETE);
});

test('skipped stages are credited but never shown as the active stage', () => {
  let progress = createReconstructionProgress(1);
  progress = applyReconstructionEvent(progress, { stage: 'image-analysis', status: 'complete' });
  progress = applyReconstructionEvent(progress, { stage: 'geometry-extraction', status: 'complete' });
  progress = applyReconstructionEvent(progress, {
    stage: 'dataset-matching',
    status: 'skipped',
    message: 'No companion gear supplied.',
  });
  assert.equal(progress.percent, 42);
  assert.notEqual(progress.currentStage, 'dataset-matching');
  assert.equal(progress.message, 'No companion gear supplied.');
});

test('dataset/vision resolution completes progress after Gemini is skipped', () => {
  let progress = createReconstructionProgress(1);
  progress = completeStages(progress, ['image-analysis', 'geometry-extraction', 'dataset-matching']);
  progress = applyReconstructionEvent(progress, {
    stage: 'gemini-reconstruction',
    status: 'skipped',
    message: 'Dataset match supplied geometry.',
  });
  assert.equal(progress.percent, 70);
  assert.equal(progress.status, RECONSTRUCTION_RUNNING);

  progress = applyReconstructionEvent(progress, { stage: 'mesh-generation', status: 'complete' });
  progress = applyReconstructionEvent(progress, { stage: 'validation', status: 'complete' });
  assert.equal(progress.percent, 100);
  assert.equal(progress.status, RECONSTRUCTION_COMPLETE);
});

test('failure keeps earned progress and retry resets the attempt', () => {
  let progress = createReconstructionProgress(1);
  progress = applyReconstructionEvent(progress, { stage: 'image-analysis', status: 'complete' });
  progress = applyReconstructionEvent(progress, {
    stage: 'geometry-extraction',
    status: 'failed',
    message: 'Vision service returned invalid data.',
  });
  assert.equal(progress.status, RECONSTRUCTION_FAILED);
  assert.equal(progress.percent, 12);
  assert.equal(progress.message, 'Vision service returned invalid data.');

  progress = applyReconstructionEvent(progress, { stage: 'image-analysis', status: 'running', attempt: 2 });
  assert.equal(progress.attempt, 2);
  assert.equal(progress.percent, 0);
  assert.equal(progress.status, RECONSTRUCTION_RUNNING);
});

test('cancellation is terminal and does not complete the model', () => {
  let progress = createReconstructionProgress(1);
  progress = applyReconstructionEvent(progress, { stage: 'image-analysis', status: 'complete' });
  progress = applyReconstructionEvent(progress, { type: 'cancelled', message: 'Stopped by user.' });
  assert.equal(progress.status, RECONSTRUCTION_CANCELLED);
  assert.equal(progress.percent, 12);
});

test('stage labels are human readable', () => {
  assert.equal(getReconstructionStageLabel('gemini-reconstruction'), 'Reconstructing Model');
  assert.equal(getReconstructionStageLabel('validation'), 'Validation');
});
