/**
 * renderer.js
 * SVG Engineering Drawing Renderer.
 * Generates standards-compliant, vector-sharp technical drawings.
 */

import { SHEET, layoutDrawingViews, buildSheetMetadata } from "./annotations.js";
import { generateDimensions } from "./dimensions.js";

/**
 * Escapes string for safe SVG XML insertion.
 */
function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a single entity into SVG markup.
 */
function renderEntity(entity, cx, cy, scale, options = {}) {
  const { showCenterlines = true, showHiddenLines = true } = options;
  const tx = (x) => (cx + x * scale).toFixed(1);
  const ty = (y) => (cy + y * scale).toFixed(1);

  if (entity.layer === "centerline" && !showCenterlines) return "";
  if (entity.layer === "hidden" && !showHiddenLines) return "";

  const strokeColor =
    entity.layer === "centerline"
      ? "#de822b"
      : entity.layer === "hidden"
      ? "#8c7b70"
      : "#1a120c";

  const strokeWidth =
    entity.layer === "visible" ? 1.5 : entity.layer === "hidden" ? 1.0 : 0.8;

  const dashArray =
    entity.layer === "centerline"
      ? 'stroke-dasharray="10,3,2,3"'
      : entity.layer === "hidden"
      ? 'stroke-dasharray="4,3"'
      : "";

  switch (entity.type) {
    case "line":
      return `<line x1="${tx(entity.x1)}" y1="${ty(entity.y1)}" x2="${tx(entity.x2)}" y2="${ty(entity.y2)}" stroke="${strokeColor}" stroke-width="${strokeWidth}" ${dashArray} />`;

    case "rect": {
      const rx = tx(entity.x);
      const ry = ty(entity.y);
      const rw = (entity.width * scale).toFixed(1);
      const rh = (entity.height * scale).toFixed(1);
      return `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" ${dashArray} />`;
    }

    case "circle": {
      const rx = tx(entity.cx);
      const ry = ty(entity.cy);
      const r = (entity.radius * scale).toFixed(1);
      return `<circle cx="${rx}" cy="${ry}" r="${r}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" ${dashArray} />`;
    }

    case "arc": {
      const rx = tx(entity.cx);
      const ry = ty(entity.cy);
      const r = (entity.radius * scale).toFixed(1);
      const startX = (cx + (entity.cx + Math.cos(entity.startAngle) * entity.radius) * scale).toFixed(1);
      const startY = (cy + (entity.cy + Math.sin(entity.startAngle) * entity.radius) * scale).toFixed(1);
      const endX = (cx + (entity.cx + Math.cos(entity.endAngle) * entity.radius) * scale).toFixed(1);
      const endY = (cy + (entity.cy + Math.sin(entity.endAngle) * entity.radius) * scale).toFixed(1);
      return `<path d="M ${startX} ${startY} A ${r} ${r} 0 0 1 ${endX} ${endY}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" ${dashArray} />`;
    }

    case "path": {
      if (!entity.points || entity.points.length < 2) return "";
      const d = entity.points
        .map((p, idx) => `${idx === 0 ? "M" : "L"} ${tx(p.x)} ${ty(p.y)}`)
        .join(" ") + (entity.closed ? " Z" : "");
      return `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" ${dashArray} />`;
    }

    case "centerMark": {
      const rx = tx(entity.cx);
      const ry = ty(entity.cy);
      const s = ((entity.size || 6) * scale).toFixed(1);
      return `
        <line x1="${Number(rx) - Number(s)}" y1="${ry}" x2="${Number(rx) + Number(s)}" y2="${ry}" stroke="#de822b" stroke-width="0.8" />
        <line x1="${rx}" y1="${Number(ry) - Number(s)}" x2="${rx}" y2="${Number(ry) + Number(s)}" stroke="#de822b" stroke-width="0.8" />
      `;
    }

    default:
      return "";
  }
}

/**
 * Render a single dimension into SVG markup with arrows and extension lines.
 */
