/**
 * DamageHeatmapOverlay.jsx
 *
 * Image-space damage heatmap. It renders the ORIGINAL uploaded component
 * photograph and overlays the pixel-level RGBA mask generated from that same
 * photograph. Only segmented rust/corrosion/pitting pixels are painted; clean
 * surface and background pixels in the mask are fully transparent.
 *
 * This component is intentionally independent of part type and 3D geometry:
 * the same overlay works for gears, shafts, flanges, bearings or brackets.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  DAMAGE_LEVELS,
  getDamageHeatmapData,
} from '../lib/damage-heatmap.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function DamageHeatmapOverlay({ analysis, images, compact = false }) {
  const imageList = useMemo(
    () => (Array.isArray(images) ? images.filter((image) => image?.url) : []),
    [images]
  );
  const data = useMemo(
    () => getDamageHeatmapData(analysis?.conditionAssessment, imageList),
    [analysis, imageList]
  );

  const [selectedIndex, setSelectedIndex] = useState(data.preferredIndex);
  useEffect(() => {
    setSelectedIndex(data.preferredIndex);
  }, [data.preferredIndex]);

  const image = imageList[selectedIndex] || null;
  const visibleMask = data.masks.find((mask) => mask.imageIndex === selectedIndex) || null;
  const hasVisibleDamage = Boolean(visibleMask && visibleMask.stats.maskedPixels > 0);

  return (
    <div
      className={`damage-heatmap-overlay ${compact ? 'compact' : ''}`}
      role="region"
      aria-label="Image-based damage heatmap"
    >
      <div className="damage-heatmap-topbar">
        <Icon>local_fire_department</Icon>
        <span className="damage-heatmap-title">DAMAGE HEATMAP</span>
        <span className="damage-heatmap-subtitle">Segmented pixels on original image</span>
      </div>

      {imageList.length > 1 && !data.message && (
        <div className="damage-heatmap-thumbs" aria-label="Uploaded component views">
          {imageList.map((item, index) => (
            <button
              key={item.id || index}
              type="button"
              className={`damage-heatmap-thumb ${index === selectedIndex ? 'active' : ''}`}
              onClick={() => setSelectedIndex(index)}
              title={item.name || `View ${index + 1}`}
            >
              <img src={item.url} alt={item.name || `View ${index + 1}`} />
            </button>
          ))}
        </div>
      )}

      {data.message ? (
        <div className="damage-heatmap-message">
          <Icon>info</Icon>
          <span>{data.message}</span>
        </div>
      ) : (
        <div className="damage-heatmap-image-area">
          <div className="damage-heatmap-image-wrap">
            <img
              src={image.url}
              alt={`Original component image: ${image.name || `view ${selectedIndex + 1}`}`}
            />
            {hasVisibleDamage && (
              <img
                className="damage-mask-image"
                src={visibleMask.dataUrl}
                alt=""
                title={`Segmented damage covering ${(
                  visibleMask.stats.damageRatioOfComponent * 100
                ).toFixed(1)}% of the component · ${visibleMask.stats.severity || 'minor'} · ${
                  visibleMask.stats.extent
                }`}
              />
            )}
          </div>
          {!hasVisibleDamage && (
            <div className="damage-heatmap-view-note">
              No segmented damage in this view.
            </div>
          )}
        </div>
      )}

      <div className="damage-heatmap-legend" aria-label="Damage severity legend">
        <span className="damage-legend-title">DAMAGE SEVERITY</span>
        {DAMAGE_LEVELS.map((level) => (
          <span className="damage-legend-item" key={level.key}>
            <span
              className="damage-legend-swatch"
              style={{ background: level.color }}
            />
            {level.label}
          </span>
        ))}
        <span className="damage-legend-note">Unmarked = no damage detected</span>
      </div>
    </div>
  );
}

export default DamageHeatmapOverlay;
