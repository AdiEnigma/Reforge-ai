import { postJson, ApiError } from "./api.js";

/**
 * Fetch a manufacturing intelligence estimate from the backend.
 * @param {object} analysis  — the full normalised analysis object from Gemini
 * @param {number} quantity  — desired production quantity (1–100 000)
 * @returns {Promise<object>} — the manufacturingIntelligence result object
 */
export async function fetchManufacturingIntelligence(analysis, quantity) {
  const result = await postJson("/api/manufacturing-intelligence", { analysis, quantity });
  if (!result || !result.manufacturingIntelligence) {
    throw new ApiError("Server returned no manufacturing estimate.", 502);
  }
  return result.manufacturingIntelligence;
}
