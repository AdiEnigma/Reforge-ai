/**
 * ComponentDropdown.jsx
 * Unified component selector dropdown placed at the top of all engineering sidebar features.
 * Synchronizes selected component across Manufacturing Intel, Gear Health, Decision Report,
 * Engineering Drawing, What-If Simulator, Ordering, and Export tools.
 */

import React, { useMemo } from 'react';
import { getAllComponents, ROLE_TYPES } from '../lib/machinery-context.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">
    {children}
  </span>
);

export function ComponentDropdown({
  machineryState,
  activeComponentId,
  setActiveComponentId,
  title = 'ACTIVE TARGET COMPONENT',
  showSummary = true,
  className = '',
}) {
  const allComponents = useMemo(() => getAllComponents(machineryState), [machineryState]);

  // Active component resolution
  const activeComp = useMemo(() => {
    return allComponents.find((c) => c.id === activeComponentId) || machineryState?.primaryGear || allComponents[0];
  }, [allComponents, activeComponentId, machineryState]);

  const handleChange = (e) => {
    const newId = e.target.value;
    if (newId && setActiveComponentId) {
      setActiveComponentId(newId);
    }
  };

  const getRoleIcon = (role) => {
    if (role === ROLE_TYPES.PRIMARY) return 'stars';
    if (role === ROLE_TYPES.COMPANION) return 'link';
    if (role === ROLE_TYPES.ADDITIONAL_GEAR) return 'settings';
    return 'view_in_ar';
  };

  const getRoleBadgeClass = (role) => {
    if (role === ROLE_TYPES.PRIMARY) return 'role-primary';
    if (role === ROLE_TYPES.COMPANION) return 'role-companion';
    return 'role-additional';
  };

  if (!allComponents || allComponents.length === 0) {
    return null;
  }

  const compAnalysis = activeComp?.analysis;
  const outerDiameter = compAnalysis?.dimensions?.outerDiameter;
  const teeth = compAnalysis?.teeth || compAnalysis?.geometryRecipe?.gear?.teeth;
  const material = compAnalysis?.materialEstimate || 'Mild Steel';

  return (
    <div className={`comp-selector-bar ${className}`} aria-label="Component Selection Toolbar">
      <div className="comp-selector-left">
        <label htmlFor="comp-select-dropdown" className="comp-selector-label">
          <Icon>filter_center_focus</Icon>
          <span>{title}</span>
        </label>
        <div className="comp-dropdown-wrapper">
          <Icon className="comp-dropdown-icon">{getRoleIcon(activeComp?.role)}</Icon>
          <select
            id="comp-select-dropdown"
            className="comp-dropdown-select"
            value={activeComp?.id || ''}
            onChange={handleChange}
            aria-label="Select target component for current engineering tool"
          >
            {allComponents.map((comp) => {
              const imgCount = Array.isArray(comp.images) ? comp.images.length : 0;
              return (
                <option key={comp.id} value={comp.id}>
                  {comp.name} [{comp.role || 'COMPONENT'}] {imgCount > 0 ? `(${imgCount} img${imgCount > 1 ? 's' : ''})` : ''}
                </option>
              );
            })}
          </select>
          <Icon className="comp-dropdown-arrow">expand_more</Icon>
        </div>
      </div>

      {showSummary && activeComp && (
        <div className="comp-selector-meta">
          <span className={`comp-role-badge ${getRoleBadgeClass(activeComp.role)}`}>
            {activeComp.role || 'COMPONENT'}
          </span>
          {outerDiameter && (
            <span className="comp-meta-item">
              <strong className="comp-meta-label">OD:</strong> {outerDiameter} mm
            </span>
          )}
          {teeth && (
            <span className="comp-meta-item">
              <strong className="comp-meta-label">Teeth:</strong> {teeth}T
            </span>
          )}
          <span className="comp-meta-item comp-meta-material" title={material}>
            <strong className="comp-meta-label">Mat:</strong> {material}
          </span>
        </div>
      )}
    </div>
  );
}

export default ComponentDropdown;
