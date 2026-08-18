import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const COMPONENT_STYLES = ["revolved", "extruded", "gear", "combination"];
const PRIMITIVE_KINDS = ["box", "cylinder", "sphere", "cone", "torus"];

const ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    componentType: { type: "STRING" },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
    geometryType: { type: "STRING" },
    dimensions: {
      type: "OBJECT",
      properties: {
        outerDiameter: { type: "NUMBER" },
        innerDiameter: { type: "NUMBER" },
        height: { type: "NUMBER" },
        width: { type: "NUMBER" },
        length: { type: "NUMBER" },
        thickness: { type: "NUMBER" },
      },
      required: ["outerDiameter", "innerDiameter", "height", "width", "length", "thickness"],
    },
    features: { type: "ARRAY", items: { type: "STRING" } },
    teeth: { type: "NUMBER" },
    module: { type: "NUMBER" },
    helixAngle: { type: "NUMBER" },
    materialEstimate: { type: "STRING" },
    manufacturingProcess: { type: "STRING" },
    reasoning: { type: "STRING" },
    uncertainties: { type: "ARRAY", items: { type: "STRING" } },
    geometryRecipe: {
      type: "OBJECT",
      properties: {
        style: { type: "STRING", enum: COMPONENT_STYLES },
        revolvedProfile: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { z: { type: "NUMBER" }, radius: { type: "NUMBER" } },
            required: ["z", "radius"],
          },
        },
        outline: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" } },
            required: ["x", "y"],
          },
        },
        holes: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { cx: { type: "NUMBER" }, cy: { type: "NUMBER" }, radius: { type: "NUMBER" } },
            required: ["cx", "cy", "radius"],
          },
        },
        depth: { type: "NUMBER" },
        gear: {
          type: "OBJECT",
          properties: {
            teeth: { type: "NUMBER" },
            module: { type: "NUMBER" },
            pressureAngle: { type: "NUMBER" },
            helixAngle: { type: "NUMBER" },
            faceWidth: { type: "NUMBER" },
            boreRadius: { type: "NUMBER" },
          },
        },
        primitives: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              kind: { type: "STRING", enum: PRIMITIVE_KINDS },
              width: { type: "NUMBER" },
              height: { type: "NUMBER" },
              depth: { type: "NUMBER" },
              radius: { type: "NUMBER" },
              radiusTop: { type: "NUMBER" },
              radiusBottom: { type: "NUMBER" },
              tube: { type: "NUMBER" },
              radialSegments: { type: "NUMBER" },
              position: {
                type: "OBJECT",
                properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, z: { type: "NUMBER" } },
                required: ["x", "y", "z"],
              },
              rotation: {
                type: "OBJECT",
                properties: { x: { type: "NUMBER" }, y: { type: "NUMBER" }, z: { type: "NUMBER" } },
                required: ["x", "y", "z"],
              },
            },
            required: ["kind", "position", "rotation"],
          },
        },
      },
    },
  },
  required: [
    "componentType",
    "confidence",
    "geometryType",
    "dimensions",
    "features",
    "teeth",
    "materialEstimate",
    "manufacturingProcess",
    "reasoning",
    "uncertainties",
    "geometryRecipe",
  ],
};

const RECIPE_LIMITS = {
  maxProfilePoints: 200,
  maxOutlinePoints: 200,
  maxHoles: 50,
  maxPrimitives: 30,
  maxDimensionRatio: 1000,
};

function cleanNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

function client() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const error = new Error("GEMINI_API_KEY is not configured on the server.");
    error.status = 500;
    throw error;
  }
  return new GoogleGenerativeAI(key);
}

function model(client) {
  return client.getGenerativeModel({
    model: MODEL,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
  });
}

function referenceBlock(reference) {
  if (!reference || typeof reference !== "object") {
    return "No absolute reference was provided. Estimate relative proportions only; set dimension values to null when they cannot be determined.";
  }
  const rows = [];
  const linear = [
    ["outerDiameter", "outer diameter"],
    ["innerDiameter", "inner diameter (bore)"],
    ["height", "height/length"],
    ["thickness", "thickness/width"],
    ["width", "width"],
    ["length", "length"],
  ];
  for (const [key, label] of linear) {
    if (reference[key] != null) rows.push(`- ${label} = ${reference[key]} mm`);
  }
  if (reference.teeth != null) rows.push(`- teeth count = ${reference.teeth}`);
  if (reference.module != null) rows.push(`- gear module = ${reference.module} mm`);
  if (reference.helixAngle != null) rows.push(`- helix angle = ${reference.helixAngle} degrees`);
  if (rows.length === 0) {
    return "No absolute reference was provided. Estimate relative proportions only; set dimension values to null when they cannot be determined.";
  }
  return [
    "Known reference dimensions are provided. Treat them as ground truth: they take priority over image estimates when they disagree. Use them to calibrate every estimated dimension in millimetres:",
    ...rows,
  ].join("\n");
}

