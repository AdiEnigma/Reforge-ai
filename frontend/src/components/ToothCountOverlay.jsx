/**
 * ToothCountOverlay.jsx
 *
 * Image-space tooth-tip markers produced by the optional vision engine.
 * Markers are stored in the source image's pixel coordinate system and drawn
 * as percentages, so they stay aligned when the uploaded photo is displayed
 * at a different CSS size or was resized before analysis.
 */
import React, { useEffect, useMemo, useState } from 'react';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function ToothCountOverlay({ analysis, images, compact = false }) {
  const toothCount = analysis?.toothCountVision;
  const imageList = useMemo(
    () => (Array.isArray(images) ? images.filter((image) => image?.url) : []),
    [images]
  );
  const requestedIndex = Number.isInteger(toothCount?.imageIndex) ? toothCount.imageIndex : 0;
  const selectedIndex = imageList[requestedIndex] ? requestedIndex : 0;
  const image = imageList[selectedIndex] || null;

  const [natural, setNatural] = useState({ width: null, height: null });
  useEffect(() => {
    setNatural({
      width: Number.isFinite(toothCount?.imageWidth) ? toothCount.imageWidth : null,
      height: Number.isFinite(toothCount?.imageHeight) ? toothCount.imageHeight : null,
    });
  }, [toothCount?.imageIndex, toothCount?.imageWidth, toothCount?.imageHeight]);

  if (!toothCount) return null;

  const status = toothCount.status || 'unavailable';
  const confirmed = status === 'ok' && Number.isFinite(toothCount.count);
  const markers = confirmed && Array.isArray(toothCount.teeth) ? toothCount.teeth : [];
  const width = natural.width || (confirmed ? Math.max(...markers.map((t) => t.x_px || 0), 1) : 1);
  const height = natural.height || (confirmed ? Math.max(...markers.map((t) => t.y_px || 0), 1) : 1);
  const confidencePct = Math.round((toothCount.confidence || 0) * 100);
  const warnings = Array.isArray(toothCount.warnings) ? toothCount.warnings : [];

  return (
    <div className={`tooth-count-overlay ${compact ? 'compact' : ''}`} role="region" aria-label="Automatic tooth count">
      <div className="tooth-count-topbar">
        <Icon>grid_4x4</Icon>
        <span className="tooth-count-title">TOOTH-TIP COUNT</span>
        {confirmed ? (
          <span className="tooth-count-result">{toothCount.count} T</span>
        ) : (
          <span className="tooth-count-result uncertain">NOT CONFIRMED</span>
        )}
        <span className="tooth-count-confidence" title="Cross-checked detection confidence">
          {confidencePct}%
        </span>
      </div>

      {!image ? (
        <div className="tooth-count-message">
          <Icon>image</Icon>
          <span>No uploaded image is available for tooth visualisation.</span>
        </div>
      ) : (
        <div className="tooth-count-image-area">
          <div className="tooth-count-image-wrap">
            <img
              src={image.url}
              alt={`Tooth tips on ${image.name || 'uploaded component'}`}
              onLoad={(event) => {
                if (!toothCount.imageWidth || !toothCount.imageHeight) {
                  setNatural({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                }
              }}
            />
            {markers.map((tooth, index) => (
              <span
                key={`${tooth.angle_deg}-${index}`}
                className="tooth-count-marker"
                style={{
                  left: `${Math.max(0, Math.min(100, ((tooth.x_px || 0) / width) * 100))}%`,
                  top: `${Math.max(0, Math.min(100, ((tooth.y_px || 0) / height) * 100))}%`,
                }}
                title={`Tooth ${index + 1} · ${Number(tooth.angle_deg || 0).toFixed(1)}° · r=${Number(tooth.radius_px || 0).toFixed(1)} px`}
              />
            ))}
            {!confirmed && (
              <span className="tooth-count-image-warning">
                <Icon>warning</Icon> No exact count reported
              </span>
            )}
          </div>
        </div>
      )}

      {Array.isArray(toothCount.methods) && toothCount.methods.length > 0 && (
        <div className="tooth-count-methods" aria-label="Cross-check methods">
          {toothCount.methods.map((method) => (
            <span
              key={method.method}
              className={`tooth-method-chip ${method.count === toothCount.count ? 'agree' : 'outlier'}`}
              title={`${method.method}: ${method.count ?? 'none'} (${Math.round((method.confidence || 0) * 100)}%)`}
            >
              {method.method}: {method.count ?? '–'}
            </span>
          ))}
        </div>
      )}

      {confirmed && (
        <div className="tooth-count-note">
          {markers.length} individual tooth tips marked around 360° from the uploaded image.
        </div>
      )}
      {warnings.length > 0 && (
        <div className="tooth-count-warnings">
          {warnings.slice(0, 2).map((warning, index) => (
            <span key={index}><Icon>info</Icon>{warning}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default ToothCountOverlay;
