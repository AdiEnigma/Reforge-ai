import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeWorkbenchState,
  deserializeWorkbenchState,
} from "./workbench-api.js";

test("1. serializeWorkbenchState strips browser Blobs and File objects", () => {
  const fakeBlob = { size: 1024, type: "image/png" };
  const rawState = {
    workbenchName: "Spur Gear Test",
    analysis: {
      componentName: "Spur Gear",
      dimensions: { outerDiameter: 100 },
    },
    machineryState: {
      primaryGear: {
        id: "comp-primary-gear",
        name: "Primary Spur Gear",
        role: "primary",
        reference: { outerDiameter: 100 },
        images: [
          {
            id: "img-1",
            name: "gear1.png",
            file: fakeBlob, // Non-serializable
            url: "blob:http://localhost:5173/1234-5678",
            assetId: "asset-uuid-1",
          },
          {
            id: "img-2",
            name: "gear2.png",
            file: fakeBlob,
            url: "/api/workbenches/wb-123/assets/asset-uuid-2",
            assetId: "asset-uuid-2",
          },
        ],
      },
      companionGear: null,
      additionalComponents: [],
    },
    stage: "ready",
    viewMode: "single",
    activeComponentId: "comp-primary-gear",
  };

  const serialized = serializeWorkbenchState("wb-123", rawState);

  // Assert JSON stringify works with zero error
  const jsonString = JSON.stringify(serialized);
  assert.ok(jsonString);

  const parsed = JSON.parse(jsonString);
  assert.equal(parsed.workbenchName, "Spur Gear Test");
  assert.equal(parsed.componentName, "Spur Gear");
  assert.equal(parsed.stage, "ready");

  const images = parsed.machineryState.primaryGear.images;
  assert.equal(images.length, 2);
  // Ensure 'file' property is stripped
  assert.equal(images[0].file, undefined);
  assert.equal(images[1].file, undefined);
  // Ensure durable asset URLs are resolved
  assert.equal(images[0].url, "/api/workbenches/wb-123/assets/asset-uuid-1");
  assert.equal(images[1].url, "/api/workbenches/wb-123/assets/asset-uuid-2");
});

test("2. deserializeWorkbenchState reconstructs valid state and hydrates images from assets", () => {
  const serializedState = {
    workbenchName: "Bevel Gear Set",
    componentName: "Bevel Gear",
    reference: { teeth: 30, coneAngle: 45 },
    analysis: {
      componentName: "Bevel Gear",
      componentType: "bevel_gear",
      dimensions: { outerDiameter: 85 },
    },
    machineryState: {
      primaryGear: {
        id: "comp-primary-gear",
        name: "Bevel Pinion",
        role: "primary",
        images: [
          {
            id: "img-1",
            name: "bevel.png",
            assetId: "asset-999",
          },
        ],
      },
    },
    stage: "ready",
    viewMode: "single",
  };

  const assets = [
    {
      id: "asset-999",
      workbenchId: "wb-456",
      originalFilename: "bevel.png",
      url: "/api/workbenches/wb-456/assets/asset-999",
    },
  ];

  const hydrated = deserializeWorkbenchState("wb-456", serializedState, assets);

  assert.ok(hydrated);
  assert.equal(hydrated.stage, "ready");
  assert.equal(hydrated.analysis.componentType, "bevel_gear");
  assert.equal(hydrated.machineryState.primaryGear.images[0].url, "/api/workbenches/wb-456/assets/asset-999");
  assert.equal(hydrated.machineryState.primaryGear.images[0].assetId, "asset-999");
});

test("3. serializeWorkbenchState gracefully handles null or empty inputs", () => {
  const empty = serializeWorkbenchState("wb-123", null);
  assert.deepEqual(empty, {});

  const minimal = serializeWorkbenchState("wb-123", {});
  assert.equal(minimal.stage, "idle");
  assert.deepEqual(minimal.machineryState.additionalComponents, []);
});
