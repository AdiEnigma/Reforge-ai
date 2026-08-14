import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    componentType: {
      type: "STRING",
      enum: ["spur gear", "cylinder/shaft", "flange", "bearing", "simple bracket", "other"],
    },
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
    materialEstimate: { type: "STRING" },
    manufacturingProcess: { type: "STRING" },
    reasoning: { type: "STRING" },
    uncertainties: { type: "ARRAY", items: { type: "STRING" } },
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
  ],
};

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

function analysisPrompt(reference) {
  const referenceLine = reference && reference.outerDiameter != null
    ? `A known reference is provided: the true outer diameter is approximately ${reference.outerDiameter} mm. Use it to calibrate every estimated dimension in millimetres.`
    : "No absolute reference was provided. Estimate relative proportions only; set dimension values to null when they cannot be determined.";
  return [
    "You are a mechanical reverse-engineering analyst. Inspect the provided component photographs jointly and classify the part.",
    "Use ONLY one of these component types: spur gear, cylinder/shaft, flange, bearing, simple bracket, other.",
    referenceLine,
    "Return a single JSON object matching the schema. Rules:",
    "- dimensions.outerDiameter: largest outside diameter; use null if not visible.",
    "- dimensions.innerDiameter: bore or central hole diameter; null if solid.",
    "- dimensions.height: axial length along the axis of revolution (or overall height for brackets).",
    "- dimensions.width/length: bounding extents perpendicular to the axis for non-revolved parts; null for revolved parts.",
    "- dimensions.thickness: web/rim thickness or plate thickness; null if not visible.",
    "- features: visible details such as teeth, bolt holes, keyway, chamfers, ribs, grooves.",
    "- teeth: exact integer count only when clearly countable, otherwise null.",
    "- confidence: 0..1 reflecting how sure you are of the component classification.",
    "- materialEstimate: e.g. hardened steel, cast aluminium, brass. Use 'unknown' when ambiguous.",
    "- manufacturingProcess: e.g. CNC machining, casting, forging, injection moulding. Use 'unknown' when ambiguous.",
    "- reasoning: 1-3 sentences justifying the classification and measurements.",
    "- uncertainties: list the specific measurements you could not determine and why.",
    "Prefer leaving a value as null over guessing a wrong number.",
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
    materialEstimate: "",
    manufacturingProcess: "",
    reasoning: "",
    uncertainties: [],
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
  out.materialEstimate = typeof raw.materialEstimate === "string" ? raw.materialEstimate : "";
  out.manufacturingProcess = typeof raw.manufacturingProcess === "string" ? raw.manufacturingProcess : "";
  out.reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
  out.uncertainties = Array.isArray(raw.uncertainties) ? raw.uncertainties.filter((u) => typeof u === "string") : [];
  return out;
}

export async function analyzeComponent({ images, reference }) {
  const genAI = client();
  const parts = images.map((image) => ({
    inlineData: { data: image.data, mimeType: image.mimeType },
  }));
  parts.push({ text: analysisPrompt(reference) });

  let raw;
  try {
    const result = await model(genAI).generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    });
    raw = JSON.parse(stripFences(result.response.text()));
  } catch (parseOrSchemaError) {
    const result = await model(genAI).generateContent({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, responseSchema: ANALYSIS_SCHEMA },
    });
    raw = JSON.parse(stripFences(result.response.text()));
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
