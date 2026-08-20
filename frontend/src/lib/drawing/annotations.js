/**
 * annotations.js
 * Engineering Sheet Layout, Title Block, Notes, and Border Definitions.
 * Standard A4 Landscape sheet: 1188 x 840 px (297 x 210 mm at 96 DPI).
 */

export const SHEET = {
  width: 1188,
  height: 840,
  margin: 20,
  innerMargin: 26,
};

/**
 * Calculates uniform scale and layout positions for Front, Top, and Side views.
 */
export function layoutDrawingViews(views) {
  const frontW = views.front?.width || 80;
  const frontH = views.front?.height || 60;
  const topH = views.top?.height || 60;
  const sideW = views.side?.width || 30;

  // Available drawing area (excluding title block and notes at bottom)
  const maxViewAreaW = 900;
  const maxViewAreaH = 580;

  const totalRequiredW = frontW + sideW + 100;
  const totalRequiredH = frontH + topH + 100;

  const scaleX = maxViewAreaW / Math.max(100, totalRequiredW);
  const scaleY = maxViewAreaH / Math.max(100, totalRequiredH);
  const uniformScale = Math.min(3.2, Math.max(0.6, Math.min(scaleX, scaleY) * 0.78));

  // Anchor centers for orthographic alignment
  const frontCenter = { x: 380, y: 470 };
  const topCenter = { x: 380, y: 200 };
  const sideCenter = { x: 760, y: 470 };

  return {
    scale: uniformScale,
    positions: {
      front: frontCenter,
      top: topCenter,
      side: sideCenter,
    },
  };
}

/**
 * Build the complete structured title block and notes metadata.
 */
export function buildSheetMetadata(drawingModel) {
  const isEstimated = Boolean(drawingModel.isEstimated);
  const hasAssumedMaterial = Boolean(drawingModel.material?.isAssumed);

  const notes = [
    "1. ALL DIMENSIONS ARE IN MILLIMETRES (mm) UNLESS NOTED.",
    "2. DRAWING GENERATED DETERMINISTICALLY FROM REFORGE RECONSTRUCTED GEOMETRY.",
  ];

  if (isEstimated || drawingModel.material?.source === "ai-estimated") {
    notes.push("3. DIMENSIONS MARKED (*) ARE AI-ESTIMATED. VERIFY CRITICAL SPECS BEFORE MANUFACTURING.");
  } else {
    notes.push("3. CRITICAL DIMENSIONS AND TOLERANCES TO BE VERIFIED FOR MANUFACTURING.");
  }

  notes.push("4. THIRD-ANGLE PROJECTION CONVENTION.");

  const titleBlock = {
    x: 780,
    y: 695,
    width: 382,
    height: 119,
    company: "REFORGE AI // INDUSTRIAL REVERSE ENGINEERING",
    partName: drawingModel.partName || "MECHANICAL COMPONENT",
    material: drawingModel.material?.name ? `${drawingModel.material.name}${hasAssumedMaterial ? " (ASSUMED)" : ""}` : "MILD STEEL",
    process: drawingModel.manufacturingProcess || "CNC MACHINING",
    units: "mm",
    scale: drawingModel.scale || "FIT",
    drawingId: drawingModel.drawingId || "RF-001",
    revision: drawingModel.revision || "A",
    date: drawingModel.date || new Date().toLocaleDateString("en-GB").toUpperCase(),
  };

  return {
    notes,
    titleBlock,
  };
}