function analysisPrompt(reference) {
  return [
    "You are a mechanical reverse-engineering analyst. Inspect the provided component photographs jointly and classify the part.",
    'Classify the part with a specific, free-form component type (e.g. "helical gear", "spur gear", "shaft", "flange", "bearing", "valve", "bolt", "bracket"). Do NOT limit yourself to a fixed list.',
    referenceBlock(reference),
    "Return a single JSON object matching the schema. Rules:",
    "- dimensions.outerDiameter: largest outside diameter; use null if not visible.",
    "- dimensions.innerDiameter: bore or central hole diameter; null if solid.",
    "- dimensions.height: axial length along the axis of revolution (or overall height for other parts).",
    "- dimensions.width/length: bounding extents perpendicular to the axis for non-revolved parts; null for revolved parts.",
    "- dimensions.thickness: web/rim thickness or plate thickness; null if not visible.",
    "- features: visible details such as teeth, bolt holes, keyway, chamfers, ribs, grooves.",
    "- teeth: exact integer count only when clearly countable, otherwise null.",
    "- module: gear module in mm (pitch diameter / teeth). Only for toothed gears; otherwise null.",
    "- helixAngle: helix angle in degrees for helical gears; 0 for spur gears; null for non-gears.",
    "- confidence: 0..1 reflecting how sure you are of the component classification.",
    "- materialEstimate: e.g. hardened steel, cast aluminium, brass. Use 'unknown' when ambiguous.",
    "- manufacturingProcess: e.g. CNC machining, casting, forging, injection moulding. Use 'unknown' when ambiguous.",
    "- reasoning: 1-3 sentences justifying the classification and measurements.",
    "- uncertainties: list the specific measurements you could not determine and why.",
    "Prefer leaving a value as null over guessing a wrong number.",
    "",
    "GEOMETRY RECIPE (geometryRecipe): produce a construction recipe the renderer can execute. Pick ONE style and fill only its fields:",
    '- "revolved": axisymmetric parts (shafts, pulleys, flanges, valve bodies, couplings). Provide revolvedProfile as 3-8 points {z, radius} tracing the meridian outline from one axial end to the other. z is the position along the axis of revolution, radius is the radial distance (radius >= 0).',
    '- "extruded": plates, brackets, housings, levers. Provide outline as a closed polygon of 3-12 points {x, y} plus optional holes [{cx, cy, radius}] for through-holes, and depth (extrude thickness).',
    '- "gear": toothed wheels. Provide gear = {teeth, module, pressureAngle (default 20), helixAngle (0 = spur, > 0 = helical), faceWidth (tooth face width), boreRadius}. Mirror teeth/module/helixAngle into the top-level fields too.',
    '- "combination": complex or ambiguous parts. Compose from up to ~8 additive primitives (kind: box | cylinder | sphere | cone | torus), each with its size fields, position and rotation.',
    "All recipe lengths are in mm, angles in degrees, counts as integers. Use sane, bounded magnitudes — never extreme values like 50000 or 0.0001. If you cannot determine a recipe, still provide a minimal \"combination\" so the renderer always has something to build.",
  ].join("\n");
}

function stripFences(text) {
  let t = String(text || "").trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  return t;
}

function normalizeAnalysis(raw) {
  const out = {
    componentType: "other",
    confidence: 0,
    geometryType: "",
    dimensions: {
      outerDiameter: null,
      innerDiameter: null,
      height: null,
      width: null,
      length: null,
      thickness: null,
    },
    features: [],
    teeth: null,
    module: null,
    helixAngle: null,
    materialEstimate: "",
    manufacturingProcess: "",
    reasoning: "",
    uncertainties: [],
    geometryRecipe: null,
  };
  if (!raw || typeof raw !== "object") return out;
  const dims = raw.dimensions && typeof raw.dimensions === "object" ? raw.dimensions : {};
  out.componentType = typeof raw.componentType === "string" ? raw.componentType : "other";
  out.confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  out.geometryType = typeof raw.geometryType === "string" ? raw.geometryType : "";
  for (const key of Object.keys(out.dimensions)) {
    const value = dims[key];
    out.dimensions[key] = typeof value === "number" && isFinite(value) && value > 0 ? value : null;
  }
  out.features = Array.isArray(raw.features) ? raw.features.filter((f) => typeof f === "string") : [];
  out.teeth = typeof raw.teeth === "number" && isFinite(raw.teeth) ? Math.round(raw.teeth) : null;
  out.module = cleanNumber(raw.module);
  out.helixAngle = cleanNumber(raw.helixAngle);
  out.materialEstimate = typeof raw.materialEstimate === "string" ? raw.materialEstimate : "";
  out.manufacturingProcess = typeof raw.manufacturingProcess === "string" ? raw.manufacturingProcess : "";
  out.reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
  out.uncertainties = Array.isArray(raw.uncertainties) ? raw.uncertainties.filter((u) => typeof u === "string") : [];
  out.geometryRecipe = sanitizeRecipe(raw.geometryRecipe);
  return out;
}

