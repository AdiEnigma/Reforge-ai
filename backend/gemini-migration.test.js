import test from "node:test";
import assert from "node:assert/strict";
import {
  getCandidateModels,
  isTransientError,
  isAuthError,
  sanitizeUserError,
  analyzeComponent,
  chatWithEngineer,
  sanitizeRecipe
} from "./gemini.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

test("1. Model Configuration: Candidate models deduplicate and order correctly", () => {
  const origEnv = process.env.GEMINI_MODEL;
  try {
    delete process.env.GEMINI_MODEL;
    const defaultModels = getCandidateModels();
    assert.deepEqual(defaultModels, ["gemini-4-argon", "gemini-4-carbon", "gemini-3.6-flash"]);

    process.env.GEMINI_MODEL = "gemini-4-carbon";
    const customModels = getCandidateModels();
    // GEMINI_MODEL is prioritized, duplicates removed
    assert.deepEqual(customModels, ["gemini-4-carbon", "gemini-4-argon", "gemini-3.6-flash"]);

    process.env.GEMINI_MODEL = "custom-special-model";
    const specialModels = getCandidateModels();
    assert.deepEqual(specialModels, ["custom-special-model", "gemini-4-argon", "gemini-4-carbon", "gemini-3.6-flash"]);
  } finally {
    if (origEnv !== undefined) {
      process.env.GEMINI_MODEL = origEnv;
    } else {
      delete process.env.GEMINI_MODEL;
    }
  }
});

test("2. Transient & Auth Error Classification", () => {
  // Transient HTTP codes
  assert.equal(isTransientError({ status: 429 }), true);
  assert.equal(isTransientError({ status: 500 }), true);
  assert.equal(isTransientError({ status: 502 }), true);
  assert.equal(isTransientError({ status: 503 }), true);
  assert.equal(isTransientError({ status: 504 }), true);

  // Transient error message patterns
  assert.equal(isTransientError(new Error("Resource has been exhausted (e.g. check quota)")), true);
  assert.equal(isTransientError(new Error("503 Service Unavailable: High demand")), true);
  assert.equal(isTransientError(new Error("fetch failed: ECONNRESET")), true);
  assert.equal(isTransientError(new Error("Network timeout after 30000ms")), true);

  // Non-transient errors
  assert.equal(isTransientError({ status: 400 }), false);
  assert.equal(isTransientError({ status: 401 }), false);
  assert.equal(isTransientError({ status: 403 }), false);
  assert.equal(isTransientError(new Error("Invalid JSON input")), false);

  // Auth errors
  assert.equal(isAuthError({ status: 401 }), true);
  assert.equal(isAuthError({ status: 403 }), true);
  assert.equal(isAuthError(new Error("API key not valid. Please pass a valid API key.")), true);
  assert.equal(isAuthError(new Error("API_KEY_INVALID")), true);
  assert.equal(isAuthError({ status: 500 }), false);
});

test("3. Safe User Error Sanitization: Never leaks secrets or raw internals", () => {
  const secretKey = "AIzaSySecretInternalKey123";
  const rawErr = new Error(`Failed to call backend with key ${secretKey}: 500 internal server error`);
  rawErr.status = 500;

  const sanitized = sanitizeUserError(rawErr, "Component analysis failed.");
  assert.equal(sanitized.message.includes(secretKey), false);
  assert.equal(sanitized.status, 500);

  const authErr = new Error(`API key not valid: ${secretKey}`);
  authErr.status = 401;
  const sanitizedAuth = sanitizeUserError(authErr);
  assert.equal(sanitizedAuth.message.includes(secretKey), false);
  assert.equal(sanitizedAuth.message.includes("Invalid Gemini API key"), true);
  assert.equal(sanitizedAuth.status, 401);

  const rateErr = new Error("429 Too Many Requests");
  rateErr.status = 429;
  const sanitizedRate = sanitizeUserError(rateErr);
  assert.equal(sanitizedRate.status, 429);
  assert.equal(sanitizedRate.message.includes("rate limit"), true);
});

