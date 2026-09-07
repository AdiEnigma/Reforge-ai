/**
 * machinery-context.js
 * Core state management, image metadata management, and kinematic calculations
 * for Complete Machinery Context in ReForge AI.
 *
 * Rules:
 * 1. Primary Gear (max 1)
 * 2. Companion Gear (max 1) - created ONLY through image upload
 * 3. Additional Gears (unlimited) - created ONLY through image upload, named Gear 3, Gear 4, ...
 * 4. Assembly Context & Environment Context
 * 5. Rich Image Metadata: Purpose, Priority, Notes, Reordering, Replacement
 */

export const ROLE_TYPES = {
  PRIMARY: 'PRIMARY',
  COMPANION: 'COMPANION',
  ADDITIONAL_GEAR: 'ADDITIONAL GEAR',
  COMPONENT: 'COMPONENT',
  MACHINERY_CONTEXT: 'MACHINERY / CONTEXT',
};

export const COMPONENT_TYPES = [
  { id: 'spur_gear', label: 'Spur Gear', isGear: true },
  { id: 'helical_gear', label: 'Helical Gear', isGear: true },
  { id: 'bevel_gear', label: 'Bevel Gear', isGear: true },
  { id: 'shaft', label: 'Shaft / Cylinder', isGear: false },
  { id: 'bearing', label: 'Bearing', isGear: false },
  { id: 'housing', label: 'Housing / Enclosure', isGear: false },
  { id: 'flange', label: 'Flange / Coupling', isGear: false },
  { id: 'bracket', label: 'Mounting Bracket', isGear: false },
  { id: 'other', label: 'Custom Component', isGear: false },
];

export const IMAGE_PURPOSES = [
  { id: 'overall_view', label: 'Overall View' },
  { id: 'tooth_profile', label: 'Tooth Profile' },
  { id: 'pitch_circle', label: 'Pitch Circle & Mesh' },
  { id: 'face_width', label: 'Face Width & Thickness' },
  { id: 'bore_hub', label: 'Bore & Hub / Keyway' },
  { id: 'wear_defect', label: 'Wear & Defect Inspection' },
  { id: 'assembly_alignment', label: 'Assembly Alignment' },
];

export const IMAGE_PRIORITIES = [
  { id: 'high', label: 'High Priority (Primary)' },
  { id: 'medium', label: 'Medium Priority' },
  { id: 'low', label: 'Low Priority' },
];

/**
 * Creates an empty or initial Machinery State.
 */
export function createInitialMachineryState() {
  const primaryId = 'comp-primary-gear';
  return {
    primaryGear: {
      id: primaryId,
      name: 'Primary Gear',
      role: ROLE_TYPES.PRIMARY,
      type: 'spur_gear',
      images: [],
      reference: {},
      analysis: null,
      notes: '',
      isEstimated: true,
    },
    companionGear: null,
    additionalComponents: [],
    assemblyContext: {
      id: 'comp-assembly-context',
      name: 'Assembly Context',
      role: ROLE_TYPES.MACHINERY_CONTEXT,
      images: [],
      notes: '',
    },
    environmentContext: {
      id: 'comp-environment-context',
      name: 'Environment Context',
      role: ROLE_TYPES.MACHINERY_CONTEXT,
      images: [],
      notes: '',
    },
    // Backwards-compatibility alias
    machineryContext: {
      id: 'comp-machinery-surroundings',
      name: 'Machinery / Surroundings',
      role: ROLE_TYPES.MACHINERY_CONTEXT,
      images: [],
      notes: '',
    },
    revision: 1,
    lastAnalyzedSnapshot: null,
  };
}

/**
 * Creates a unique component entity.
 */
export function createComponentEntity({
  id = null,
  name = 'New Component',
  role = ROLE_TYPES.ADDITIONAL_GEAR,
  type = 'spur_gear',
  images = [],
  reference = {},
  analysis = null,
  notes = '',
}) {
  return {
    id: id || `comp-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10)}`,
    name,
    role,
    type,
    images: Array.isArray(images) ? images : [],
    reference: reference || {},
    analysis: analysis || null,
    notes: notes || '',
    isEstimated: true,
  };
}