function sanitizeRecipe(rawRecipe) {
  if (!rawRecipe || typeof rawRecipe !== "object") return null;
  const recipe = {};
  recipe.style = COMPONENT_STYLES.includes(rawRecipe.style) ? rawRecipe.style : null;

  const profile = Array.isArray(rawRecipe.revolvedProfile) ? rawRecipe.revolvedProfile.slice(0, RECIPE_LIMITS.maxProfilePoints) : [];
  const cleanProfile = [];
  for (const pt of profile) {
    if (!pt || typeof pt !== "object") continue;
    const z = cleanNumber(pt.z);
    const radius = cleanNumber(pt.radius);
    if (z == null || radius == null) continue;
    cleanProfile.push({ z, radius: Math.max(0, radius) });
  }
  if (cleanProfile.length >= 2) {
    cleanProfile.sort((a, b) => a.z - b.z);
    recipe.revolvedProfile = cleanProfile;
  }

  const outline = Array.isArray(rawRecipe.outline) ? rawRecipe.outline.slice(0, RECIPE_LIMITS.maxOutlinePoints) : [];
  const cleanOutline = [];
  for (const pt of outline) {
    if (!pt || typeof pt !== "object") continue;
    const x = cleanNumber(pt.x);
    const y = cleanNumber(pt.y);
    if (x == null || y == null) continue;
    cleanOutline.push({ x, y });
  }
  if (cleanOutline.length >= 3) recipe.outline = cleanOutline;

  const holes = Array.isArray(rawRecipe.holes) ? rawRecipe.holes.slice(0, RECIPE_LIMITS.maxHoles) : [];
  const cleanHoles = [];
  for (const h of holes) {
    if (!h || typeof h !== "object") continue;
    const cx = cleanNumber(h.cx);
    const cy = cleanNumber(h.cy);
    const radius = cleanNumber(h.radius);
    if (cx == null || cy == null || radius == null || radius <= 0) continue;
    cleanHoles.push({ cx, cy, radius });
  }
  if (cleanHoles.length) recipe.holes = cleanHoles;

  const depth = cleanNumber(rawRecipe.depth);
  if (depth != null && depth > 0) recipe.depth = depth;

  const g = rawRecipe.gear && typeof rawRecipe.gear === "object" ? rawRecipe.gear : {};
  const gear = {
    teeth: cleanNumber(g.teeth),
    module: cleanNumber(g.module),
    pressureAngle: cleanNumber(g.pressureAngle),
    helixAngle: cleanNumber(g.helixAngle),
    faceWidth: cleanNumber(g.faceWidth),
    boreRadius: cleanNumber(g.boreRadius),
  };
  if (Object.values(gear).some((v) => v != null)) recipe.gear = gear;

  const primitives = Array.isArray(rawRecipe.primitives) ? rawRecipe.primitives.slice(0, RECIPE_LIMITS.maxPrimitives) : [];
  const cleanPrimitives = [];
  for (const p of primitives) {
    if (!p || typeof p !== "object" || !PRIMITIVE_KINDS.includes(p.kind)) continue;
    const item = { kind: p.kind };
    for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube", "radialSegments"]) {
      const v = cleanNumber(p[key]);
      if (v != null) item[key] = v;
    }
    const pos = p.position && typeof p.position === "object" ? p.position : {};
    if (cleanNumber(pos.x) != null || cleanNumber(pos.y) != null || cleanNumber(pos.z) != null) {
      item.position = { x: cleanNumber(pos.x) || 0, y: cleanNumber(pos.y) || 0, z: cleanNumber(pos.z) || 0 };
    }
    const rot = p.rotation && typeof p.rotation === "object" ? p.rotation : {};
    if (cleanNumber(rot.x) != null || cleanNumber(rot.y) != null || cleanNumber(rot.z) != null) {
      item.rotation = { x: cleanNumber(rot.x) || 0, y: cleanNumber(rot.y) || 0, z: cleanNumber(rot.z) || 0 };
    }
    cleanPrimitives.push(item);
  }
  if (cleanPrimitives.length) recipe.primitives = cleanPrimitives;

  if (!recipe.style) {
    if (recipe.gear) recipe.style = "gear";
    else if (recipe.revolvedProfile) recipe.style = "revolved";
    else if (recipe.outline) recipe.style = "extruded";
    else if (recipe.primitives) recipe.style = "combination";
  }

  const dims = [];
  for (const p of recipe.revolvedProfile || []) dims.push(p.z, p.radius);
  for (const pt of recipe.outline || []) dims.push(Math.abs(pt.x), Math.abs(pt.y));
  for (const h of recipe.holes || []) dims.push(h.radius);
  if (recipe.depth != null) dims.push(recipe.depth);
  if (recipe.gear) {
    for (const key of ["module", "faceWidth", "boreRadius"]) {
      if (recipe.gear[key] != null) dims.push(Math.abs(recipe.gear[key]));
    }
  }
  for (const p of recipe.primitives || []) {
    for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]) {
      if (p[key] != null) dims.push(Math.abs(p[key]));
    }
  }
  const positive = dims.filter((d) => typeof d === "number" && isFinite(d) && d > 0);
  if (positive.length) {
    const sorted = [...positive].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const cap = Math.max(median * RECIPE_LIMITS.maxDimensionRatio, 1000);
    const clip = (v) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(v, cap)) : v);
    for (const p of recipe.revolvedProfile || []) { p.z = clip(p.z); p.radius = clip(p.radius); }
    for (const pt of recipe.outline || []) { pt.x = clip(pt.x); pt.y = clip(pt.y); }
    for (const h of recipe.holes || []) h.radius = clip(h.radius);
    if (recipe.depth != null) recipe.depth = clip(recipe.depth);
    if (recipe.gear) {
      for (const key of ["module", "faceWidth", "boreRadius"]) {
        if (recipe.gear[key] != null) recipe.gear[key] = clip(recipe.gear[key]);
      }
    }
    for (const p of recipe.primitives || []) {
      for (const key of ["width", "height", "depth", "radius", "radiusTop", "radiusBottom", "tube"]) {
        if (p[key] != null) p[key] = clip(p[key]);
      }
    }
  }

  if (!recipe.style) return null;
  if (!(recipe.revolvedProfile || recipe.outline || recipe.gear || recipe.primitives)) return null;
  return recipe;
}

