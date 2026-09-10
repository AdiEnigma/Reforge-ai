/**
 * ManageComponentsTab.jsx
 * Central Image & Context Manager for the Engineering Copilot.
 *
 * Clean & Streamlined Component Management:
 * 1. Default component naming: Gear 1, Gear 2, Gear 3, ... (user can rename).
 * 2. Exactly ONE role/status dropdown per gear:
 *    - Primary Gear (Max 1)
 *    - Companion Gear (Max 1)
 *    - Secondary Gear Train (Unlimited)
 *    - Unassigned (Unlimited)
 * 3. Role conflict modal with clear choices (Change Role / Cancel).
 * 4. Demoted gears are preserved in Unassigned without deleting images/data.
 * 5. Simplified photo cards: clean image thumbnail, replace/delete overlay, reorder & note actions.
 */

import React, { useState, useRef } from 'react';
import {
  ROLE_TYPES,
  getAllComponents,
  addGearFromImages,
  addCompanionFromImages,
  addImagesToComponent,
  removeImageFromComponent,
  replaceComponentImage,
  reorderComponentImages,
  updateImageMetadata,
  renameGearComponent,
  updateComponentNotes,
  assignComponentRole,
  removeComponent,
  checkRoleConflict,
} from '../lib/machinery-context.js';

const Icon = ({ children, className = '' }) => (
  <span className={`icon material-symbols-outlined ${className}`} aria-hidden="true">{children}</span>
);