test("4. Mock Test: Argon succeeds on first attempt", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origProto = GoogleGenerativeAI.prototype.getGenerativeModel;

  process.env.GEMINI_API_KEY = "dummy-test-key";
  delete process.env.GEMINI_MODEL;

  const modelsCalled = [];

  GoogleGenerativeAI.prototype.getGenerativeModel = function ({ model }) {
    modelsCalled.push(model);
    return {
      generateContent: async () => ({
        response: {
          text: () => JSON.stringify({
            componentType: "spur gear",
            confidence: 0.95,
            geometryType: "gear",
            dimensions: { outerDiameter: 80, innerDiameter: 25, height: 20 },
            features: ["teeth", "bore"],
            teeth: 38,
            module: 2,
            helixAngle: 0,
            materialEstimate: "hardened steel",
            manufacturingProcess: "gear hobbing",
            reasoning: "Clear cylindrical spur gear with central bore.",
            uncertainties: [],
            geometryRecipe: {
              style: "gear",
              gear: { teeth: 38, module: 2, pressureAngle: 20, helixAngle: 0, faceWidth: 20, boreRadius: 12.5 }
            }
          })
        }
      })
    };
  };

  try {
    const res = await analyzeComponent({
      images: [{ data: "base64", mimeType: "image/jpeg" }],
      reference: null,
      visionEvidence: null
    });

    assert.equal(res.componentType, "spur gear");
    assert.equal(res.teeth, 38);
    assert.equal(modelsCalled.length, 1);
    assert.equal(modelsCalled[0], "gemini-4-argon");
  } finally {
    GoogleGenerativeAI.prototype.getGenerativeModel = origProto;
    process.env.GEMINI_API_KEY = origKey;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
  }
});

test("5. Mock Test: Argon returns 503 and Carbon succeeds", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origProto = GoogleGenerativeAI.prototype.getGenerativeModel;

  process.env.GEMINI_API_KEY = "dummy-test-key";
  delete process.env.GEMINI_MODEL;

  const modelsCalled = [];

  GoogleGenerativeAI.prototype.getGenerativeModel = function ({ model }) {
    modelsCalled.push(model);
    return {
      generateContent: async () => {
        if (model === "gemini-4-argon") {
          const err = new Error("503 Service Unavailable");
          err.status = 503;
          throw err;
        }
        if (model === "gemini-4-carbon") {
          return {
            response: {
              text: () => JSON.stringify({
                componentType: "helical gear",
                confidence: 0.92,
                geometryType: "gear",
                dimensions: { outerDiameter: 90, innerDiameter: 30, height: 25 },
                features: ["teeth"],
                teeth: 45,
                geometryRecipe: {
                  style: "gear",
                  gear: { teeth: 45, module: 2 }
                }
              })
            }
          };
        }
        throw new Error("Unexpected model called");
      }
    };
  };

  try {
    const res = await analyzeComponent({
      images: [{ data: "base64", mimeType: "image/jpeg" }],
      reference: null,
      visionEvidence: null
    });

    assert.equal(res.componentType, "helical gear");
    assert.equal(res.teeth, 45);
    assert.equal(modelsCalled.includes("gemini-4-argon"), true);
    assert.equal(modelsCalled.includes("gemini-4-carbon"), true);
  } finally {
    GoogleGenerativeAI.prototype.getGenerativeModel = origProto;
    process.env.GEMINI_API_KEY = origKey;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
  }
});