/**
 * Generates the next sequential gear name (Gear 3, Gear 4, Gear 5, etc.).
 */
export function getNextGearName(state) {
  const allComps = getAllComponents(state);
  const existingNames = new Set(allComps.map((c) => c.name.toLowerCase()));
  
  // Find highest Gear N number
  let maxN = 2;
  allComps.forEach((c) => {
    const match = c.name.match(/^gear\s*(\d+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxN) maxN = num;
    }
  });

  let nextCandidate = `Gear ${maxN + 1}`;
  let count = maxN + 1;
  while (existingNames.has(nextCandidate.toLowerCase())) {
    count++;
    nextCandidate = `Gear ${count}`;
  }
  return nextCandidate;
}

/**
 * Returns all active components in an array.
 */
export function getAllComponents(state) {
  if (!state) return [];
  const list = [];
  if (state.primaryGear) list.push(state.primaryGear);
  if (state.companionGear) list.push(state.companionGear);
  if (Array.isArray(state.additionalComponents)) {
    list.push(...state.additionalComponents);
  }
  return list;
}

/**
 * Returns total count of gears in the machinery state.
 */
export function getGearCount(state) {
  return getAllComponents(state).length;
}

/**
 * Finds a component by ID across all slots (including assembly and environment contexts).
 */
export function findComponentById(state, id) {
  if (!state || !id) return null;
  const cleanId = String(id).toLowerCase();

  if (
    state.primaryGear?.id === id ||
    cleanId === 'primary' ||
    cleanId === 'primarygear' ||
    cleanId === 'comp-primary' ||
    cleanId === 'comp-primary-gear'
  ) {
    return { component: state.primaryGear, slot: 'primaryGear' };
  }
  if (
    state.companionGear?.id === id ||
    cleanId === 'companion' ||
    cleanId === 'companiongear' ||
    cleanId === 'comp-companion' ||
    cleanId === 'comp-companion-gear'
  ) {
    return { component: state.companionGear, slot: 'companionGear' };
  }
  if (
    state.assemblyContext?.id === id ||
    cleanId === 'assembly-context' ||
    cleanId === 'comp-assembly-context' ||
    cleanId === 'assembly'
  ) {
    return { component: state.assemblyContext, slot: 'assemblyContext' };
  }
  if (
    state.environmentContext?.id === id ||
    cleanId === 'environment-context' ||
    cleanId === 'comp-environment-context' ||
    cleanId === 'environment'
  ) {
    return { component: state.environmentContext, slot: 'environmentContext' };
  }
  if (
    state.machineryContext?.id === id ||
    cleanId === 'machinery-context' ||
    cleanId === 'comp-machinery-surroundings' ||
    cleanId === 'surroundings'
  ) {
    return { component: state.machineryContext, slot: 'machineryContext' };
  }
  const idx = state.additionalComponents?.findIndex((c) => c.id === id);
  if (idx !== undefined && idx >= 0) {
    return { component: state.additionalComponents[idx], slot: 'additionalComponents', index: idx };
  }
  return null;
}

/**
 * Validates if setting a component to a role causes a conflict.
 */
export function checkRoleConflict(state, targetId, newRole) {
  if (!state || !targetId || !newRole) return { hasConflict: false };

  if (newRole === ROLE_TYPES.COMPANION) {
    if (state.companionGear && state.companionGear.id !== targetId) {
      return {
        hasConflict: true,
        type: 'REPLACE_COMPANION',
        currentCompanion: state.companionGear,
        message: `Replace current Companion Gear (${state.companionGear.name}) with selected component?`,
      };
    }
  }

  if (newRole === ROLE_TYPES.PRIMARY) {
    if (state.primaryGear && state.primaryGear.id !== targetId) {
      return {
        hasConflict: true,
        type: 'REPLACE_PRIMARY',
        currentPrimary: state.primaryGear,
        message: `Replace current Primary Gear (${state.primaryGear.name}) with selected component?`,
      };
    }
  }

  return { hasConflict: false };
}