export async function analyzeComponent({ images, reference }) {
  const genAI = client();
  const parts = images.map((image) => ({
    inlineData: { data: image.data, mimeType: image.mimeType },
  }));
  parts.push({ text: analysisPrompt(reference) });

  const attempt = async (withSchema) => {
    const result = await model(genAI).generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: withSchema
        ? { responseMimeType: "application/json", temperature: 0.2, responseSchema: ANALYSIS_SCHEMA }
        : { responseMimeType: "application/json", temperature: 0.2 },
    });
    return JSON.parse(stripFences(result.response.text()));
  };

  let raw;
  try {
    raw = await attempt(false);
  } catch (parseOrSchemaError) {
    try {
      raw = await attempt(true);
    } catch (schemaError) {
      raw = {
        reasoning: "Gemini could not produce a valid analysis JSON. Please retry with clearer images or more reference dimensions.",
        uncertainties: [String(schemaError?.message || schemaError)],
      };
    }
  }

  return normalizeAnalysis(raw);
}

function chatSystemInstruction(analysis) {
  const context = analysis && typeof analysis === "object" && Object.keys(analysis).length
    ? JSON.stringify(analysis, null, 2)
    : "No component analysis has been completed yet in this session.";
  return [
    "You are the ReForge AI Engineer, an expert mechanical engineer working on reverse engineering and remanufacturing.",
    "You answer ONLY questions about the currently analysed component. Do not drift into generic chat.",
    "Refer to the current component analysis as your source of truth. If the analysis is missing or a requested detail was not measured, say so explicitly and suggest how to obtain it.",
    "Be concise, technical, and use metric units (mm).",
    "",
    "CURRENT COMPONENT ANALYSIS:",
    context,
  ].join("\n");
}

function toHistory(history) {
  const clean = [];
  for (const item of Array.isArray(history) ? history : []) {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const role = item.role === "user" ? "user" : "model";
    clean.push({ role, parts: [{ text }] });
  }
  return clean;
}

export async function chatWithEngineer({ message, analysis, history }) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) throw Object.assign(new Error("Message cannot be empty."), { status: 400 });
  const genAI = client();
  const chat = model(genAI).startChat({
    history: toHistory(history),
    generationConfig: { temperature: 0.4 },
  });
  const result = await chat.sendMessage([
    { text: chatSystemInstruction(analysis) },
    { text },
  ]);
  const reply = result.response.text();
  if (!reply) throw new Error("Gemini returned an empty response.");
  return { text: reply.trim() };
}