test("6. Mock Test: Argon returns 429 and Carbon succeeds", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origProto = GoogleGenerativeAI.prototype.getGenerativeModel;

  process.env.GEMINI_API_KEY = "dummy-test-key";
  delete process.env.GEMINI_MODEL;

  const modelsCalled = [];

  GoogleGenerativeAI.prototype.getGenerativeModel = function ({ model }) {
    modelsCalled.push(model);
    return {
      generateContent: async () => {
        if (model === "gemini-4-argon") {
          const err = new Error("429 Too Many Requests: Quota exceeded");
          err.status = 429;
          throw err;
        }
        if (model === "gemini-4-carbon") {
          return {
            response: {
              text: () => JSON.stringify({
                componentType: "stepped shaft",
                confidence: 0.88,
                geometryType: "revolved",
                dimensions: { outerDiameter: 50, height: 120 },
                geometryRecipe: {
                  style: "revolved",
                  revolvedProfile: [{ z: 0, radius: 25 }, { z: 120, radius: 20 }]
                }
              })
            }
          };
        }
        throw new Error("Unexpected model called");
      }
    };
  };

  try {
    const res = await analyzeComponent({
      images: [{ data: "base64", mimeType: "image/jpeg" }],
      reference: null,
      visionEvidence: null
    });

    assert.equal(res.componentType, "stepped shaft");
    assert.equal(res.geometryRecipe.style, "revolved");
    assert.equal(modelsCalled.includes("gemini-4-argon"), true);
    assert.equal(modelsCalled.includes("gemini-4-carbon"), true);
  } finally {
    GoogleGenerativeAI.prototype.getGenerativeModel = origProto;
    process.env.GEMINI_API_KEY = origKey;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
  }
});

test("7. Mock Test: Argon and Carbon fail, Gemini 3.6 Flash succeeds", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origProto = GoogleGenerativeAI.prototype.getGenerativeModel;

  process.env.GEMINI_API_KEY = "dummy-test-key";
  delete process.env.GEMINI_MODEL;

  const modelsCalled = [];

  GoogleGenerativeAI.prototype.getGenerativeModel = function ({ model }) {
    modelsCalled.push(model);
    return {
      generateContent: async () => {
        if (model === "gemini-4-argon" || model === "gemini-4-carbon") {
          const err = new Error("503 Service Unavailable");
          err.status = 503;
          throw err;
        }
        if (model === "gemini-3.6-flash") {
          return {
            response: {
              text: () => JSON.stringify({
                componentType: "bearing flange",
                confidence: 0.85,
                geometryType: "extruded",
                dimensions: { outerDiameter: 100, innerDiameter: 40, height: 15 },
                geometryRecipe: {
                  style: "extruded",
                  outline: [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }],
                  depth: 15
                }
              })
            }
          };
        }
        throw new Error("Unexpected model called");
      }
    };
  };

  try {
    const res = await analyzeComponent({
      images: [{ data: "base64", mimeType: "image/jpeg" }],
      reference: null,
      visionEvidence: null
    });

    assert.equal(res.componentType, "bearing flange");
    assert.equal(res.geometryRecipe.style, "extruded");
    assert.equal(modelsCalled.includes("gemini-4-argon"), true);
    assert.equal(modelsCalled.includes("gemini-4-carbon"), true);
    assert.equal(modelsCalled.includes("gemini-3.6-flash"), true);
  } finally {
    GoogleGenerativeAI.prototype.getGenerativeModel = origProto;
    process.env.GEMINI_API_KEY = origKey;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
  }
});

test("8. Mock Test: All models fail with a safe user-facing error", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origProto = GoogleGenerativeAI.prototype.getGenerativeModel;

  process.env.GEMINI_API_KEY = "dummy-test-key";
  delete process.env.GEMINI_MODEL;

  GoogleGenerativeAI.prototype.getGenerativeModel = function () {
    return {
      generateContent: async () => {
        const err = new Error("500 Internal Provider Failure: AIzaSySecretDetails");
        err.status = 500;
        throw err;
      }
    };
  };

  try {
    await assert.rejects(
      async () => {
        await analyzeComponent({
          images: [{ data: "base64", mimeType: "image/jpeg" }],
          reference: null,
          visionEvidence: null
        });
      },
      (err) => {
        assert.equal(err.status, 500);
        assert.equal(err.message.includes("AIzaSySecretDetails"), false);
        return true;
      }
    );
  } finally {
    GoogleGenerativeAI.prototype.getGenerativeModel = origProto;
    process.env.GEMINI_API_KEY = origKey;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
  }
});