/**
 * Reassigns role for a component. Handles moving between primaryGear, companionGear, and additionalComponents.
 */
export function assignComponentRole(state, targetId, newRole, forceReplace = false) {
  if (!state || !targetId) return state;

  const found = findComponentById(state, targetId);
  if (!found || found.slot.endsWith('Context')) return state;

  const { component } = found;
  if (component && component.role === newRole) return state;

  // Check for conflict unless forceReplace is true
  if (!forceReplace) {
    const conflict = checkRoleConflict(state, targetId, newRole);
    if (conflict.hasConflict) {
      const err = new Error(`ROLE_CONFLICT:${conflict.type}`);
      err.conflict = conflict;
      throw err;
    }
  }

  const nextState = {
    ...state,
    additionalComponents: [...(state.additionalComponents || [])],
    revision: (state.revision || 0) + 1,
  };

  // Remove component from its previous position
  if (found.slot === 'primaryGear') {
    nextState.primaryGear = null;
  } else if (found.slot === 'companionGear') {
    nextState.companionGear = null;
  } else if (found.slot === 'additionalComponents') {
    nextState.additionalComponents.splice(found.index, 1);
  }

  const updatedComponent = {
    ...(component || {}),
    role: newRole,
  };

  // Place into new slot based on role
  if (newRole === ROLE_TYPES.PRIMARY) {
    if (state.primaryGear && state.primaryGear.id !== targetId) {
      nextState.additionalComponents.push({
        ...state.primaryGear,
        role: ROLE_TYPES.ADDITIONAL_GEAR,
      });
    }
    nextState.primaryGear = updatedComponent;
  } else if (newRole === ROLE_TYPES.COMPANION) {
    if (state.companionGear && state.companionGear.id !== targetId) {
      nextState.additionalComponents.push({
        ...state.companionGear,
        role: ROLE_TYPES.ADDITIONAL_GEAR,
      });
    }
    nextState.companionGear = updatedComponent;
  } else {
    nextState.additionalComponents.push(updatedComponent);
  }

  return nextState;
}

/**
 * Creates and adds an additional gear exclusively from uploaded image files.
 */
export function addGearFromImages(state, files, customName = null) {
  if (!state || !files || !files.length) return state;
  const autoName = customName || getNextGearName(state);
  const newComp = createComponentEntity({
    name: autoName,
    role: ROLE_TYPES.ADDITIONAL_GEAR,
    type: 'spur_gear',
    images: [],
  });

  const stateWithComp = {
    ...state,
    additionalComponents: [...(state.additionalComponents || []), newComp],
    revision: (state.revision || 0) + 1,
  };

  return addImagesToComponent(stateWithComp, newComp.id, files);
}

/**
 * Creates or populates the Companion Gear exclusively from uploaded image files.
 */
export function addCompanionFromImages(state, files, customName = 'Companion Gear') {
  if (!state || !files || !files.length) return state;
  let nextState = state;
  if (!state.companionGear) {
    const newComp = createComponentEntity({
      name: customName,
      role: ROLE_TYPES.COMPANION,
      type: 'spur_gear',
      images: [],
    });
    nextState = {
      ...state,
      companionGear: newComp,
      revision: (state.revision || 0) + 1,
    };
  }
  return addImagesToComponent(nextState, nextState.companionGear.id, files);
}

/**
 * Adds an additional component to the machinery (internal helper).
 */
export function addAdditionalComponent(state, newCompData) {
  const comp = createComponentEntity(newCompData);
  return {
    ...state,
    additionalComponents: [...(state.additionalComponents || []), comp],
    revision: (state.revision || 0) + 1,
  };
}

/**
 * Renames a gear or component.
 */