function renderDimension(dim, cx, cy, scale) {
  const isEstimated = Boolean(dim.isEstimated);
  const textLabel = esc(dim.label) + (isEstimated ? "*" : "");

  const x1 = cx + dim.x1 * scale;
  const y1 = cy + dim.y1 * scale;
  const x2 = cx + dim.x2 * scale;
  const y2 = cy + dim.y2 * scale;

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;

  let extensionLines = "";
  if (dim.orientation === "horizontal" && dim.options?.extY1 != null) {
    const origY = cy + dim.options.extY1 * scale;
    extensionLines += `<line x1="${x1.toFixed(1)}" y1="${origY.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${(y1 + 4).toFixed(1)}" stroke="#665548" stroke-width="0.6" />`;
    extensionLines += `<line x1="${x2.toFixed(1)}" y1="${origY.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${(y2 + 4).toFixed(1)}" stroke="#665548" stroke-width="0.6" />`;
  } else if (dim.orientation === "vertical" && dim.options?.extX1 != null) {
    const origX = cx + dim.options.extX1 * scale;
    extensionLines += `<line x1="${origX.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${(x1 - 4).toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#665548" stroke-width="0.6" />`;
    extensionLines += `<line x1="${origX.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${(x2 - 4).toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#665548" stroke-width="0.6" />`;
  }

  return `
    <g class="cad-dim" data-dim-id="${esc(dim.id)}" data-source="${esc(dim.source)}" data-confidence="${dim.confidence}">
      ${extensionLines}
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#140d07" stroke-width="1.0" marker-start="url(#dim-arrow-start)" marker-end="url(#dim-arrow-end)" />
      <rect x="${(midX - 22).toFixed(1)}" y="${(midY - 8).toFixed(1)}" width="44" height="15" fill="#fdfbf7" opacity="0.92" rx="2" />
      <text x="${midX.toFixed(1)}" y="${(midY + 3.5).toFixed(1)}" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="#140d07">${textLabel}</text>
    </g>
  `;
}

/**
 * Generate full SVG string from drawing model.
 */
