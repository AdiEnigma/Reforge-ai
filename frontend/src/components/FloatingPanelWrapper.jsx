import React, { useRef, useState, useEffect } from 'react';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function FloatingPanelWrapper({
  title,
  icon,
  badge,
  pos = { x: 50, y: 70 },
  onMove,
  size = { width: 440, height: 600 },
  onResize,
  isMaximized = false,
  onToggleMaximize,
  onDock,
  onDockToSlot,
  onClose,
  minWidth = 320,
  minHeight = 220,
  children,
  className = '',
}) {
  const isDraggingRef = useRef(false);
  const isResizingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const containerRef = useRef(null);

  // Drag-to-move from header
  const handleMouseDownHeader = (e) => {
    if (isMaximized) return;
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return;
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: pos.x,
      posY: pos.y,
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'move';

    const onMouseMove = (moveEv) => {
      if (!isDraggingRef.current) return;
      const dx = moveEv.clientX - dragStartRef.current.x;
      const dy = moveEv.clientY - dragStartRef.current.y;
      const nextX = Math.max(10, Math.min(window.innerWidth - 120, dragStartRef.current.posX + dx));
      const nextY = Math.max(48, Math.min(window.innerHeight - 60, dragStartRef.current.posY + dy));
      onMove?.({ x: nextX, y: nextY });
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Drag-to-resize from corner
  const handleMouseDownResizer = (e) => {
    if (isMaximized) return;
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      w: size.width,
      h: size.height,
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'nwse-resize';

    const onMouseMove = (moveEv) => {
      if (!isResizingRef.current) return;
      const dx = moveEv.clientX - resizeStartRef.current.x;
      const dy = moveEv.clientY - resizeStartRef.current.y;
      const nextW = Math.max(minWidth, Math.min(window.innerWidth - pos.x - 20, resizeStartRef.current.w + dx));
      const nextH = Math.max(minHeight, Math.min(window.innerHeight - pos.y - 20, resizeStartRef.current.h + dy));
      onResize?.({ width: nextW, height: nextH });
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const style = isMaximized
    ? {
        position: 'fixed',
        top: '48px',
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: 'calc(100vh - 48px)',
        zIndex: 90,
      }
    : {
        position: 'fixed',
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${size.width}px`,
        height: `${size.height}px`,
        zIndex: 80,
      };

  return (
    <div
      ref={containerRef}
      className={`floating-panel-container ${isMaximized ? 'maximized' : ''} ${className}`}
      style={style}
      role="region"
      aria-label={title}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Draggable Title Bar */}
      <div
        className="floating-panel-header"
        onMouseDown={handleMouseDownHeader}
        title={isMaximized ? undefined : 'Drag to reposition floating panel'}
      >
        <div className="floating-panel-title-group">
          {icon && <Icon className="panel-hdr-icon">{icon}</Icon>}
          <span className="floating-panel-title">{title}</span>
          {badge && <span className="floating-panel-badge">{badge}</span>}
        </div>

        <div className="floating-panel-actions">
          {onDockToSlot && (
            <div className="floating-dock-buttons">
              <button
                type="button"
                className="floating-action-btn"
                onClick={() => onDockToSlot('left')}
                title="Dock to Left column"
                aria-label="Dock to Left"
              >
                <Icon>dock_to_left</Icon>
              </button>
              <button
                type="button"
                className="floating-action-btn"
                onClick={() => onDockToSlot('right')}
                title="Dock to Right column"
                aria-label="Dock to Right"
              >
                <Icon>dock_to_right</Icon>
              </button>
              <button
                type="button"
                className="floating-action-btn"
                onClick={() => onDockToSlot('bottom')}
                title="Dock to Bottom panel"
                aria-label="Dock to Bottom"
              >
                <Icon>dock_to_bottom</Icon>
              </button>
            </div>
          )}

          {onDock && (
            <button
              className="floating-action-btn"
              onClick={onDock}
              title="Dock panel into workspace layout"
              aria-label="Dock panel"
            >
              <Icon>filter_none</Icon>
            </button>
          )}

          {onToggleMaximize && (
            <button
              className="floating-action-btn"
              onClick={onToggleMaximize}
              title={isMaximized ? 'Restore panel size' : 'Maximize panel'}
              aria-label={isMaximized ? 'Restore panel' : 'Maximize panel'}
            >
              <Icon>{isMaximized ? 'fullscreen_exit' : 'fullscreen'}</Icon>
            </button>
          )}

          {onClose && (
            <button
              className="floating-action-btn close-btn"
              onClick={onClose}
              title="Close panel"
              aria-label="Close panel"
            >
              <Icon>close</Icon>
            </button>
          )}
        </div>
      </div>

      {/* Floating Panel Content */}
      <div className="floating-panel-body">
        {children}
      </div>

      {/* Corner Resize Handle */}
      {!isMaximized && (
        <div
          className="floating-panel-resize-handle"
          onMouseDown={handleMouseDownResizer}
          title="Drag corner to resize window"
        >
          <Icon>signal_cellular_0_bar</Icon>
        </div>
      )}
    </div>
  );
}

export default FloatingPanelWrapper;