export function ManageComponentsTab({
  machineryState,
  setMachineryState: propSetMachineryState,
  onUpdateMachineryState,
  isDirty,
  onRegenerate,
  isRegenerating,
  activeComponentId,
  onSelectComponent,
}) {
  const setMachineryState = propSetMachineryState || onUpdateMachineryState || (() => {});
  const [replaceModal, setReplaceModal] = useState(null); // { targetId, newRole, conflict }
  const [renameModal, setRenameModal] = useState(null); // { targetId, currentName }
  const [expandedImageId, setExpandedImageId] = useState(null); // imageId for note editing
  const [dragOverSector, setDragOverSector] = useState(null);

  // Global File Input Reference
  const fileInputRef = useRef(null);
  const uploadModeRef = useRef(null); // { type: 'add_images' | 'replace_image' | 'add_companion' | 'add_gear', targetId, imageId }

  const primary = machineryState?.primaryGear;
  const companion = machineryState?.companionGear;
  const additional = machineryState?.additionalComponents || [];

  const secondaryGears = additional.filter(
    (c) => c.role === ROLE_TYPES.SECONDARY || c.role === ROLE_TYPES.ADDITIONAL_GEAR
  );

  const unassignedGears = additional.filter(
    (c) => c.role === ROLE_TYPES.UNASSIGNED || (!c.role && c.id !== primary?.id && c.id !== companion?.id)
  );

  const assemblyCtx = machineryState?.assemblyContext;
  const envCtx = machineryState?.environmentContext;

  // Trigger File Dialogs for each sector
  const triggerAddImages = (targetId) => {
    uploadModeRef.current = { type: 'add_images', targetId };
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const triggerReplaceImage = (targetId, imageId) => {
    uploadModeRef.current = { type: 'replace_image', targetId, imageId };
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const triggerAddCompanionGear = () => {
    uploadModeRef.current = { type: 'add_companion' };
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const triggerAddNewGear = () => {
    uploadModeRef.current = { type: 'add_gear' };
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  // Handle file selection from standard input
  const handleFilesSelected = (e) => {
    const files = e.target.files;
    if (!files || !files.length || !uploadModeRef.current) return;
    const mode = uploadModeRef.current;

    setMachineryState((prevState) => {
      if (mode.type === 'add_images') {
        return addImagesToComponent(prevState, mode.targetId, files);
      } else if (mode.type === 'replace_image') {
        return replaceComponentImage(prevState, mode.targetId, mode.imageId, files[0]);
      } else if (mode.type === 'add_companion') {
        return addCompanionFromImages(prevState, files);
      } else if (mode.type === 'add_gear') {
        return addGearFromImages(prevState, files);
      }
      return prevState;
    });

    e.target.value = '';
  };

  // Handle Drag and Drop on any card/sector
  const handleDragOver = (e, sectorKey) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragOverSector !== sectorKey) setDragOverSector(sectorKey);
  };

  const handleDragLeave = (e, sectorKey) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragOverSector === sectorKey) setDragOverSector(null);
  };

  const handleDropFiles = (e, targetId, modeType = 'add_images') => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverSector(null);
    const files = e.dataTransfer.files;
    if (!files || !files.length) return;

    setMachineryState((prevState) => {
      if (modeType === 'add_images') {
        return addImagesToComponent(prevState, targetId, files);
      } else if (modeType === 'add_companion') {
        return addCompanionFromImages(prevState, files);
      } else if (modeType === 'add_gear') {
        return addGearFromImages(prevState, files);
      }
      return prevState;
    });
  };

  const handleRemoveImage = (componentId, imageId) => {
    setMachineryState((prevState) => removeImageFromComponent(prevState, componentId, imageId));
  };

  const handleReorder = (componentId, fromIdx, toIdx) => {
    setMachineryState((prevState) => reorderComponentImages(prevState, componentId, fromIdx, toIdx));
  };

  const handleMetadataChange = (componentId, imageId, key, val) => {
    setMachineryState((prevState) =>
      updateImageMetadata(prevState, componentId, imageId, { [key]: val })
    );
  };

  const handleRoleChange = (componentId, newRole) => {
    const conflict = checkRoleConflict(machineryState, componentId, newRole);
    if (conflict.hasConflict) {
      setReplaceModal({ targetId: componentId, newRole, conflict });
      return;
    }
    try {
      setMachineryState((prevState) => assignComponentRole(prevState, componentId, newRole, false));
      onSelectComponent?.(componentId);
    } catch (err) {
      console.error(err);
    }
  };

  const handleConfirmReplace = () => {
    if (!replaceModal) return;
    const { targetId, newRole } = replaceModal;
    setMachineryState((prevState) => assignComponentRole(prevState, targetId, newRole, true));
    onSelectComponent?.(targetId);
    setReplaceModal(null);
  };

  const handleDeleteGear = (id) => {
    setMachineryState((prevState) => removeComponent(prevState, id));
  };

  const handleSaveRename = (e) => {
    e.preventDefault();
    if (!renameModal || !renameModal.name.trim()) return;
    setMachineryState((prevState) =>
      renameGearComponent(prevState, renameModal.targetId, renameModal.name)
    );
    setRenameModal(null);
  };

  const renderGearCardContent = (gear, sectorKey) => {
    if (!gear) return null;
    const isSelected = activeComponentId === gear.id;

    return (
      <div
        className={`comp-mgr-card gear-card-block ${isSelected ? 'active-selected' : ''} ${dragOverSector === sectorKey ? 'drag-over' : ''}`}
        onClick={() => onSelectComponent?.(gear.id)}
        onDragOver={(e) => handleDragOver(e, sectorKey)}
        onDragLeave={(e) => handleDragLeave(e, sectorKey)}
        onDrop={(e) => handleDropFiles(e, gear.id, 'add_images')}
      >
        <div className="comp-card-header">
          <div className="comp-card-title">
            <span className={`role-tag ${gear.role === ROLE_TYPES.PRIMARY ? 'primary' : gear.role === ROLE_TYPES.COMPANION ? 'companion' : 'other'}`}>
              {gear.role || 'UNASSIGNED'}
            </span>
            <div className="gear-name-row">
              <h3>{gear.name}</h3>
              <button
                className="gear-rename-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameModal({ targetId: gear.id, name: gear.name });
                }}
                title="Rename Component"
              >
                <Icon>edit</Icon>
              </button>
            </div>
          </div>

          <div className="gear-header-controls" onClick={(e) => e.stopPropagation()}>
            {/* Single Role Dropdown */}
            <select
              className="comp-single-role-dropdown"
              value={
                gear.role === ROLE_TYPES.UNASSIGNED || !gear.role
                  ? ROLE_TYPES.SECONDARY
                  : gear.role
              }
              onChange={(e) => handleRoleChange(gear.id, e.target.value)}
              title="Assign Component Role"
              aria-label={`Role selector for ${gear.name}`}
            >
              <option value={ROLE_TYPES.PRIMARY}>Primary Gear</option>
              <option value={ROLE_TYPES.COMPANION}>Companion Gear</option>
              <option value={ROLE_TYPES.SECONDARY}>Secondary Gear Train</option>
            </select>

            <button
              className="comp-delete-btn"
              onClick={() => handleDeleteGear(gear.id)}
              title={`Remove ${gear.name}`}
            >
              <Icon>delete</Icon>
            </button>
          </div>
        </div>

        {/* Clean Thumbnail Gallery */}
        <div className="comp-image-grid" onClick={(e) => e.stopPropagation()}>
          {gear.images?.map((img, idx) => (
            <ImageItemCard
              key={img.id}
              image={img}
              index={idx}
              total={gear.images.length}
              onDelete={() => handleRemoveImage(gear.id, img.id)}
              onReplace={() => triggerReplaceImage(gear.id, img.id)}
              onMoveLeft={() => handleReorder(gear.id, idx, idx - 1)}
              onMoveRight={() => handleReorder(gear.id, idx, idx + 1)}
              onUpdateMetadata={(key, val) => handleMetadataChange(gear.id, img.id, key, val)}
              isExpanded={expandedImageId === img.id}
              onToggleExpand={() => setExpandedImageId(expandedImageId === img.id ? null : img.id)}
            />
          ))}

          <button
            className="comp-thumb-add-box"
            onClick={() => triggerAddImages(gear.id)}
            title={`Upload photos for ${gear.name}`}
          >
            <Icon>add_photo_alternate</Icon>
            <span>+ Add Images</span>
          </button>
        </div>

        <div className="comp-notes-row" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            className="comp-note-input"
            placeholder={`Optional notes for ${gear.name}...`}
            value={gear.notes || ''}
            onChange={(e) => {
              setMachineryState((prevState) => updateComponentNotes(prevState, gear.id, e.target.value));
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="manage-components-container" aria-label="Central Images and Context Manager">
      {/* Hidden File Input for All Image Upload Operations */}
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFilesSelected}
      />

      {/* Regeneration Notice Banner */}
      {isDirty && (
        <div className="regen-notice-banner" role="status">
          <div className="regen-notice-text">
            <Icon className="regen-icon-pulse">info</Icon>
            <div>
              <strong>New visual information added.</strong>
              <span>Your current reconstruction is preserved. Click Regenerate to incorporate new images.</span>
            </div>
          </div>
          <button
            className="regen-btn-prominent"
            onClick={onRegenerate}
            disabled={isRegenerating}
            title="Reconstruct 3D Model with updated context"
          >
            <Icon>{isRegenerating ? 'sync' : 'auto_awesome'}</Icon>
            {isRegenerating ? 'REGENERATING…' : 'REGENERATE'}
          </button>
        </div>
      )}

      <div className="comp-mgr-scroll-body">
        {/* 1. PRIMARY GEAR SECTION */}
        <div className="comp-section-block">
          <h4 className="comp-section-title">
            <Icon>stars</Icon> PRIMARY GEAR (MAX 1)
          </h4>
          {primary ? (
            renderGearCardContent(primary, 'primary')
          ) : (
            <div className="empty-companion-prompt">
              <p>No Primary Gear assigned. Select a gear below to assign as Primary Gear.</p>
            </div>
          )}
        </div>

        {/* 2. COMPANION GEAR SECTION */}
        <div className="comp-section-block">
          <h4 className="comp-section-title">
            <Icon>link</Icon> COMPANION GEAR (MAX 1)
          </h4>
          {companion ? (
            renderGearCardContent(companion, 'companion')
          ) : (
            <div className="empty-companion-prompt">
              <p>Mating gear directly interacting with Primary Gear. Unlocks center distance calibration and pair kinematics.</p>
              <button
                className="comp-btn-upload-action"
                onClick={triggerAddCompanionGear}
              >
                <Icon>add_photo_alternate</Icon> + Add Companion Gear → Upload Images
              </button>
            </div>
          )}
        </div>

        {/* 3. SECONDARY GEAR TRAIN SECTION */}
        <div className="comp-section-block">
          <h4 className="comp-section-title">
            <Icon>settings</Icon> SECONDARY GEAR TRAIN ({secondaryGears.length})
          </h4>
          {secondaryGears.length > 0 ? (
            secondaryGears.map((gear) => (
              <React.Fragment key={gear.id}>
                {renderGearCardContent(gear, gear.id)}
              </React.Fragment>
            ))
          ) : (
            <p className="comp-empty-hint">No secondary gear train components currently assigned.</p>
          )}

          <button
            className="comp-btn-add-gear-upload"
            onClick={triggerAddNewGear}
          >
            <Icon>add_photo_alternate</Icon> + Add Gear → Upload Images
          </button>
        </div>

        {/* 4. UNASSIGNED COMPONENTS SECTION */}
        {unassignedGears.length > 0 && (
          <div className="comp-section-block">
            <h4 className="comp-section-title">
              <Icon>category</Icon> UNASSIGNED COMPONENTS ({unassignedGears.length})
            </h4>
            {unassignedGears.map((gear) => (
              <React.Fragment key={gear.id}>
                {renderGearCardContent(gear, gear.id)}
              </React.Fragment>
            ))}
          </div>
        )}

        {/* 5. ASSEMBLY CONTEXT */}
        <section
          className={`comp-mgr-card assembly-card ${dragOverSector === 'assembly' ? 'drag-over' : ''}`}
          onDragOver={(e) => handleDragOver(e, 'assembly')}
          onDragLeave={(e) => handleDragLeave(e, 'assembly')}
          onDrop={(e) => handleDropFiles(e, assemblyCtx?.id || 'comp-assembly-context', 'add_images')}
        >
          <div className="comp-card-header">
            <div className="comp-card-title">
              <span className="role-tag context">ASSEMBLY CONTEXT</span>
              <h3>Assembly Alignment &amp; Fit ({assemblyCtx?.images?.length || 0})</h3>
            </div>
          </div>
          <p className="comp-card-desc">Shaft arrangements, gear center alignments, backlash indicators, and gear engagement.</p>

          <div className="comp-image-grid">
            {assemblyCtx?.images?.map((img, idx) => (
              <ImageItemCard
                key={img.id}
                image={img}
                index={idx}
                total={assemblyCtx.images.length}
                onDelete={() => handleRemoveImage(assemblyCtx?.id || 'comp-assembly-context', img.id)}
                onReplace={() => triggerReplaceImage(assemblyCtx?.id || 'comp-assembly-context', img.id)}
                onMoveLeft={() => handleReorder(assemblyCtx?.id || 'comp-assembly-context', idx, idx - 1)}
                onMoveRight={() => handleReorder(assemblyCtx?.id || 'comp-assembly-context', idx, idx + 1)}
                onUpdateMetadata={(key, val) => handleMetadataChange(assemblyCtx?.id || 'comp-assembly-context', img.id, key, val)}
                isExpanded={expandedImageId === img.id}
                onToggleExpand={() => setExpandedImageId(expandedImageId === img.id ? null : img.id)}
              />
            ))}

            <button
              className="comp-thumb-add-box"
              onClick={() => triggerAddImages(assemblyCtx?.id || 'comp-assembly-context')}
              title="Add Assembly Context images"
            >
              <Icon>add_photo_alternate</Icon>
              <span>+ Add Images</span>
            </button>
          </div>

          <div className="comp-notes-row">
            <input
              type="text"
              className="comp-note-input"
              placeholder="Assembly notes (e.g. Parallel shaft alignment, dual bearing support)..."
              value={assemblyCtx?.notes || ''}
              onChange={(e) => {
                const targetId = assemblyCtx?.id || 'comp-assembly-context';
                setMachineryState((prevState) => updateComponentNotes(prevState, targetId, e.target.value));
              }}
            />
          </div>
        </section>

        {/* 6. ENVIRONMENT CONTEXT */}
        <section
          className={`comp-mgr-card environment-card ${dragOverSector === 'env' ? 'drag-over' : ''}`}
          onDragOver={(e) => handleDragOver(e, 'env')}
          onDragLeave={(e) => handleDragLeave(e, 'env')}
          onDrop={(e) => handleDropFiles(e, envCtx?.id || 'comp-environment-context', 'add_images')}
        >
          <div className="comp-card-header">
            <div className="comp-card-title">
              <span className="role-tag context">ENVIRONMENT CONTEXT</span>
              <h3>Machinery Housing &amp; Environment ({envCtx?.images?.length || 0})</h3>
            </div>
          </div>
          <p className="comp-card-desc">Machine frame, gearbox housing, motor plate, lubrication system, and environmental exposure.</p>

          <div className="comp-image-grid">
            {envCtx?.images?.map((img, idx) => (
              <ImageItemCard
                key={img.id}
                image={img}
                index={idx}
                total={envCtx.images.length}
                onDelete={() => handleRemoveImage(envCtx?.id || 'comp-environment-context', img.id)}
                onReplace={() => triggerReplaceImage(envCtx?.id || 'comp-environment-context', img.id)}
                onMoveLeft={() => handleReorder(envCtx?.id || 'comp-environment-context', idx, idx - 1)}
                onMoveRight={() => handleReorder(envCtx?.id || 'comp-environment-context', idx, idx + 1)}
                onUpdateMetadata={(key, val) => handleMetadataChange(envCtx?.id || 'comp-environment-context', img.id, key, val)}
                isExpanded={expandedImageId === img.id}
                onToggleExpand={() => setExpandedImageId(expandedImageId === img.id ? null : img.id)}
              />
            ))}

            <button
              className="comp-thumb-add-box"
              onClick={() => triggerAddImages(envCtx?.id || 'comp-environment-context')}
              title="Add Environment Context images"
            >
              <Icon>add_photo_alternate</Icon>
              <span>+ Add Images</span>
            </button>
          </div>

          <div className="comp-notes-row">
            <input
              type="text"
              className="comp-note-input"
              placeholder="Environment notes (e.g. Cast iron enclosure, ISO VG 220 oil bath, high dust exposure)..."
              value={envCtx?.notes || ''}
              onChange={(e) => {
                const targetId = envCtx?.id || 'comp-environment-context';
                setMachineryState((prevState) => updateComponentNotes(prevState, targetId, e.target.value));
              }}
            />
          </div>
        </section>
      </div>

      {/* MODAL 1: Role Swap Confirmation */}
      {replaceModal && (
        <div className="modal-backdrop-custom" role="dialog" aria-modal="true">
          <div className="modal-content-custom">
            <div className="modal-header-custom">
              <Icon className="warn-icon">swap_horiz</Icon>
              <h4>Swap Roles?</h4>
            </div>
            <p className="modal-desc-custom" style={{ fontSize: '13px', color: 'var(--text)', lineHeight: '1.5' }}>
              {replaceModal.conflict?.message ||
                `A ${replaceModal.newRole === ROLE_TYPES.PRIMARY ? 'Primary' : 'Companion'} Gear is already assigned. The two gears will swap roles.`}
            </p>
            {replaceModal.conflict?.currentHolder && (
              <div className="swap-summary">
                <div className="swap-row">
                  <span className="swap-gear-name">{replaceModal.conflict.targetName}</span>
                  <Icon>arrow_forward</Icon>
                  <span className={`role-tag ${replaceModal.newRole === ROLE_TYPES.PRIMARY ? 'primary' : replaceModal.newRole === ROLE_TYPES.COMPANION ? 'companion' : 'other'}`}>
                    {replaceModal.newRole === ROLE_TYPES.PRIMARY ? 'PRIMARY' : replaceModal.newRole === ROLE_TYPES.COMPANION ? 'COMPANION' : 'SECONDARY'}
                  </span>
                </div>
                <div className="swap-row">
                  <span className="swap-gear-name">{replaceModal.conflict.existingName}</span>
                  <Icon>arrow_forward</Icon>
                  <span className="role-tag other">
                    {replaceModal.conflict.currentHolder.role === ROLE_TYPES.PRIMARY ? 'PRIMARY'
                      : replaceModal.conflict.currentHolder.role === ROLE_TYPES.COMPANION ? 'COMPANION'
                      : 'SECONDARY'}
                  </span>
                </div>
              </div>
            )}
            <p className="replace-note">
              No data, images, or analysis will be lost. Only the role assignment changes.
            </p>
            <div className="modal-actions-custom">
              <button className="btn-cancel-custom" onClick={() => setReplaceModal(null)}>
                Cancel
              </button>
              <button className="btn-replace-custom" onClick={handleConfirmReplace}>
                Swap Roles
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Rename Gear Modal */}
      {renameModal && (
        <div className="modal-backdrop-custom" role="dialog" aria-modal="true">
          <form className="modal-content-custom" onSubmit={handleSaveRename}>
            <div className="modal-header-custom">
              <Icon>edit</Icon>
              <h4>Rename Component</h4>
            </div>
            <div className="modal-form-fields">
              <label>
                <span>Component Name</span>
                <input
                  type="text"
                  required
                  placeholder="e.g. Gear 1, Gear 2, Input Pinion"
                  value={renameModal.name}
                  onChange={(e) => setRenameModal({ ...renameModal, name: e.target.value })}
                  autoFocus
                />
              </label>
            </div>
            <div className="modal-actions-custom">
              <button type="button" className="btn-cancel-custom" onClick={() => setRenameModal(null)}>
                Cancel
              </button>
              <button type="submit" className="btn-replace-custom" disabled={!renameModal.name.trim()}>
                Save Name
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/**
 * Clean & Streamlined Image Card
 * Displays thumbnail, replace/delete overlay actions, reorder controls, and note toggle.
 */
function ImageItemCard({
  image,
  index,
  total,
  onDelete,
  onReplace,
  onMoveLeft,
  onMoveRight,
  onUpdateMetadata,
  isExpanded,
  onToggleExpand,
}) {
  return (
    <div className={`comp-img-card ${isExpanded ? 'expanded' : ''}`}>
      <div className="comp-img-thumb-wrap">
        {image.url ? (
          <img src={image.url} alt={image.name || `Photo #${index + 1}`} className="comp-img-thumb" />
        ) : (
          <div className="no-preview">
            <Icon>image</Icon>
          </div>
        )}

        {/* Top Overlay Actions: Replace & Delete */}
        <div className="comp-img-top-actions">
          <button
            className="img-icon-btn replace"
            title="Replace photo with new file"
            onClick={onReplace}
          >
            <Icon>swap_horiz</Icon>
          </button>
          <button
            className="img-icon-btn delete"
            title="Delete photo"
            onClick={onDelete}
          >
            <Icon>close</Icon>
          </button>
        </div>

        {/* Bottom Overlay Actions: Reorder Arrows, Index Label, Note Toggle */}
        <div className="comp-img-bottom-actions">
          <div className="img-nav-group">
            <button
              className="img-icon-btn nav"
              title="Move photo left"
              disabled={index <= 0}
              onClick={onMoveLeft}
            >
              <Icon>chevron_left</Icon>
            </button>
            <span className="img-idx-label">#{index + 1}</span>
            <button
              className="img-icon-btn nav"
              title="Move photo right"
              disabled={index >= total - 1}
              onClick={onMoveRight}
            >
              <Icon>chevron_right</Icon>
            </button>
          </div>

          <button
            className={`img-icon-btn note ${image.note ? 'has-note' : ''}`}
            onClick={onToggleExpand}
            title={image.note ? `Note: ${image.note}` : 'Add note to photo'}
          >
            <Icon>sticky_note_2</Icon>
          </button>
        </div>
      </div>

      {/* Expandable Image Note Drawer */}
      {isExpanded && (
        <div className="img-note-drawer">
          <input
            type="text"
            className="img-note-field"
            placeholder="Photo note (e.g. root undercut)..."
            value={image.note || ''}
            onChange={(e) => onUpdateMetadata?.('note', e.target.value)}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}

export default ManageComponentsTab;