export function renderDrawingToSvg(drawingModel, options = {}) {
  const {
    showDimensions = true,
    showCenterlines = true,
    showHiddenLines = true,
    viewFilter = "all", // "all" | "front" | "top" | "side"
  } = options;

  const views = drawingModel.views || {};
  generateDimensions(views, drawingModel.dimensions, drawingModel.recipe, drawingModel);

  const { scale, positions } = layoutDrawingViews(views);
  const { notes, titleBlock } = buildSheetMetadata(drawingModel);

  const w = SHEET.width;
  const h = SHEET.height;
  const m = SHEET.margin;
  const im = SHEET.innerMargin;

  // View sections markup
  let viewsMarkup = "";

  const renderView = (viewKey, title, pos) => {
    const view = views[viewKey];
    if (!view) return "";

    let content = `
      <g class="cad-view cad-view-${viewKey}">
        <text x="${pos.x}" y="${pos.y - (view.height * scale) / 2 - 24}" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="11" font-weight="700" fill="#7a6251" letter-spacing="0.08em">${title}</text>
    `;

    for (const ent of view.entities || []) {
      content += renderEntity(ent, pos.x, pos.y, scale, { showCenterlines, showHiddenLines });
    }

    if (showDimensions) {
      for (const dim of view.dimensions || []) {
        content += renderDimension(dim, pos.x, pos.y, scale);
      }
    }

    content += `</g>`;
    return content;
  };

  if (viewFilter === "all" || viewFilter === "front") {
    viewsMarkup += renderView("front", "FRONT VIEW", viewFilter === "front" ? { x: w / 2, y: h / 2 - 40 } : positions.front);
  }
  if (viewFilter === "all" || viewFilter === "top") {
    viewsMarkup += renderView("top", "TOP VIEW", viewFilter === "top" ? { x: w / 2, y: h / 2 - 40 } : positions.top);
  }
  if (viewFilter === "all" || viewFilter === "side") {
    viewsMarkup += renderView("side", "RIGHT SIDE VIEW", viewFilter === "side" ? { x: w / 2, y: h / 2 - 40 } : positions.side);
  }

  // Notes Block markup
  const notesMarkup = `
    <g class="cad-notes">
      <rect x="${im + 10}" y="${h - im - 120}" width="420" height="110" fill="#fcf9f2" stroke="#544337" stroke-width="1.0" />
      <text x="${im + 20}" y="${h - im - 100}" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="#b76308" letter-spacing="0.06em">NOTES:</text>
      ${notes
        .map(
          (note, idx) =>
            `<text x="${im + 20}" y="${h - im - 82 + idx * 16}" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="500" fill="#3d332c">${esc(
              note
            )}</text>`
        )
        .join("")}
    </g>
  `;

  // Title Block markup
  const tb = titleBlock;
  const titleBlockMarkup = `
    <g class="cad-title-block">
      <rect x="${tb.x}" y="${tb.y}" width="${tb.width}" height="${tb.height}" fill="#fcf9f2" stroke="#544337" stroke-width="1.5" />
      
      <!-- Top header -->
      <line x1="${tb.x}" y1="${tb.y + 28}" x2="${tb.x + tb.width}" y2="${tb.y + 28}" stroke="#544337" stroke-width="1.0" />
      <text x="${tb.x + 12}" y="${tb.y + 18}" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="700" fill="#b76308" letter-spacing="0.08em">${esc(tb.company)}</text>
      
      <!-- Middle rows -->
      <line x1="${tb.x}" y1="${tb.y + 54}" x2="${tb.x + tb.width}" y2="${tb.y + 54}" stroke="#544337" stroke-width="0.8" />
      <text x="${tb.x + 12}" y="${tb.y + 44}" font-family="'JetBrains Mono', monospace" font-size="9" font-weight="600" fill="#544337">PART: <tspan font-weight="700" fill="#140d07">${esc(tb.partName)}</tspan></text>
      
      <line x1="${tb.x}" y1="${tb.y + 80}" x2="${tb.x + tb.width}" y2="${tb.y + 80}" stroke="#544337" stroke-width="0.8" />
      <text x="${tb.x + 12}" y="${tb.y + 70}" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="600" fill="#544337">MAT: <tspan font-weight="700" fill="#140d07">${esc(tb.material)}</tspan></text>
      <text x="${tb.x + 200}" y="${tb.y + 70}" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="600" fill="#544337">PROC: <tspan font-weight="700" fill="#140d07">${esc(tb.process)}</tspan></text>

      <!-- Bottom columns -->
      <line x1="${tb.x + 120}" y1="${tb.y + 80}" x2="${tb.x + 120}" y2="${tb.y + tb.height}" stroke="#544337" stroke-width="0.8" />
      <line x1="${tb.x + 240}" y1="${tb.y + 80}" x2="${tb.x + 240}" y2="${tb.y + tb.height}" stroke="#544337" stroke-width="0.8" />

      <text x="${tb.x + 12}" y="${tb.y + 96}" font-family="'JetBrains Mono', monospace" font-size="7.5" font-weight="500" fill="#7a6251">DWG NO.</text>
      <text x="${tb.x + 12}" y="${tb.y + 110}" font-family="'JetBrains Mono', monospace" font-size="9.5" font-weight="700" fill="#140d07">${esc(tb.drawingId)}</text>

      <text x="${tb.x + 130}" y="${tb.y + 96}" font-family="'JetBrains Mono', monospace" font-size="7.5" font-weight="500" fill="#7a6251">REV</text>
      <text x="${tb.x + 130}" y="${tb.y + 110}" font-family="'JetBrains Mono', monospace" font-size="9.5" font-weight="700" fill="#140d07">${esc(tb.revision)}</text>

      <text x="${tb.x + 250}" y="${tb.y + 96}" font-family="'JetBrains Mono', monospace" font-size="7.5" font-weight="500" fill="#7a6251">DATE / UNITS</text>
      <text x="${tb.x + 250}" y="${tb.y + 110}" font-family="'JetBrains Mono', monospace" font-size="8.5" font-weight="700" fill="#140d07">${esc(tb.date)} · ${esc(tb.units)}</text>
    </g>
  `;

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="background-color: #fdfbf7; color-interpolation-filters: sRGB;">
  <defs>
    <!-- Dimension arrow markers -->
    <marker id="dim-arrow-start" viewBox="0 0 8 8" refX="2" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 8 1 L 1 4 L 8 7 Z" fill="#140d07" />
    </marker>
    <marker id="dim-arrow-end" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M 0 1 L 7 4 L 0 7 Z" fill="#140d07" />
    </marker>
  </defs>

  <!-- Sheet Outer Border -->
  <rect x="${m}" y="${m}" width="${w - m * 2}" height="${h - m * 2}" fill="none" stroke="#544337" stroke-width="2.0" />
  <!-- Sheet Inner Border -->
  <rect x="${im}" y="${im}" width="${w - im * 2}" height="${h - im * 2}" fill="none" stroke="#544337" stroke-width="1.0" />

  <!-- Sheet Grid Reference Labels -->
  <text x="${w / 2}" y="${im - 5}" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="8" fill="#a28d7e">REFORGE AI TECHNICAL SHEET · ISO A4 LANDSCAPE</text>

  <!-- Orthographic Views -->
  ${viewsMarkup}

  <!-- Technical Notes Block -->
  ${notesMarkup}

  <!-- Title Block -->
  ${titleBlockMarkup}
</svg>
  `.trim();
}
