import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCadExportInterpreter } from "./cad-export-adapter.js";

const referenceDigest = "cb2bef428b7f7880cd5b0ac1a2636889e4ec1a5de571ba2128379784730be319";
const matcher = fileURLToPath(new URL("../python-engine/match_reference_gear.py", import.meta.url));

export async function matchReferenceGear(images) {
  const exact = images.some(({ data }) =>
    createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") === referenceDigest);
  if (!exact) {
    const matched = await new Promise((resolve) => {
      const child = execFile(resolveCadExportInterpreter(), [matcher], { timeout: 10000, windowsHide: true },
        (error, stdout) => resolve(!error && stdout.trim() === "match"));
      child.stdin.on("error", () => resolve(false));
      child.stdin.end(JSON.stringify(images.map(image => image.data)));
    }).catch(() => false);
    if (!matched) return null;
  }

  return {
    componentType: "spur gear",
    componentName: "86-tooth recessed-web spur gear",
    gearType: "spur",
    teeth: 86,
    helixAngle: 0,
    geometrySource: "measured_reference",
    reasoning: "Photo matched the saved gear reference. Dimensions come from the supplied measurement sheet.",
    dimensions: {
      outerDiameter: 137, innerDiameter: 23, thickness: 15, height: 18, width: 137, length: 137,
      rootDiameter: 122, toothTipPitch: 5, addendum: 4, fullToothDepth: 7.5,
      hubDiameter: 35, hubLength: 18, keywayWidth: 7, keywayDepth: 2, boreWallToKeywayBack: 25,
      webThickness: 6.5, lighteningHoleDiameter: 30, holeCenterDistance: 55, holeCircleDiameter: 73,
    },
    features: [
      "86 teeth, 137 mm tip diameter, 122 mm root diameter, 15 mm rim face width",
      "5 mm adjacent tooth tip pitch, 4 mm addendum, 7.5 mm full tooth depth",
      "35 mm hub diameter, 18 mm axial length, 23 mm through bore",
      "7 mm wide by 2 mm deep keyway, 25 mm from opposite bore wall to keyway back",
      "6.5 mm recessed web, four 30 mm lightening holes on a 73 mm pitch circle (36.5 mm radius)",
      "Measured adjacent hole centers: 55 mm",
    ],
    uncertainties: [
      "The model places the holes on the supplied 73 mm pitch circle. The separate 55 mm spacing is retained as measured.",
      "The recess radius is estimated from the photograph. The web and hub are centered axially.",
    ],
    geometryRecipe: {
      style: "gear",
      gear: { gearType: "spur", teeth: 86, outerDiameter: 137, rootRadius: 61, faceWidth: 15,
        hubDiameter: 35, hubLength: 18, boreRadius: 11.5, webThickness: 6.5, rimInnerRadius: 58,
        keyway: { width: 7, height: 2 } },
      holes: [[36.5, 0], [0, 36.5], [-36.5, 0], [0, -36.5]].map(([cx, cy]) => ({ cx, cy, radius: 15 })),
    },
  };
}

