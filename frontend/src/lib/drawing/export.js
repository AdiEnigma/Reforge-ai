/**
 * export.js
 * Multi-Format Engineering Drawing Export (SVG, PNG, PDF).
 */

import { jsPDF } from "jspdf";

/**
 * Triggers a browser file download from a Blob.
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 300);
}

/**
 * Export drawing directly as SVG vector file.
 */
export function exportSvg(svgString, filename = "engineering-drawing.svg") {
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  downloadBlob(blob, filename.endsWith(".svg") ? filename : `${filename}.svg`);
}

/**
 * Converts SVG string into an Image element.
 */
function svgToImage(svgString) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

/**
 * Export drawing as high-resolution PNG (default 3x scale for print quality).
 */
export async function exportPng(svgString, filename = "engineering-drawing.png", scale = 3) {
  const img = await svgToImage(svgString);
  const canvas = document.createElement("canvas");
  const baseW = 1188;
  const baseH = 840;
  canvas.width = baseW * scale;
  canvas.height = baseH * scale;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context for PNG export.");

  // Clean background
  ctx.fillStyle = "#fdfbf7";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("Canvas toBlob failed."));
        downloadBlob(blob, filename.endsWith(".png") ? filename : `${filename}.png`);
        resolve();
      },
      "image/png",
      1.0
    );
  });
}

/**
 * Export drawing as ISO A4 Landscape PDF.
 */
export async function exportPdf(svgString, drawingModel, filename = "engineering-drawing.pdf") {
  const img = await svgToImage(svgString);
  const canvas = document.createElement("canvas");
  const scale = 2; // 2x scale for sharp PDF embedding
  const baseW = 1188;
  const baseH = 840;
  canvas.width = baseW * scale;
  canvas.height = baseH * scale;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context for PDF export.");

  ctx.fillStyle = "#fdfbf7";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const imgData = canvas.toDataURL("image/png");

  // Create A4 Landscape PDF (297 x 210 mm)
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4",
  });

  doc.addImage(imgData, "PNG", 0, 0, 297, 210);
  doc.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}
