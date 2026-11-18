import React, { useRef, useEffect } from 'react';
import InspectedDetailsPanel from './InspectedDetailsPanel.jsx';
import ComponentHealthPanel from './ComponentHealthPanel.jsx';
import ManageComponentsTab from './ManageComponentsTab.jsx';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

function formatINR(n) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

export function LeftContextualPanel({
  isOpen,
  onToggleOpen,
  width,
  onResize,
  // Customization
  isDocked = true,
  onToggleDock,
  isMaximized = false,
  onToggleMaximize,
  isFloatingContent = false,
  currentSlot = 'left',
  onMoveSlot,
  onStartDrag,
  onClose,
  // Active Tab & Tool selection
  activeTab, // 'chat' | 'inspection' | 'health' | 'components'
  onSelectTab,
  selectedContextTool, // 'inspection' | 'health' | 'components' | null
  // Copilot Chat Props
  messages,
  text,
  setText,
  thinking,
  onSendMessage,
  suggestions = [],
  ready,
  label,
  conf,
  activeScope,
  quantity,
  engineeringContext,
  mfgData,
  isDirty,
  isRegenerating,
  onRegenerate,
  // Inspection Props
  analysis,
  features,
  selectedFeatureId,
  hoveredFeatureId,
  onSelectFeature,
  onHoverFeature,
  // Machinery / Components Props
  machineryState,
  setMachineryState,
  activeComponentId,
  setActiveComponentId,
}) {
  const threadRef = useRef(null);
  const isDraggingRef = useRef(false);

  // Auto-scroll chat thread to bottom on message
  useEffect(() => {
    if (activeTab === 'chat' && threadRef.current) {
      threadRef.current.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, thinking, activeTab]);

  // Handle panel resize divider
  const handleMouseDownResizer = (e) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent) => {
      if (!isDraggingRef.current) return;
      const maxW = Math.max(280, window.innerWidth - 380);
      const newWidth = Math.max(280, Math.min(Math.min(700, maxW), moveEvent.clientX));
      onResize?.(newWidth);
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onMouseUp);
  };

  if (!isOpen) {
    return (
      <aside className="left-contextual-panel collapsed-tray">
        <button
          className="panel-open-trigger"
          onClick={() => onToggleOpen(true)}
          title="Expand Left Engineering Panel"
          aria-label="Expand Left Panel"
        >
          <Icon>keyboard_double_arrow_right</Icon>
          <span className="tray-text">COPILOT &amp; CONTEXT</span>
        </button>
      </aside>
    );
  }

  const contextualConfig = {
    inspection: { label: 'Inspected Details', icon: 'center_focus_strong' },
    health: { label: 'Health & Damage', icon: 'health_and_safety' },
    components: { label: 'Components', icon: 'category' },
  }[selectedContextTool];

  return (
    <aside
      className={`left-contextual-panel open ${isMaximized ? 'maximized' : ''} ${isFloatingContent ? 'in-floating' : ''}`}
      style={isFloatingContent || isMaximized ? undefined : { width: `${width}px` }}
      aria-label="Left Contextual Engineering Panel"
    >
      {/* Panel Top Header: Tabs and Panel Customization Actions */}
      <div className="contextual-panel-header">
        <div className="panel-tab-bar" role="tablist">
          {/* Tab 1: Engineering Copilot (Always available) */}
          <button
            role="tab"
            aria-selected={activeTab === 'chat'}
            className={`panel-tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => onSelectTab('chat')}
          >
            <Icon>smart_toy</Icon>
            <span>Copilot</span>
          </button>

          {/* Tab 2: Contextual Tool (Rendered only if selected on ribbon) */}
          {selectedContextTool && contextualConfig && (
            <button
              role="tab"
              aria-selected={activeTab === selectedContextTool}
              className={`panel-tab-btn ${activeTab === selectedContextTool ? 'active' : ''}`}
              onClick={() => onSelectTab(selectedContextTool)}
            >
              <Icon>{contextualConfig.icon}</Icon>
              <span>{contextualConfig.label}</span>
              {selectedContextTool === 'components' && isDirty && (
                <span className="dirty-indicator" title="New visual context staged" />
              )}
            </button>
          )}
        </div>

        {/* Panel Header Actions: Dock/Drag, Maximize/Restore, Close */}
        <div className="panel-header-actions">
          {onStartDrag && (
            <button
              type="button"
              className="panel-action-btn panel-drag-handle"
              onMouseDown={onStartDrag}
              title="Dock button: Drag and drop into any panel area (Left, Center, Right, Bottom)"
              aria-label="Dock and drag Left Panel"
            >
              <Icon>drag_indicator</Icon>
            </button>
          )}

          {onToggleMaximize && (
            <button
              type="button"
              className="panel-action-btn"
              onClick={onToggleMaximize}
              title={isMaximized ? "Restore panel size" : "Maximize panel"}
              aria-label={isMaximized ? "Restore Left Panel" : "Maximize Left Panel"}
            >
              <Icon>{isMaximized ? 'fullscreen_exit' : 'fullscreen'}</Icon>
            </button>
          )}

          <button
            type="button"
            className="panel-action-btn close-btn"
            onClick={onClose || (() => onToggleOpen?.(false))}
            title="Close Left Panel"
            aria-label="Close Left Panel"
          >
            <Icon>close</Icon>
          </button>
        </div>
      </div>

      {/* Panel Body Container: Displays what the active tab is */}
      <div className="contextual-panel-content">
        {/* TAB 1: COPILOT CHAT */}
        {activeTab === 'chat' && (
          <div className="copilot-tab-view fit-screen">
            {/* Header info */}
            <div className="chat-conn-status-bar">
              <div className="chat-conn-left">
                <span className={`chat-status-dot ${ready ? 'active' : ''}`} />
                <span className="chat-status-text">
                  {ready ? `${label}` : 'AWAITING COMPONENT'}
                </span>
              </div>
            </div>

            {/* Regenerate Alert Notice Banner when new visual context is staged */}
            {isDirty && (
              <div className="regenerate-banner">
                <div className="regenerate-banner-text">
                  <Icon>auto_mode</Icon>
                  <span>New visual context staged.</span>
                </div>
                <button
                  className="regenerate-btn"
                  onClick={onRegenerate}
                  disabled={isRegenerating}
                >
                  {isRegenerating ? 'REGENERATING…' : 'REGENERATE'}
                </button>
              </div>
            )}

            {/* Active Part Context Bar (Single-Line Compact) */}
            {ready && engineeringContext && (
              <div className="chat-part-compact-bar">
                <span className="part-name"><strong>{engineeringContext.component.name}</strong></span>
                <span className="part-mat">{engineeringContext.material.label}</span>
                <span className="part-qty">QTY {quantity}</span>
                {mfgData?.cost && (
                  <span className="part-cost">₹{formatINR(mfgData.cost.low)}–₹{formatINR(mfgData.cost.high)}</span>
                )}
              </div>
            )}

            {/* Suggested Question Chips (Compact Single Row) */}
            {ready && suggestions.length > 0 && (
              <div className="chat-suggestions-compact">
                {suggestions.slice(0, 3).map((q, idx) => (
                  <button
                    key={idx}
                    className="chat-chip-btn-compact"
                    disabled={thinking}
                    onClick={() => onSendMessage(null, q)}
                    title={q}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            {/* Thread */}
            <div className="thread flex-thread" ref={threadRef}>
              {!messages.length && (
                <div className="ai-message">
                  <Icon>smart_toy</Icon>
                  <p>I'm your engineering copilot, grounded in geometry, dimensions, material, and manufacturing intelligence. Ask any question.</p>
                </div>
              )}
              {messages.map((m, i) => (
                <div className={`${m.role}-message${m.error ? ' chat-error' : ''}`} key={i}>
                  <p>{m.text}</p>
                </div>
              ))}
              {thinking && (
                <div className="ai-message thinking">
                  <Icon>smart_toy</Icon>
                  <p>Reasoning from component geometry &amp; manufacturing data…</p>
                </div>
              )}
            </div>

            {/* Composer */}
            <form className="composer composer-compact" onSubmit={onSendMessage}>
              <label className="sr-only" htmlFor="left-copilot-input">Ask Engineering Copilot</label>
              <span>&gt;_</span>
              <input
                id="left-copilot-input"
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="Ask about this component or assembly…"
              />
              <button aria-label="Send message" disabled={!text.trim() || thinking}>
                <Icon>send</Icon>
              </button>
            </form>
          </div>
        )}

        {/* TAB 2A: INSPECTED DETAILS & DETECTED FEATURES */}
        {activeTab === 'inspection' && selectedContextTool === 'inspection' && (
          <InspectedDetailsPanel
            analysis={analysis}
            features={features}
            selectedFeatureId={selectedFeatureId}
            hoveredFeatureId={hoveredFeatureId}
            onSelectFeature={onSelectFeature}
            onHoverFeature={onHoverFeature}
          />
        )}

        {/* TAB 2B: HEALTH & DAMAGE ANALYSIS */}
        {activeTab === 'health' && selectedContextTool === 'health' && (
          <ComponentHealthPanel
            analysis={analysis}
            machineryState={machineryState}
            activeComponentId={activeComponentId}
          />
        )}

        {/* TAB 2C: MANAGE COMPONENTS */}
        {activeTab === 'components' && selectedContextTool === 'components' && (
          <div className="manage-components-tab-wrapper">
            <ManageComponentsTab
              machineryState={machineryState}
              setMachineryState={setMachineryState}
              onUpdateMachineryState={setMachineryState}
              onRegenerate={onRegenerate}
              isRegenerating={isRegenerating}
              isDirty={isDirty}
              activeComponentId={activeComponentId}
              onSelectComponent={setActiveComponentId}
            />
          </div>
        )}
      </div>

      {/* Draggable Resize Slider on Right Edge */}
      {!isMaximized && !isFloatingContent && (
        <div
          className="panel-resizer-handle horizontal"
          onMouseDown={handleMouseDownResizer}
          title="Drag to resize Engineering Copilot panel"
          aria-label="Resize Engineering Copilot Panel"
        />
      )}
    </aside>
  );
}
export default LeftContextualPanel;
