import { postJson, ApiError } from "./api.js";

/**
 * Fetch material alternatives from the backend.
 * @param {object} analysis — the full normalised analysis object from Gemini
 * @param {object} manufacturingIntelligence — the already-fetched mfg intel result
 * @returns {Promise<object>} — the materialAlternatives result object
 */
export async function fetchMaterialAlternatives(analysis, manufacturingIntelligence) {
  const result = await postJson("/api/material-alternatives", {
    analysis,
    manufacturingIntelligence,
  });
  if (!result || !result.materialAlternatives) {
    throw new ApiError("Server returned no material comparison.", 502);
  }
  return result.materialAlternatives;
}
