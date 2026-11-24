/**
 * workspace-layout.js
 * Persistent workspace layout configuration, bounds clamping, docking, and session storage.
 * Strictly frontend-only (persists to localStorage).
 */

export const STORAGE_KEY = 'reforge_workspace_layout_v3';

const IS_BROWSER = typeof window !== 'undefined';
const SCREEN_WIDTH = IS_BROWSER ? window.innerWidth : 1440;
const DEFAULT_MFG_WIDTH = Math.round(SCREEN_WIDTH * 0.40); // 2/5th (~40%) of available screen width

export const LAYOUT_BOUNDS = {
  leftPanelWidth: { min: 280, max: 700, default: 380 },
  mfgPanelWidth: { min: 320, max: 1400, default: DEFAULT_MFG_WIDTH },
  costPanelHeight: { min: 160, max: 550, default: 260 },
  pipWidth: { min: 280, max: 900, default: 420 },
  pipHeight: { min: 200, max: 700, default: 300 },
};

export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
  // Dimensions
  leftPanelWidth: 380,
  mfgPanelWidth: DEFAULT_MFG_WIDTH,
  costPanelHeight: 260,

  // Visibility / Active states
  isLeftPanelOpen: true,
  isManufacturingActive: false,
  isCostPanelCollapsed: false,

  // Docking slots ('left' | 'right' | 'bottom' | 'center' | 'floating')
  contextualPanelSlot: 'left',
  workspaceSlot: 'center',
  mfgPanelSlot: 'right',
  costPanelSlot: 'bottom',

  // Docking state legacy compatibility
  isLeftPanelDocked: true,
  isMfgPanelDocked: true,
  isCostPanelDocked: true,

  // Maximized states (one-at-a-time focus expansion)
  isLeftPanelMaximized: false,
  isMfgPanelMaximized: false,
  isCostPanelMaximized: false,
  isWorkspaceMaximized: false,

  // Floating Positions (for undocked windows)
  leftPanelFloatingPos: { x: 40, y: 70 },
  mfgPanelFloatingPos: { x: 700, y: 70 },
  costPanelFloatingPos: { x: 260, y: 380 },

  // PiP Viewer
  pipVisible: false,
  pipPos: { x: 750, y: 60 },
  pipSize: { width: 420, height: 300 },

  // Top Ribbon
  ribbonExpanded: true,
});