export function renameGearComponent(state, targetId, newName) {
  if (!state || !targetId || !newName?.trim()) return state;
  const cleanName = newName.trim();
  const nextState = { ...state, revision: (state.revision || 0) + 1 };

  if (state.primaryGear?.id === targetId) {
    nextState.primaryGear = { ...state.primaryGear, name: cleanName };
    return nextState;
  }
  if (state.companionGear?.id === targetId) {
    nextState.companionGear = { ...state.companionGear, name: cleanName };
    return nextState;
  }
  if (state.assemblyContext?.id === targetId) {
    nextState.assemblyContext = { ...state.assemblyContext, name: cleanName };
    return nextState;
  }
  if (state.environmentContext?.id === targetId) {
    nextState.environmentContext = { ...state.environmentContext, name: cleanName };
    return nextState;
  }

  nextState.additionalComponents = (state.additionalComponents || []).map((c) =>
    c.id === targetId ? { ...c, name: cleanName } : c
  );
  return nextState;
}

/**
 * Updates notes on a specific component or context.
 */
export function updateComponentNotes(state, targetId, notes) {
  if (!state || !targetId) return state;
  const nextState = { ...state, revision: (state.revision || 0) + 1 };

  if (state.primaryGear?.id === targetId) {
    nextState.primaryGear = { ...state.primaryGear, notes };
    return nextState;
  }
  if (state.companionGear?.id === targetId) {
    nextState.companionGear = { ...state.companionGear, notes };
    return nextState;
  }
  if (state.assemblyContext?.id === targetId || targetId === 'assembly-context') {
    nextState.assemblyContext = { ...state.assemblyContext, notes };
    return nextState;
  }
  if (state.environmentContext?.id === targetId || targetId === 'environment-context') {
    nextState.environmentContext = { ...state.environmentContext, notes };
    return nextState;
  }
  if (state.machineryContext?.id === targetId || targetId === 'machinery-context') {
    nextState.machineryContext = { ...state.machineryContext, notes };
    return nextState;
  }

  nextState.additionalComponents = (state.additionalComponents || []).map((c) =>
    c.id === targetId ? { ...c, notes } : c
  );
  return nextState;
}

/**
 * Removes a component by ID.
 */
export function removeComponent(state, id) {
  if (!state || !id) return state;
  const found = findComponentById(state, id);
  if (!found) return state;

  const nextState = { ...state, revision: (state.revision || 0) + 1 };

  if (found.slot === 'primaryGear') {
    nextState.primaryGear = {
      ...state.primaryGear,
      images: [],
      analysis: null,
      reference: {},
      notes: '',
    };
  } else if (found.slot === 'companionGear') {
    nextState.companionGear = null;
  } else if (found.slot === 'additionalComponents') {
    nextState.additionalComponents = state.additionalComponents.filter((c) => c.id !== id);
  }

  return nextState;
}

/**
 * Adds images with default metadata to a specific component or context.
 */
