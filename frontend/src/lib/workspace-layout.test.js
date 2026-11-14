import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  LAYOUT_BOUNDS,
  clamp,
  sanitizeLayout,
  repositionPanelSlot,
  enforceResponsiveBounds,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
  resetWorkspaceLayout,
  STORAGE_KEY,
} from './workspace-layout.js';

describe('Workspace Layout Manager', () => {
  test('clamp safely constrains numbers and handles fallbacks', () => {
    assert.equal(clamp(200, 280, 700, 380), 280);
    assert.equal(clamp(900, 280, 700, 380), 700);
    assert.equal(clamp(500, 280, 700, 380), 500);
    assert.equal(clamp(NaN, 280, 700, 380), 380);
    assert.equal(clamp(undefined, 280, 700, 380), 380);
  });

  test('loadWorkspaceLayout returns default layout when store is empty', () => {
    const mockStore = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };

    const layout = loadWorkspaceLayout(mockStore);
    assert.deepEqual(layout, { ...DEFAULT_WORKSPACE_LAYOUT });
  });

  test('loadWorkspaceLayout handles corrupted JSON gracefully', () => {
    const mockStore = {
      getItem: () => '{corrupted json',
      setItem: () => {},
      removeItem: () => {},
    };

    const layout = loadWorkspaceLayout(mockStore);
    assert.deepEqual(layout, { ...DEFAULT_WORKSPACE_LAYOUT });
  });

  test('sanitizeLayout clamps out-of-bound dimensions safely', () => {
    const dirty = {
      leftPanelWidth: 99999, // Should clamp to max 700
      mfgPanelWidth: 10,     // Should clamp to min 320
      costPanelHeight: -50,  // Should clamp to min 160
      isLeftPanelDocked: false,
      isManufacturingActive: true,
      leftPanelFloatingPos: { x: -20, y: 100 }, // x clamped to >= 0
      contextualPanelSlot: 'invalid_slot',
    };

    const sanitized = sanitizeLayout(dirty);
    assert.equal(sanitized.leftPanelWidth, 700);
    assert.equal(sanitized.mfgPanelWidth, 320);
    assert.equal(sanitized.costPanelHeight, 160);
    assert.equal(sanitized.isLeftPanelDocked, false);
    assert.equal(sanitized.leftPanelFloatingPos.x, 0);
    assert.equal(sanitized.leftPanelFloatingPos.y, 100);
    assert.equal(sanitized.contextualPanelSlot, 'left');
  });

  test('repositionPanelSlot swaps panel slots cleanly without overlap', () => {
    const initial = {
      contextualPanelSlot: 'left',
      mfgPanelSlot: 'right',
      costPanelSlot: 'bottom',
    };

    // Move manufacturing from right to left -> contextual must swap to right
    const swapped = repositionPanelSlot(initial, 'manufacturing', 'left');
    assert.equal(swapped.mfgPanelSlot, 'left');
    assert.equal(swapped.contextualPanelSlot, 'right');
    assert.equal(swapped.costPanelSlot, 'bottom');

    // Move cost to right -> contextual (currently on right) must swap to bottom
    const swapped2 = repositionPanelSlot(swapped, 'cost', 'right');
    assert.equal(swapped2.costPanelSlot, 'right');
    assert.equal(swapped2.contextualPanelSlot, 'bottom');
    assert.equal(swapped2.mfgPanelSlot, 'left');

    // Move panel to floating -> no swap needed, remains floating
    const floated = repositionPanelSlot(swapped2, 'mfgPanelSlot' ? 'manufacturing' : 'manufacturing', 'floating');
    assert.equal(floated.mfgPanelSlot, 'floating');
    assert.equal(floated.costPanelSlot, 'right');
    assert.equal(floated.contextualPanelSlot, 'bottom');
  });

  test('enforceResponsiveBounds prevents crushing workspace when window is narrow', () => {
    const layout = {
      leftPanelWidth: 600,
      mfgPanelWidth: 600,
      costPanelHeight: 400,
      contextualPanelSlot: 'left',
      mfgPanelSlot: 'right',
    };

    // In a 1000px window, 600 + 600 = 1200 would crush the 3D workspace.
    // Minimum workspace is 320px, so max total panels width is 680px.
    const bounded = enforceResponsiveBounds(layout, 1000, 700);
    assert(bounded.leftPanelWidth + bounded.mfgPanelWidth <= 680);
    assert(bounded.leftPanelWidth >= LAYOUT_BOUNDS.leftPanelWidth.min);
    assert(bounded.mfgPanelWidth >= LAYOUT_BOUNDS.mfgPanelWidth.min);
  });

  test('saveWorkspaceLayout serializes correctly to storage', () => {
    let savedKey = null;
    let savedVal = null;

    const mockStore = {
      getItem: () => null,
      setItem: (key, val) => {
        savedKey = key;
        savedVal = val;
      },
      removeItem: () => {},
    };

    saveWorkspaceLayout({ leftPanelWidth: 410, isLeftPanelDocked: false }, mockStore);
    assert.equal(savedKey, STORAGE_KEY);
    const parsed = JSON.parse(savedVal);
    assert.equal(parsed.leftPanelWidth, 410);
    assert.equal(parsed.isLeftPanelDocked, false);
  });

  test('resetWorkspaceLayout purges storage and restores defaults', () => {
    let removedKey = null;
    const mockStore = {
      getItem: () => null,
      setItem: () => {},
      removeItem: (key) => {
        removedKey = key;
      },
    };

    const layout = resetWorkspaceLayout(mockStore);
    assert.equal(removedKey, STORAGE_KEY);
    assert.deepEqual(layout, { ...DEFAULT_WORKSPACE_LAYOUT });
  });
});
