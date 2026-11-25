import { postJson, getJson, fileToPayload, ApiError } from "./api.js";

/**
 * Creates a new workbench for the active user.
 */
export async function createWorkbenchApi({ name = null, componentName = null } = {}) {
  const result = await postJson("/api/workbenches", { name, componentName });
  return result?.workbench || null;
}

/**
 * Lists the authenticated user's workbenches.
 */
export async function listWorkbenchesApi({ includeArchived = false } = {}) {
  const query = includeArchived ? "?archived=true" : "";
  const result = await getJson(`/api/workbenches${query}`);
  return result?.workbenches || [];
}

/**
 * Retrieves a workbench, its latest snapshot, and asset references.
 */
export async function getWorkbenchApi(workbenchId) {
  if (!workbenchId) throw new ApiError("Workbench ID is required.", 400);
  const result = await getJson(`/api/workbenches/${workbenchId}`);
  return result;
}

/**
 * Updates workbench metadata (name, status, isArchived).
 */
export async function updateWorkbenchApi(workbenchId, updates) {
  if (!workbenchId) throw new ApiError("Workbench ID is required.", 400);
  let response;
  try {
    response = await fetch(`/api/workbenches/${workbenchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(updates),
    });
  } catch {
    throw new ApiError("Cannot reach the ReForge AI server.", 0);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error || `Update failed (${response.status}).`, response.status);
  }
  return payload?.workbench;
}

/**
 * Saves a versioned snapshot of the engineering state.
 */
export async function saveSnapshotApi(workbenchId, state) {
  if (!workbenchId) throw new ApiError("Workbench ID is required.", 400);
  let response;
  try {
    response = await fetch(`/api/workbenches/${workbenchId}/snapshot`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ state }),
    });
  } catch {
    throw new ApiError("Cannot reach the ReForge AI server.", 0);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error || `Save failed (${response.status}).`, response.status);
  }
  return payload?.snapshot;
}

/**
 * Uploads an image file to the workbench's permanent asset storage.
 */
export async function uploadWorkbenchImageApi(workbenchId, file, customName = null) {
  if (!workbenchId) throw new ApiError("Workbench ID is required.", 400);
  const payload = await fileToPayload(file);
  const result = await postJson(`/api/workbenches/${workbenchId}/images`, {
    name: customName || file.name || "image.png",
    mimeType: payload.mimeType,
    data: payload.data,
  });
  return result?.asset;
}

/**
 * Generates and saves a CAD export in the workbench's permanent storage.
 */
export async function exportAndSaveCadApi(workbenchId, { analysis, format, baseName }) {
  if (!workbenchId) throw new ApiError("Workbench ID is required.", 400);
  const result = await postJson(`/api/workbenches/${workbenchId}/export-cad`, {
    analysis,
    format,
    baseName,
  });
  return result;
}

/**
 * Deletes a workbench and its assets.
 */
export async function deleteWorkbenchApi(workbenchId) {
  if (!workbenchId) throw new ApiError("Workbench ID is required.", 400);
  let response;
  try {
    response = await fetch(`/api/workbenches/${workbenchId}`, {
      method: "DELETE",
      credentials: "include",
    });
  } catch {
    throw new ApiError("Cannot reach the ReForge AI server.", 0);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error || `Delete failed (${response.status}).`, response.status);
  }
  return payload;
}

/**
 * Sanitizes and serializes the complete engineering workbench state for snapshots.
 * Strips transient browser Blobs and ensures durable asset URLs.
 */
export function serializeWorkbenchState(workbenchId, rawState) {
  if (!rawState) return {};

  const cleanComponent = (comp) => {
    if (!comp) return null;
    return {
      id: comp.id,
      name: comp.name,
      role: comp.role,
      type: comp.type,
      notes: comp.notes || "",
      isEstimated: comp.isEstimated,
      reference: comp.reference ? { ...comp.reference } : {},
      analysis: comp.analysis ? JSON.parse(JSON.stringify(comp.analysis)) : null,
      images: (comp.images || []).map((img) => ({
        id: img.id,
        name: img.name,
        purpose: img.purpose || "overall_view",
        priority: img.priority || "high",
        note: img.note || "",
        assetId: img.assetId || null,
        url: img.assetId
          ? `/api/workbenches/${workbenchId}/assets/${img.assetId}`
          : (typeof img.url === "string" && img.url.startsWith("/api/") ? img.url : ""),
      })),
    };
  };

  const rawMachinery = rawState.machineryState || {};
  const cleanMachinery = {
    primaryGear: cleanComponent(rawMachinery.primaryGear),
    companionGear: cleanComponent(rawMachinery.companionGear),
    additionalComponents: Array.isArray(rawMachinery.additionalComponents)
      ? rawMachinery.additionalComponents.map(cleanComponent).filter(Boolean)
      : [],
    assemblyContext: rawMachinery.assemblyContext
      ? {
          id: rawMachinery.assemblyContext.id,
          name: rawMachinery.assemblyContext.name,
          role: rawMachinery.assemblyContext.role,
          notes: rawMachinery.assemblyContext.notes || "",
          images: (rawMachinery.assemblyContext.images || []).map((img) => ({
            id: img.id,
            name: img.name,
            purpose: img.purpose,
            note: img.note,
            assetId: img.assetId || null,
            url: img.assetId
              ? `/api/workbenches/${workbenchId}/assets/${img.assetId}`
              : (typeof img.url === "string" && img.url.startsWith("/api/") ? img.url : ""),
          })),
        }
      : null,
    environmentContext: rawMachinery.environmentContext
      ? {
          id: rawMachinery.environmentContext.id,
          name: rawMachinery.environmentContext.name,
          role: rawMachinery.environmentContext.role,
          notes: rawMachinery.environmentContext.notes || "",
          images: (rawMachinery.environmentContext.images || []).map((img) => ({
            id: img.id,
            name: img.name,
            purpose: img.purpose,
            note: img.note,
            assetId: img.assetId || null,
            url: img.assetId
              ? `/api/workbenches/${workbenchId}/assets/${img.assetId}`
              : (typeof img.url === "string" && img.url.startsWith("/api/") ? img.url : ""),
          })),
        }
      : null,
    revision: rawMachinery.revision || 1,
  };

  return {
    workbenchName: rawState.workbenchName || rawState.name || null,
    componentName: rawState.analysis?.componentName || rawMachinery.primaryGear?.name || null,
    reference: rawState.reference || rawMachinery.primaryGear?.reference || {},
    analysis: rawState.analysis ? JSON.parse(JSON.stringify(rawState.analysis)) : null,
    machineryState: cleanMachinery,
    stage: rawState.stage || "idle",
    viewMode: rawState.viewMode || "single",
    activeComponentId: rawState.activeComponentId || "comp-primary-gear",
    quantity: rawState.quantity || 1,
    mfgData: rawState.mfgData ? JSON.parse(JSON.stringify(rawState.mfgData)) : null,
    scenarioParams: rawState.scenarioParams ? JSON.parse(JSON.stringify(rawState.scenarioParams)) : {},
    timestamp: Date.now(),
  };
}

/**
 * Hydrates serialized snapshot state, mapping stored assets to image previews.
 */
export function deserializeWorkbenchState(workbenchId, snapState, assets = []) {
  if (!snapState) return null;

  const assetMapById = new Map();
  const assetMapByName = new Map();
  for (const asset of assets) {
    assetMapById.set(asset.id, asset);
    if (asset.originalFilename) assetMapByName.set(asset.originalFilename, asset);
    if (asset.original_filename) assetMapByName.set(asset.original_filename, asset);
  }

  const hydrateImage = (img) => {
    let url = img.url;
    let assetId = img.assetId;

    if (assetId && assetMapById.has(assetId)) {
      url = assetMapById.get(assetId).url;
    } else if (img.name && assetMapByName.has(img.name)) {
      const match = assetMapByName.get(img.name);
      assetId = match.id;
      url = match.url;
    } else if (!url && assetId) {
      url = `/api/workbenches/${workbenchId}/assets/${assetId}`;
    }

    return {
      ...img,
      assetId,
      url: url || "",
    };
  };

  const hydrateComponent = (comp) => {
    if (!comp) return null;
    return {
      ...comp,
      images: (comp.images || []).map(hydrateImage),
    };
  };

  const rawMachinery = snapState.machineryState || {};
  const hydratedMachinery = {
    ...rawMachinery,
    primaryGear: hydrateComponent(rawMachinery.primaryGear),
    companionGear: hydrateComponent(rawMachinery.companionGear),
    additionalComponents: (rawMachinery.additionalComponents || []).map(hydrateComponent),
    assemblyContext: rawMachinery.assemblyContext
      ? {
          ...rawMachinery.assemblyContext,
          images: (rawMachinery.assemblyContext.images || []).map(hydrateImage),
        }
      : null,
    environmentContext: rawMachinery.environmentContext
      ? {
          ...rawMachinery.environmentContext,
          images: (rawMachinery.environmentContext.images || []).map(hydrateImage),
        }
      : null,
  };

  return {
    reference: snapState.reference || hydratedMachinery.primaryGear?.reference || {},
    analysis: snapState.analysis || null,
    machineryState: hydratedMachinery,
    stage: snapState.analysis ? "ready" : (snapState.stage || "idle"),
    viewMode: snapState.viewMode || "single",
    activeComponentId: snapState.activeComponentId || "comp-primary-gear",
    quantity: snapState.quantity || 1,
    mfgData: snapState.mfgData || null,
    scenarioParams: snapState.scenarioParams || {},
  };
}