export function addImagesToComponent(state, targetId, files) {
  if (!state || !targetId || !files) return state;

  const fileArray = Array.isArray(files) ? files : [...files];
  if (!fileArray.length) return state;

  const newImages = fileArray.map((file, idx) => {
    let url = '';
    if (typeof file === 'string') {
      url = file;
    } else if (file && typeof file.url === 'string') {
      url = file.url;
    } else if (typeof Blob !== 'undefined' && file instanceof Blob && typeof URL !== 'undefined' && URL.createObjectURL) {
      try {
        url = URL.createObjectURL(file);
      } catch {
        url = '';
      }
    }
    return {
      id: `img-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10)}`,
      file,
      url,
      name: (file && file.name) ? file.name : `image_${Date.now()}_${idx + 1}.png`,
      purpose: 'overall_view',
      priority: 'high',
      note: '',
    };
  });

  const nextState = { ...state, revision: (state.revision || 0) + 1 };
  const found = findComponentById(state, targetId);

  if (!found) {
    const cleanId = String(targetId).toLowerCase();
    if (cleanId.includes('assembly')) {
      nextState.assemblyContext = {
        ...(state.assemblyContext || { id: 'comp-assembly-context', name: 'Assembly Context', role: ROLE_TYPES.MACHINERY_CONTEXT }),
        images: [...(state.assemblyContext?.images || []), ...newImages],
      };
      return nextState;
    }
    if (cleanId.includes('environment') || cleanId.includes('surroundings') || cleanId.includes('machinery')) {
      nextState.environmentContext = {
        ...(state.environmentContext || { id: 'comp-environment-context', name: 'Environment Context', role: ROLE_TYPES.MACHINERY_CONTEXT }),
        images: [...(state.environmentContext?.images || []), ...newImages],
      };
      nextState.machineryContext = {
        ...(state.machineryContext || { id: 'comp-machinery-surroundings', name: 'Machinery / Surroundings', role: ROLE_TYPES.MACHINERY_CONTEXT }),
        images: [...(state.machineryContext?.images || []), ...newImages],
      };
      return nextState;
    }
    if (cleanId.includes('primary')) {
      nextState.primaryGear = {
        ...(state.primaryGear || { id: 'comp-primary-gear', name: 'Primary Gear', role: ROLE_TYPES.PRIMARY }),
        images: [...(state.primaryGear?.images || []), ...newImages],
      };
      return nextState;
    }
    if (cleanId.includes('companion')) {
      nextState.companionGear = {
        ...(state.companionGear || { id: 'comp-companion-gear', name: 'Companion Gear', role: ROLE_TYPES.COMPANION }),
        images: [...(state.companionGear?.images || []), ...newImages],
      };
      return nextState;
    }
    return state;
  }

  if (found.slot === 'primaryGear') {
    nextState.primaryGear = {
      ...(state.primaryGear || found.component),
      images: [...(state.primaryGear?.images || found.component?.images || []), ...newImages],
    };
  } else if (found.slot === 'companionGear') {
    nextState.companionGear = {
      ...(state.companionGear || found.component),
      images: [...(state.companionGear?.images || found.component?.images || []), ...newImages],
    };
  } else if (found.slot === 'assemblyContext') {
    nextState.assemblyContext = {
      ...(state.assemblyContext || found.component),
      images: [...(state.assemblyContext?.images || found.component?.images || []), ...newImages],
    };
  } else if (found.slot === 'environmentContext') {
    nextState.environmentContext = {
      ...(state.environmentContext || found.component),
      images: [...(state.environmentContext?.images || found.component?.images || []), ...newImages],
    };
    nextState.machineryContext = {
      ...(state.machineryContext || {}),
      images: [...(state.machineryContext?.images || []), ...newImages],
    };
  } else if (found.slot === 'machineryContext') {
    nextState.machineryContext = {
      ...(state.machineryContext || found.component),
      images: [...(state.machineryContext?.images || found.component?.images || []), ...newImages],
    };
    nextState.environmentContext = {
      ...(state.environmentContext || {}),
      images: [...(state.environmentContext?.images || []), ...newImages],
    };
  } else if (found.slot === 'additionalComponents') {
    nextState.additionalComponents = (state.additionalComponents || []).map((c, i) =>
      i === found.index ? { ...c, images: [...(c.images || []), ...newImages] } : c
    );
  }

  return nextState;
}

/**
 * Updates metadata for a specific image (purpose, priority, note).
 */
export function updateImageMetadata(state, targetId, imageId, metadata) {
  if (!state || !targetId || !imageId || !metadata) return state;
  const nextState = { ...state, revision: (state.revision || 0) + 1 };

  const updateList = (images = []) =>
    images.map((img) => (img.id === imageId ? { ...img, ...metadata } : img));

  if (targetId === 'assembly-context' || targetId === state.assemblyContext?.id) {
    nextState.assemblyContext = { ...state.assemblyContext, images: updateList(state.assemblyContext?.images) };
    return nextState;
  }
  if (targetId === 'environment-context' || targetId === state.environmentContext?.id) {
    nextState.environmentContext = { ...state.environmentContext, images: updateList(state.environmentContext?.images) };
    return nextState;
  }
  if (targetId === 'machinery-context' || targetId === state.machineryContext?.id) {
    nextState.machineryContext = { ...state.machineryContext, images: updateList(state.machineryContext?.images) };
    return nextState;
  }

  const found = findComponentById(state, targetId);
  if (!found) return state;

  if (found.slot === 'primaryGear') {
    nextState.primaryGear = { ...state.primaryGear, images: updateList(state.primaryGear.images) };
  } else if (found.slot === 'companionGear') {
    nextState.companionGear = { ...state.companionGear, images: updateList(state.companionGear?.images) };
  } else if (found.slot === 'additionalComponents') {
    nextState.additionalComponents = state.additionalComponents.map((c, i) =>
      i === found.index ? { ...c, images: updateList(c.images) } : c
    );
  }

  return nextState;
}

