import React from 'react';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function DockDropOverlay({
  activeDockZone,
  draggedPanelTitle = 'Panel',
  dragPos,
}) {
  return (
    <div className="workspace-dock-drop-overlay" aria-hidden="true">
      {/* 1. Left Dock Target Zone */}
      <div className={`dock-drop-zone left ${activeDockZone === 'left' ? 'hovered' : ''}`}>
        <div className="dock-zone-content">
          <Icon className="dock-zone-icon">dock_to_left</Icon>
          <span className="dock-zone-title">DOCK TO LEFT COLUMN</span>
          <span className="dock-zone-hint">Release to place on left engineering rail</span>
        </div>
      </div>

      {/* 2. Center Column: Float Target (Top) + Bottom Dock Target */}
      <div className="dock-drop-center-col">
        <div className={`dock-drop-zone center-float ${activeDockZone === 'floating' ? 'hovered' : ''}`}>
          <div className="dock-zone-content">
            <Icon className="dock-zone-icon">open_in_new</Icon>
            <span className="dock-zone-title">FLOAT WINDOW</span>
            <span className="dock-zone-hint">Release in center to detach into freely movable window</span>
          </div>
        </div>

        <div className={`dock-drop-zone bottom ${activeDockZone === 'bottom' ? 'hovered' : ''}`}>
          <div className="dock-zone-content">
            <Icon className="dock-zone-icon">dock_to_bottom</Icon>
            <span className="dock-zone-title">DOCK TO BOTTOM PANEL</span>
            <span className="dock-zone-hint">Release to anchor across the bottom workspace deck</span>
          </div>
        </div>
      </div>

      {/* 3. Right Dock Target Zone */}
      <div className={`dock-drop-zone right ${activeDockZone === 'right' ? 'hovered' : ''}`}>
        <div className="dock-zone-content">
          <Icon className="dock-zone-icon">dock_to_right</Icon>
          <span className="dock-zone-title">DOCK TO RIGHT COLUMN</span>
          <span className="dock-zone-hint">Release to place on right manufacturing rail</span>
        </div>
      </div>

      {/* Mouse Follower Ghost Badge */}
      {dragPos && (
        <div
          className="dock-drag-ghost-badge"
          style={{
            left: `${dragPos.x + 14}px`,
            top: `${dragPos.y + 14}px`,
          }}
        >
          <Icon>drag_indicator</Icon>
          <span>Moving: {draggedPanelTitle}</span>
        </div>
      )}
    </div>
  );
}

export default DockDropOverlay;
