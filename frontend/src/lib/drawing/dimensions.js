/**
 * dimensions.js
 * Automatic Engineering Dimension Generation & Placement Engine.
 * Generates extension lines, dimension lines, arrows, and technical text callouts.
 */

import { dimension } from "./geometry.js";
import { formatDim } from "./projections.js";

/**
 * Generate automatic dimensions for each orthographic view.
 */
export function generateDimensions(views, dims, recipe, analysis) {
  const isRecipe = Boolean(recipe && (recipe.style || recipe.revolvedProfile || recipe.outline || recipe.gear));
  const compType = String(analysis?.componentType || "").toLowerCase();

  const od = dims.outerDia;
  const id = dims.innerDia;
  const w = dims.width;
  const h = dims.height;
  const depth = dims.depth;
  const teeth = dims.teeth;
  const module = dims.module;

  // 1. Front View Dimensions
  if (views.front) {
    const fw = views.front.width || w || 80;
    const fh = views.front.height || h || od || 50;
    const halfW = fw / 2;
    const halfH = fh / 2;

    // Horizontal length/width dimension (below view)
    views.front.dimensions.push(
      dimension({
        id: "dim-front-width",
        type: "horizontal",
        x1: -halfW,
        y1: halfH + 18,
        x2: halfW,
        y2: halfH + 18,
        value: fw,
        label: `${formatDim(fw)}`,
        source: isRecipe ? "geometryRecipe" : "analysis",
        confidence: isRecipe ? 1.0 : (analysis?.confidence || 0.8),
        orientation: "horizontal",
        offset: 18,
        options: { extY1: halfH, extY2: halfH + 22 },
      })
    );

    // Vertical height / diameter dimension (left of view)
    views.front.dimensions.push(
      dimension({
        id: "dim-front-height",
        type: "vertical",
        x1: -halfW - 22,
        y1: -halfH,
        x2: -halfW - 22,
        y2: halfH,
        value: fh,
        label: od && fh === od ? `Ø${formatDim(fh)}` : `${formatDim(fh)}`,
        source: isRecipe ? "geometryRecipe" : "analysis",
        confidence: isRecipe ? 1.0 : (analysis?.confidence || 0.8),
        orientation: "vertical",
        offset: 22,
        options: { extX1: -halfW, extX2: -halfW - 26 },
      })
    );

    // Bore dimension if present
    if (id && id > 0) {
      views.front.dimensions.push(
        dimension({
          id: "dim-front-bore",
          type: "diameter",
          x1: -id / 2,
          y1: -halfH - 14,
          x2: id / 2,
          y2: -halfH - 14,
          value: id,
          label: `Ø${formatDim(id)} BORE`,
          source: isRecipe ? "geometryRecipe" : "analysis",
          confidence: isRecipe ? 1.0 : (analysis?.confidence || 0.75),
          orientation: "horizontal",
          offset: 14,
          options: { extY1: -id / 2, extY2: -halfH - 18 },
        })
      );
    }
  }

  // 2. Top View Dimensions
  if (views.top) {
    const tw = views.top.width || od || 60;
    const th = views.top.height || od || 60;
    const halfW = tw / 2;
    const halfH = th / 2;

    if (od && od > 0) {
      views.top.dimensions.push(
        dimension({
          id: "dim-top-od",
          type: "diameter",
          x1: -halfW,
          y1: halfH + 16,
          x2: halfW,
          y2: halfH + 16,
          value: od,
          label: `Ø${formatDim(od)} OD`,
          source: isRecipe ? "geometryRecipe" : "analysis",
          confidence: isRecipe ? 1.0 : (analysis?.confidence || 0.8),
          orientation: "horizontal",
          offset: 16,
        })
      );
    }

    // Hole callout if recipe has holes or flange
    const holes = recipe?.holes || [];
    if (holes.length > 0) {
      const perimeterHoles = holes.filter((h) => Math.abs(h.cx || 0) > 0.01 || Math.abs(h.cy || 0) > 0.01);
      if (perimeterHoles.length > 0) {
        const hRad = perimeterHoles[0].radius || 4;
        const hDia = hRad * 2;
        views.top.dimensions.push(
          dimension({
            id: "dim-top-holes",
            type: "holeCallout",
            x1: perimeterHoles[0].cx || 25,
            y1: perimeterHoles[0].cy || 0,
            x2: (perimeterHoles[0].cx || 25) + 30,
            y2: (perimeterHoles[0].cy || 0) - 20,
            value: hDia,
            label: `${perimeterHoles.length}X Ø${formatDim(hDia)} THRU`,
            source: "geometryRecipe",
            confidence: 1.0,
            orientation: "radial",
          })
        );
      }
    } else if (compType.includes("flange")) {
      views.top.dimensions.push(
        dimension({
          id: "dim-top-flange-holes",
          type: "holeCallout",
          x1: halfW * 0.78,
          y1: 0,
          x2: halfW * 0.78 + 25,
          y2: -20,
          value: 8,
          label: `6X Ø8 THRU EQ SP`,
          source: "analysis",
          confidence: 0.85,
          orientation: "radial",
        })
      );
    }

    // Gear tooth callout
    if (teeth && teeth > 0) {
      views.top.dimensions.push(
        dimension({
          id: "dim-top-teeth-note",
          type: "holeCallout",
          x1: halfW,
          y1: -halfH * 0.5,
          x2: halfW + 35,
          y2: -halfH * 0.5 - 15,
          value: teeth,
          label: `${teeth} TEETH · M${module || 2}`,
          source: isRecipe ? "geometryRecipe" : "analysis",
          confidence: 1.0,
          orientation: "radial",
        })
      );
    }
  }

  // 3. Side View Dimensions
  if (views.side) {
    const sw = views.side.width || depth || 20;
    const sh = views.side.height || h || od || 60;
    const halfW = sw / 2;
    const halfH = sh / 2;

    // Depth / Face width dimension
    views.side.dimensions.push(
      dimension({
        id: "dim-side-depth",
        type: "horizontal",
        x1: -halfW,
        y1: halfH + 16,
        x2: halfW,
        y2: halfH + 16,
        value: sw,
        label: `${formatDim(sw)} THK`,
        source: isRecipe ? "geometryRecipe" : "analysis",
        confidence: isRecipe ? 1.0 : (analysis?.confidence || 0.8),
        orientation: "horizontal",
        offset: 16,
      })
    );
  }
}