/**
 * Replaces an existing image with a new file while preserving ID, purpose, and notes.
 */
export function replaceComponentImage(state, targetId, imageId, newFile) {
  if (!state || !targetId || !imageId || !newFile) return state;

  let url = '';
  if (typeof Blob !== 'undefined' && newFile instanceof Blob && typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      url = URL.createObjectURL(newFile);
    } catch {
      url = '';
    }
  } else if (typeof newFile.url === 'string') {
    url = newFile.url;
  }

  const nextState = { ...state, revision: (state.revision || 0) + 1 };

  const updateList = (images = []) =>
    images.map((img) =>
      img.id === imageId
        ? {
            ...img,
            file: newFile,
            url,
            name: newFile.name || img.name,
          }
        : img
    );

  if (targetId === 'assembly-context' || targetId === state.assemblyContext?.id) {
    nextState.assemblyContext = { ...state.assemblyContext, images: updateList(state.assemblyContext?.images) };
    return nextState;
  }
  if (targetId === 'environment-context' || targetId === state.environmentContext?.id) {
    nextState.environmentContext = { ...state.environmentContext, images: updateList(state.environmentContext?.images) };
    return nextState;
  }
  if (targetId === 'machinery-context' || targetId === state.machineryContext?.id) {
    nextState.machineryContext = { ...state.machineryContext, images: updateList(state.machineryContext?.images) };
    return nextState;
  }

  const found = findComponentById(state, targetId);
  if (!found) return state;

  if (found.slot === 'primaryGear') {
    nextState.primaryGear = { ...state.primaryGear, images: updateList(state.primaryGear.images) };
  } else if (found.slot === 'companionGear') {
    nextState.companionGear = { ...state.companionGear, images: updateList(state.companionGear?.images) };
  } else if (found.slot === 'additionalComponents') {
    nextState.additionalComponents = state.additionalComponents.map((c, i) =>
      i === found.index ? { ...c, images: updateList(c.images) } : c
    );
  }

  return nextState;
}

/**
 * Reorders images inside a component from `fromIndex` to `toIndex`.
 */
export function reorderComponentImages(state, targetId, fromIndex, toIndex) {
  if (!state || !targetId || fromIndex === toIndex) return state;

  const reorder = (list = []) => {
    if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return list;
    const cloned = [...list];
    const [moved] = cloned.splice(fromIndex, 1);
    cloned.splice(toIndex, 0, moved);
    return cloned;
  };

  const nextState = { ...state, revision: (state.revision || 0) + 1 };

  if (targetId === 'assembly-context' || targetId === state.assemblyContext?.id) {
    nextState.assemblyContext = { ...state.assemblyContext, images: reorder(state.assemblyContext?.images) };
    return nextState;
  }
  if (targetId === 'environment-context' || targetId === state.environmentContext?.id) {
    nextState.environmentContext = { ...state.environmentContext, images: reorder(state.environmentContext?.images) };
    return nextState;
  }
  if (targetId === 'machinery-context' || targetId === state.machineryContext?.id) {
    nextState.machineryContext = { ...state.machineryContext, images: reorder(state.machineryContext?.images) };
    return nextState;
  }

  const found = findComponentById(state, targetId);
  if (!found) return state;

  if (found.slot === 'primaryGear') {
    nextState.primaryGear = { ...state.primaryGear, images: reorder(state.primaryGear.images) };
  } else if (found.slot === 'companionGear') {
    nextState.companionGear = { ...state.companionGear, images: reorder(state.companionGear?.images) };
  } else if (found.slot === 'additionalComponents') {
    nextState.additionalComponents = state.additionalComponents.map((c, i) =>
      i === found.index ? { ...c, images: reorder(c.images) } : c
    );
  }

  return nextState;
}