test("9. Mock Test: Invalid API key does not trigger fallback loop", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origProto = GoogleGenerativeAI.prototype.getGenerativeModel;

  process.env.GEMINI_API_KEY = "dummy-test-key";
  delete process.env.GEMINI_MODEL;

  const modelsCalled = [];

  GoogleGenerativeAI.prototype.getGenerativeModel = function ({ model }) {
    modelsCalled.push(model);
    return {
      generateContent: async () => {
        const err = new Error("API_KEY_INVALID: API key not valid. Please pass a valid API key.");
        err.status = 400;
        throw err;
      }
    };
  };

  try {
    await assert.rejects(
      async () => {
        await analyzeComponent({
          images: [{ data: "base64", mimeType: "image/jpeg" }],
          reference: null,
          visionEvidence: null
        });
      },
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.message.includes("Invalid Gemini API key"), true);
        return true;
      }
    );
    // Should immediately abort on argon without querying carbon or flash
    assert.equal(modelsCalled.length, 1);
    assert.equal(modelsCalled[0], "gemini-4-argon");
  } finally {
    GoogleGenerativeAI.prototype.getGenerativeModel = origProto;
    process.env.GEMINI_API_KEY = origKey;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
  }
});

test("10. Mock Test: Malformed JSON triggers fallback or safe rejection", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origProto = GoogleGenerativeAI.prototype.getGenerativeModel;

  process.env.GEMINI_API_KEY = "dummy-test-key";
  delete process.env.GEMINI_MODEL;

  GoogleGenerativeAI.prototype.getGenerativeModel = function () {
    return {
      generateContent: async () => ({
        response: {
          text: () => "THIS IS NOT VALID JSON { corrupt: [ "
        }
      })
    };
  };

  try {
    await assert.rejects(
      async () => {
        await analyzeComponent({
          images: [{ data: "base64", mimeType: "image/jpeg" }],
          reference: null,
          visionEvidence: null
        });
      },
      (err) => {
        assert.equal(typeof err.message, "string");
        return true;
      }
    );
  } finally {
    GoogleGenerativeAI.prototype.getGenerativeModel = origProto;
    process.env.GEMINI_API_KEY = origKey;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
  }
});

test("11. Mock Test: Chat fallback succeeds on secondary model", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origModel = process.env.GEMINI_MODEL;
  const origProto = GoogleGenerativeAI.prototype.getGenerativeModel;

  process.env.GEMINI_API_KEY = "dummy-test-key";
  delete process.env.GEMINI_MODEL;

  const modelsCalled = [];

  GoogleGenerativeAI.prototype.getGenerativeModel = function ({ model }) {
    modelsCalled.push(model);
    return {
      startChat: () => ({
        sendMessage: async () => {
          if (model === "gemini-4-argon") {
            const err = new Error("503 Service Unavailable");
            err.status = 503;
            throw err;
          }
          if (model === "gemini-4-carbon") {
            return {
              response: {
                text: () => "Yes, increasing the bore reduces rotational inertia and part mass."
              }
            };
          }
          throw new Error("Unexpected model");
        }
      })
    };
  };

  try {
    const res = await chatWithEngineer({
      message: "What happens if I increase the bore?",
      engineeringContext: { componentType: "spur gear" },
      history: []
    });

    assert.equal(res.text.includes("rotational inertia"), true);
    assert.equal(modelsCalled.includes("gemini-4-argon"), true);
    assert.equal(modelsCalled.includes("gemini-4-carbon"), true);
  } finally {
    GoogleGenerativeAI.prototype.getGenerativeModel = origProto;
    process.env.GEMINI_API_KEY = origKey;
    if (origModel !== undefined) process.env.GEMINI_MODEL = origModel;
  }
});

test("12. Sanitize Recipe & Normalization retains existing contracts", () => {
  const validRecipe = sanitizeRecipe({
    style: "gear",
    gear: { teeth: 24, module: 2.5, pressureAngle: 20, helixAngle: 0, faceWidth: 15, boreRadius: 10 }
  });
  assert.equal(validRecipe.style, "gear");
  assert.equal(validRecipe.gear.teeth, 24);
  assert.equal(validRecipe.gear.module, 2.5);

  const fallbackRecipe = sanitizeRecipe({
    style: "invalid-style",
    revolvedProfile: [{ z: 0, radius: 10 }, { z: 50, radius: 10 }]
  });
  assert.equal(fallbackRecipe.style, "revolved");
  assert.equal(fallbackRecipe.revolvedProfile.length, 2);
});
