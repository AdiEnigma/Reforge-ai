/**
 * geometry.js
 * 2D Vector Primitives & CAD Geometry Definitions for Engineering Drawings.
 */

/**
 * 2D Point
 */
export function pt(x, y) {
  return { x: Number(x) || 0, y: Number(y) || 0 };
}

/**
 * 2D Line entity
 */
export function line(x1, y1, x2, y2, layer = "visible", options = {}) {
  return {
    type: "line",
    x1: Number(x1) || 0,
    y1: Number(y1) || 0,
    x2: Number(x2) || 0,
    y2: Number(y2) || 0,
    layer, // "visible" | "hidden" | "centerline" | "dimension" | "extension"
    ...options,
  };
}

/**
 * 2D Rectangle entity
 */
export function rect(x, y, width, height, layer = "visible", options = {}) {
  return {
    type: "rect",
    x: Number(x) || 0,
    y: Number(y) || 0,
    width: Math.max(0, Number(width) || 0),
    height: Math.max(0, Number(height) || 0),
    layer,
    ...options,
  };
}

/**
 * 2D Circle entity
 */
export function circle(cx, cy, radius, layer = "visible", options = {}) {
  return {
    type: "circle",
    cx: Number(cx) || 0,
    cy: Number(cy) || 0,
    radius: Math.max(0, Number(radius) || 0),
    layer,
    ...options,
  };
}

/**
 * 2D Arc entity
 */
export function arc(cx, cy, radius, startAngle, endAngle, layer = "visible", options = {}) {
  return {
    type: "arc",
    cx: Number(cx) || 0,
    cy: Number(cy) || 0,
    radius: Math.max(0, Number(radius) || 0),
    startAngle: Number(startAngle) || 0,
    endAngle: Number(endAngle) || 0,
    layer,
    ...options,
  };
}

/**
 * 2D Polygon / Path entity
 */
export function path(points, closed = true, layer = "visible", options = {}) {
  return {
    type: "path",
    points: Array.isArray(points) ? points.map((p) => pt(p.x, p.y)) : [],
    closed: Boolean(closed),
    layer,
    ...options,
  };
}

/**
 * Centerline Cross Mark (for hole centers)
 */
export function centerMark(cx, cy, size = 6, options = {}) {
  const s = size / 2;
  return {
    type: "centerMark",
    cx: Number(cx) || 0,
    cy: Number(cy) || 0,
    size: s,
    layer: "centerline",
    ...options,
  };
}

/**
 * Linear Dimension Entity
 */
export function dimension({
  id,
  type = "linear", // "linear" | "horizontal" | "vertical" | "diameter" | "radius" | "holeCallout"
  x1,
  y1,
  x2,
  y2,
  textX,
  textY,
  value,
  label,
  source = "geometryRecipe", // "geometryRecipe" | "analysis"
  confidence = 1.0,
  orientation = "horizontal", // "horizontal" | "vertical" | "aligned" | "radial"
  offset = 20,
  options = {},
}) {
  return {
    id: id || `dim-${Math.random().toString(36).slice(2, 8)}`,
    type,
    x1: Number(x1) || 0,
    y1: Number(y1) || 0,
    x2: Number(x2) || 0,
    y2: Number(y2) || 0,
    textX: textX != null ? Number(textX) : (Number(x1) + Number(x2)) / 2,
    textY: textY != null ? Number(textY) : (Number(y1) + Number(y2)) / 2,
    value: Number(value) || 0,
    label: label || `${Number(value) || 0}`,
    source,
    confidence: Number(confidence) || 1.0,
    orientation,
    offset: Number(offset) || 20,
    isEstimated: source !== "geometryRecipe",
    ...options,
  };
}