/**
 * Removes an image from a specific component or machinery context.
 */
export function removeImageFromComponent(state, targetId, imageId) {
  if (!state || !targetId || !imageId) return state;

  const nextState = { ...state, revision: (state.revision || 0) + 1 };

  if (targetId === 'assembly-context' || targetId === state.assemblyContext?.id) {
    nextState.assemblyContext = {
      ...state.assemblyContext,
      images: (state.assemblyContext?.images || []).filter((img) => img.id !== imageId),
    };
    return nextState;
  }

  if (targetId === 'environment-context' || targetId === state.environmentContext?.id) {
    nextState.environmentContext = {
      ...state.environmentContext,
      images: (state.environmentContext?.images || []).filter((img) => img.id !== imageId),
    };
    return nextState;
  }

  if (targetId === 'machinery-context' || targetId === state.machineryContext?.id) {
    nextState.machineryContext = {
      ...state.machineryContext,
      images: (state.machineryContext?.images || []).filter((img) => img.id !== imageId),
    };
    return nextState;
  }

  const found = findComponentById(state, targetId);
  if (!found) return state;

  if (found.slot === 'primaryGear') {
    nextState.primaryGear = {
      ...state.primaryGear,
      images: (state.primaryGear.images || []).filter((img) => img.id !== imageId),
    };
  } else if (found.slot === 'companionGear') {
    nextState.companionGear = {
      ...state.companionGear,
      images: (state.companionGear?.images || []).filter((img) => img.id !== imageId),
    };
  } else if (found.slot === 'additionalComponents') {
    nextState.additionalComponents = state.additionalComponents.map((c, i) =>
      i === found.index ? { ...c, images: (c.images || []).filter((img) => img.id !== imageId) } : c
    );
  }

  return nextState;
}

/**
 * Generates a comprehensive snapshot hash/signature of the machinery state
 * to detect any visual, metadata, purpose, priority, or structural changes.
 */
export function createMachinerySnapshot(state) {
  if (!state) return '';
  const components = getAllComponents(state);
  const compSignatures = components.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    type: c.type,
    notes: c.notes || '',
    images: (c.images || []).map((img) => ({
      id: img.id,
      name: img.name,
      purpose: img.purpose || '',
      priority: img.priority || '',
      note: img.note || '',
    })),
    refKeys: JSON.stringify(c.reference || {}),
    hasAnalysis: Boolean(c.analysis),
  }));

  const assemblyImgs = (state.assemblyContext?.images || []).map((i) => ({ id: i.id, p: i.purpose, note: i.note }));
  const envImgs = (state.environmentContext?.images || []).map((i) => ({ id: i.id, p: i.purpose, note: i.note }));
  const legacyMachImgs = (state.machineryContext?.images || []).map((i) => ({ id: i.id, p: i.purpose, note: i.note }));

  return JSON.stringify({
    compSignatures,
    assemblyImgs,
    envImgs,
    legacyMachImgs,
    assemblyNotes: state.assemblyContext?.notes || '',
    environmentNotes: state.environmentContext?.notes || '',
    machineryNotes: state.machineryContext?.notes || '',
  });
}

/**
 * Returns true if visual information, image metadata, roles, components, or parameters have changed
 * since the last analysis snapshot.
 */
export function hasDirtyContext(state, lastSnapshot) {
  if (!state) return false;
  if (!lastSnapshot) {
    const all = getAllComponents(state);
    const totalImages =
      all.reduce((sum, c) => sum + (c.images?.length || 0), 0) +
      (state.assemblyContext?.images?.length || 0) +
      (state.environmentContext?.images?.length || 0) +
      (state.machineryContext?.images?.length || 0);
    return totalImages > 0;
  }
  const currentSnapshot = createMachinerySnapshot(state);
  return currentSnapshot !== lastSnapshot;
}

/**
 * Computes assembly kinematic and geometric relationships between components.
 */