export function clamp(val, min, max, fallback) {
  if (typeof val !== 'number' || isNaN(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

function sanitizeCoordinate(coord, fallback) {
  if (!coord || typeof coord !== 'object') return fallback;
  const x = typeof coord.x === 'number' && !isNaN(coord.x) ? coord.x : fallback.x;
  const y = typeof coord.y === 'number' && !isNaN(coord.y) ? coord.y : fallback.y;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

function normalizePanelSlots(layout) {
  const slotKeys = {
    contextual: 'contextualPanelSlot',
    workspace: 'workspaceSlot',
    manufacturing: 'mfgPanelSlot',
    cost: 'costPanelSlot',
  };
  const defaults = {
    contextual: 'left',
    workspace: 'center',
    manufacturing: 'right',
    cost: 'bottom',
  };
  const dockSlots = ['left', 'right', 'bottom', 'center'];
  const priority = ['workspace', 'contextual', 'manufacturing', 'cost'];
  const used = new Set();

  priority.forEach((panelKey) => {
    const key = slotKeys[panelKey];
    const current = layout[key];
    if (current === 'floating') return; // floating is allowed; runtime may fallback
    const preferred = dockSlots.includes(current) ? current : defaults[panelKey];
    const candidates = [preferred, defaults[panelKey], ...dockSlots].filter((s, i, arr) => arr.indexOf(s) === i);
    const assigned = candidates.find((s) => !used.has(s)) || defaults[panelKey];
    layout[key] = assigned;
    used.add(assigned);
  });
}

export function sanitizeLayout(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }

  const validSlots = ['left', 'right', 'bottom', 'center', 'floating'];

  const layout = {
    leftPanelWidth: clamp(
      raw.leftPanelWidth,
      LAYOUT_BOUNDS.leftPanelWidth.min,
      LAYOUT_BOUNDS.leftPanelWidth.max,
      DEFAULT_WORKSPACE_LAYOUT.leftPanelWidth
    ),
    mfgPanelWidth: clamp(
      raw.mfgPanelWidth,
      LAYOUT_BOUNDS.mfgPanelWidth.min,
      LAYOUT_BOUNDS.mfgPanelWidth.max,
      DEFAULT_WORKSPACE_LAYOUT.mfgPanelWidth
    ),
    costPanelHeight: clamp(
      raw.costPanelHeight,
      LAYOUT_BOUNDS.costPanelHeight.min,
      LAYOUT_BOUNDS.costPanelHeight.max,
      DEFAULT_WORKSPACE_LAYOUT.costPanelHeight
    ),

    isLeftPanelOpen: typeof raw.isLeftPanelOpen === 'boolean' ? raw.isLeftPanelOpen : DEFAULT_WORKSPACE_LAYOUT.isLeftPanelOpen,
    isManufacturingActive: typeof raw.isManufacturingActive === 'boolean' ? raw.isManufacturingActive : DEFAULT_WORKSPACE_LAYOUT.isManufacturingActive,
    isCostPanelCollapsed: typeof raw.isCostPanelCollapsed === 'boolean' ? raw.isCostPanelCollapsed : DEFAULT_WORKSPACE_LAYOUT.isCostPanelCollapsed,

    contextualPanelSlot: validSlots.includes(raw.contextualPanelSlot)
      ? raw.contextualPanelSlot
      : DEFAULT_WORKSPACE_LAYOUT.contextualPanelSlot,
    workspaceSlot: validSlots.includes(raw.workspaceSlot)
      ? raw.workspaceSlot
      : DEFAULT_WORKSPACE_LAYOUT.workspaceSlot,
    mfgPanelSlot: validSlots.includes(raw.mfgPanelSlot)
      ? raw.mfgPanelSlot
      : DEFAULT_WORKSPACE_LAYOUT.mfgPanelSlot,
    costPanelSlot: validSlots.includes(raw.costPanelSlot)
      ? raw.costPanelSlot
      : DEFAULT_WORKSPACE_LAYOUT.costPanelSlot,
    isWorkspaceClosed: typeof raw.isWorkspaceClosed === 'boolean' ? raw.isWorkspaceClosed : DEFAULT_WORKSPACE_LAYOUT.isWorkspaceClosed,

    isLeftPanelDocked: typeof raw.isLeftPanelDocked === 'boolean' ? raw.isLeftPanelDocked : DEFAULT_WORKSPACE_LAYOUT.isLeftPanelDocked,
    isMfgPanelDocked: typeof raw.isMfgPanelDocked === 'boolean' ? raw.isMfgPanelDocked : DEFAULT_WORKSPACE_LAYOUT.isMfgPanelDocked,
    isCostPanelDocked: typeof raw.isCostPanelDocked === 'boolean' ? raw.isCostPanelDocked : DEFAULT_WORKSPACE_LAYOUT.isCostPanelDocked,

    isLeftPanelMaximized: Boolean(raw.isLeftPanelMaximized),
    isMfgPanelMaximized: Boolean(raw.isMfgPanelMaximized),
    isCostPanelMaximized: Boolean(raw.isCostPanelMaximized),
    isWorkspaceMaximized: Boolean(raw.isWorkspaceMaximized),

    leftPanelFloatingPos: sanitizeCoordinate(raw.leftPanelFloatingPos, DEFAULT_WORKSPACE_LAYOUT.leftPanelFloatingPos),
    mfgPanelFloatingPos: sanitizeCoordinate(raw.mfgPanelFloatingPos, DEFAULT_WORKSPACE_LAYOUT.mfgPanelFloatingPos),
    costPanelFloatingPos: sanitizeCoordinate(raw.costPanelFloatingPos, DEFAULT_WORKSPACE_LAYOUT.costPanelFloatingPos),

    pipVisible: Boolean(raw.pipVisible),
    pipPos: sanitizeCoordinate(raw.pipPos, DEFAULT_WORKSPACE_LAYOUT.pipPos),
    pipSize: {
      width: clamp(raw.pipSize?.width, LAYOUT_BOUNDS.pipWidth.min, LAYOUT_BOUNDS.pipWidth.max, DEFAULT_WORKSPACE_LAYOUT.pipSize.width),
      height: clamp(raw.pipSize?.height, LAYOUT_BOUNDS.pipHeight.min, LAYOUT_BOUNDS.pipHeight.max, DEFAULT_WORKSPACE_LAYOUT.pipSize.height),
    },

    ribbonExpanded: typeof raw.ribbonExpanded === 'boolean' ? raw.ribbonExpanded : DEFAULT_WORKSPACE_LAYOUT.ribbonExpanded,
  };

  normalizePanelSlots(layout);
  return layout;
}

/**
 * Swaps or reassigns panel dock slots guaranteeing zero overlap.
 * If targetSlot is already occupied by another panel, the occupant is swapped to panelKey's former slot.
 */
export function repositionPanelSlot(currentLayout, panelKey, targetSlot) {
  if (!currentLayout || !panelKey || !targetSlot) return currentLayout;

  const validSlots = ['left', 'right', 'bottom', 'center', 'floating'];
  if (!validSlots.includes(targetSlot)) return currentLayout;

  const panelSlotKeyMap = {
    contextual: 'contextualPanelSlot',
    manufacturing: 'mfgPanelSlot',
    cost: 'costPanelSlot',
    workspace: 'workspaceSlot',
  };

  const defaultSlotMap = {
    contextual: 'left',
    manufacturing: 'right',
    cost: 'bottom',
    workspace: 'center',
  };

  const mySlotKey = panelSlotKeyMap[panelKey];
  if (!mySlotKey) return currentLayout;

  const currentSlot = currentLayout[mySlotKey] || defaultSlotMap[panelKey] || 'floating';
  if (currentSlot === targetSlot) return currentLayout;

  const nextLayout = { ...currentLayout };

  // If undocking to floating, no slot collision occurs
  if (targetSlot === 'floating') {
    nextLayout[mySlotKey] = 'floating';
    return nextLayout;
  }

  // If docking into a shared slot, swap with whoever is currently occupying it
  const otherPanels = ['contextual', 'manufacturing', 'cost', 'workspace'].filter((p) => p !== panelKey);
  const occupyingPanel = otherPanels.find((p) => {
    const sKey = panelSlotKeyMap[p];
    const sVal = currentLayout[sKey] || defaultSlotMap[p];
    return sVal === targetSlot;
  });

  if (occupyingPanel) {
    const occupyingSlotKey = panelSlotKeyMap[occupyingPanel];
    // Swap: assign the occupying panel our former slot (or floating if we were floating)
    nextLayout[occupyingSlotKey] = currentSlot === 'floating' ? 'floating' : currentSlot;
  }

  nextLayout[mySlotKey] = targetSlot;
  return nextLayout;
}

/**
 * Enforces responsive bounds so that window shrinking never crushes the 3D workspace.
 */
export function enforceResponsiveBounds(layout, windowWidth, windowHeight) {
  if (!layout) return layout;
  const next = { ...layout };
  const winW = typeof windowWidth === 'number' ? windowWidth : (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const winH = typeof windowHeight === 'number' ? windowHeight : (typeof window !== 'undefined' ? window.innerHeight : 800);

  const MIN_WORKSPACE_WIDTH = 320;
  const leftW = next.leftPanelWidth || DEFAULT_WORKSPACE_LAYOUT.leftPanelWidth;
  const mfgW = next.mfgPanelWidth || DEFAULT_WORKSPACE_LAYOUT.mfgPanelWidth;

  const isLeftDocked = next.contextualPanelSlot !== 'floating';
  const isMfgDocked = next.mfgPanelSlot !== 'floating';

  let totalDockedWidth = 0;
  if (isLeftDocked) totalDockedWidth += leftW;
  if (isMfgDocked) totalDockedWidth += mfgW;

  const availableForPanels = Math.max(LAYOUT_BOUNDS.leftPanelWidth.min + LAYOUT_BOUNDS.mfgPanelWidth.min, winW - MIN_WORKSPACE_WIDTH);

  if (totalDockedWidth > availableForPanels) {
    const scale = availableForPanels / totalDockedWidth;
    if (isLeftDocked) {
      next.leftPanelWidth = Math.round(clamp(leftW * scale, LAYOUT_BOUNDS.leftPanelWidth.min, LAYOUT_BOUNDS.leftPanelWidth.max, LAYOUT_BOUNDS.leftPanelWidth.min));
    }
    if (isMfgDocked) {
      next.mfgPanelWidth = Math.round(clamp(mfgW * scale, LAYOUT_BOUNDS.mfgPanelWidth.min, LAYOUT_BOUNDS.mfgPanelWidth.max, LAYOUT_BOUNDS.mfgPanelWidth.min));
    }
  }

  const MIN_WORKSPACE_HEIGHT = 200;
  const TOP_RIBBON_HEIGHT = 50;
  const maxCostH = Math.max(LAYOUT_BOUNDS.costPanelHeight.min, winH - TOP_RIBBON_HEIGHT - MIN_WORKSPACE_HEIGHT);
  if (next.costPanelHeight > maxCostH) {
    next.costPanelHeight = Math.round(clamp(maxCostH, LAYOUT_BOUNDS.costPanelHeight.min, LAYOUT_BOUNDS.costPanelHeight.max, LAYOUT_BOUNDS.costPanelHeight.min));
  }

  return next;
}

export function loadWorkspaceLayout(storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store) return { ...DEFAULT_WORKSPACE_LAYOUT, isManufacturingActive: false };

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WORKSPACE_LAYOUT, isManufacturingActive: false };
    const parsed = JSON.parse(raw);
    const layout = sanitizeLayout(parsed);
    layout.isManufacturingActive = false; // Manufacture is never enabled by default
    if (parsed && (parsed.mfgPanelWidth === 440 || !parsed.mfgPanelWidth)) {
      layout.mfgPanelWidth = DEFAULT_MFG_WIDTH;
    }
    return layout;
  } catch (err) {
    console.warn('Failed to parse workspace layout from storage, using defaults:', err);
    return { ...DEFAULT_WORKSPACE_LAYOUT, isManufacturingActive: false };
  }
}

export function saveWorkspaceLayout(layout, storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store) return;

  try {
    const sanitized = sanitizeLayout(layout);
    store.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch (err) {
    console.warn('Failed to save workspace layout to storage:', err);
  }
}

export function resetWorkspaceLayout(storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (store) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  return { ...DEFAULT_WORKSPACE_LAYOUT };
}