export function computeAssemblyRelations(primaryComp, companionComp, additionalComps = []) {
  const pAnalysis = primaryComp?.analysis;
  const cAnalysis = companionComp?.analysis;

  const pTeeth = pAnalysis?.teeth || pAnalysis?.geometryRecipe?.gear?.teeth || 20;
  const pModule = pAnalysis?.module || pAnalysis?.geometryRecipe?.gear?.module || 2.5;
  const pOD = pAnalysis?.dimensions?.outerDiameter || (pTeeth + 2) * pModule;
  const pPitchD = pTeeth * pModule;
  const pBoreD = pAnalysis?.dimensions?.innerDiameter || pPitchD * 0.35;
  const pFaceWidth = pAnalysis?.dimensions?.height || pAnalysis?.dimensions?.thickness || pAnalysis?.geometryRecipe?.gear?.faceWidth || 25;

  let companionRelations = null;
  if (companionComp && cAnalysis) {
    const cTeeth = cAnalysis?.teeth || cAnalysis?.geometryRecipe?.gear?.teeth || Math.round(pTeeth * 1.5);
    const cModule = cAnalysis?.module || cAnalysis?.geometryRecipe?.gear?.module || pModule;
    const cOD = cAnalysis?.dimensions?.outerDiameter || (cTeeth + 2) * cModule;
    const cPitchD = cTeeth * cModule;
    const cBoreD = cAnalysis?.dimensions?.innerDiameter || cPitchD * 0.35;
    const cFaceWidth = cAnalysis?.dimensions?.height || cAnalysis?.dimensions?.thickness || pFaceWidth;

    const centerDistance = ((pTeeth + cTeeth) * pModule) / 2;
    const gearRatio = cTeeth / pTeeth;
    const speedRatio = 1 / gearRatio;
    const moduleMatch = Math.abs(pModule - cModule) < 0.05;

    companionRelations = {
      primaryTeeth: pTeeth,
      companionTeeth: cTeeth,
      module: pModule,
      companionModule: cModule,
      moduleMatch,
      primaryPitchDiameter: pPitchD,
      companionPitchDiameter: cPitchD,
      centerDistance,
      gearRatio: Number(gearRatio.toFixed(3)),
      speedRatio: Number(speedRatio.toFixed(3)),
      primaryFaceWidth: pFaceWidth,
      companionFaceWidth: cFaceWidth,
      estimatedBacklashMm: Number((0.04 * pModule).toFixed(3)),
      contactRatio: Number((1.6 + (0.1 * (pTeeth + cTeeth)) / 50).toFixed(2)),
    };
  }

  // Multi-gear gear train relationships for additional gears
  const additionalGearsRelations = (additionalComps || [])
    .filter((c) => c.role === ROLE_TYPES.ADDITIONAL_GEAR || c.type?.includes('gear'))
    .map((gearComp, idx) => {
      const gAnalysis = gearComp.analysis;
      const gTeeth = gAnalysis?.teeth || Math.round(pTeeth * (1.2 + idx * 0.3));
      const gModule = gAnalysis?.module || pModule;
      const gPitchD = gTeeth * gModule;
      return {
        id: gearComp.id,
        name: gearComp.name,
        teeth: gTeeth,
        module: gModule,
        pitchDiameter: gPitchD,
        ratioToPrimary: Number((gTeeth / pTeeth).toFixed(3)),
      };
    });

  const shafts = (additionalComps || []).filter((c) => c.type === 'shaft' || c.name?.toLowerCase().includes('shaft'));
  const bearings = (additionalComps || []).filter((c) => c.type === 'bearing' || c.name?.toLowerCase().includes('bearing'));
  const housings = (additionalComps || []).filter((c) => c.type === 'housing' || c.name?.toLowerCase().includes('housing'));

  return {
    primary: {
      teeth: pTeeth,
      module: pModule,
      pitchDiameter: pPitchD,
      outerDiameter: pOD,
      boreDiameter: pBoreD,
      faceWidth: pFaceWidth,
    },
    companion: companionRelations,
    additionalGears: additionalGearsRelations,
    shaftCount: shafts.length,
    bearingCount: bearings.length,
    housingCount: housings.length,
    totalComponents: 1 + (companionComp ? 1 : 0) + (additionalComps || []).length,
  };
}
