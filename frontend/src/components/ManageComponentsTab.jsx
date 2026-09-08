/**
 * ManageComponentsTab.jsx
 * Central Image & Context Manager for the Engineering Copilot.
 *
 * Rules:
 * 1. Companion Gear & Additional Gears created ONLY through image upload (no manual CAD or text-only creation).
 * 2. Auto-generated identifiers (Gear 3, Gear 4, Gear 5, ...) with inline renaming.
 * 3. Categorized into: Primary Gear, Companion Gear, Additional Gears, Assembly Context, Environment Context.
 * 4. Rich per-image tools: Thumbnail preview, Reorder, Replace, Delete, Image Purpose tag, Priority, and Custom Note.
 * 5. Full Drag & Drop upload support on EVERY sector card.
 * 6. Role replacement guard modal for Companion Gear conflicts.
 * 7. Continuous Regeneration Notice Banner with non-destructive state preservation.
 */

import React, { useState, useRef } from 'react';
import {
  ROLE_TYPES,
  IMAGE_PURPOSES,
  IMAGE_PRIORITIES,
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
  const [actionMenuOpenId, setActionMenuOpenId] = useState(null);
  const [dragOverSector, setDragOverSector] = useState(null); // 'primary' | 'companion' | 'gear-id' | 'assembly' | 'env'

  // Global File Input Reference
  const fileInputRef = useRef(null);
  const uploadModeRef = useRef(null); // { type: 'add_images' | 'replace_image' | 'add_companion' | 'add_gear', targetId, imageId }

  const primary = machineryState?.primaryGear;
  const companion = machineryState?.companionGear;
  const additional = machineryState?.additionalComponents || [];
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
        return addCompanionFromImages(prevState, files, 'Companion Gear');
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
        return addCompanionFromImages(prevState, files, 'Companion Gear');
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
      setActionMenuOpenId(null);
      return;
    }
    try {
      setMachineryState((prevState) => assignComponentRole(prevState, componentId, newRole, false));
    } catch (err) {
      console.error(err);
    }
    setActionMenuOpenId(null);
  };

  const handleConfirmReplace = () => {
    if (!replaceModal) return;
    const { targetId, newRole } = replaceModal;
    setMachineryState((prevState) => assignComponentRole(prevState, targetId, newRole, true));
    setReplaceModal(null);
  };

  const handleDeleteGear = (id) => {
    setMachineryState((prevState) => removeComponent(prevState, id));
    setActionMenuOpenId(null);
  };

  const handleSaveRename = (e) => {
    e.preventDefault();
    if (!renameModal || !renameModal.name.trim()) return;
    setMachineryState((prevState) =>
      renameGearComponent(prevState, renameModal.targetId, renameModal.name)
    );
    setRenameModal(null);
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
              <span>Your current reconstruction has been preserved. Regenerate to incorporate the newly added images.</span>
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
        {/* ========================================================================= */}
        {/* 1. PRIMARY GEAR                                                           */}
        {/* ========================================================================= */}
        <section
          className={`comp-mgr-card primary-card ${dragOverSector === 'primary' ? 'drag-over' : ''}`}
          onDragOver={(e) => handleDragOver(e, 'primary')}
          onDragLeave={(e) => handleDragLeave(e, 'primary')}
          onDrop={(e) => handleDropFiles(e, primary?.id || 'comp-primary-gear', 'add_images')}
        >
          <div className="comp-card-header">
            <div className="comp-card-title">
              <span className="role-tag primary">PRIMARY GEAR</span>
              <div className="gear-name-row">
                <h3>{primary?.name || 'Primary Gear'}</h3>
                <button
                  className="gear-rename-btn"
                  onClick={() => setRenameModal({ targetId: primary?.id || 'comp-primary-gear', name: primary?.name || 'Primary Gear' })}
                  title="Rename Primary Gear"
                >
                  <Icon>edit</Icon>
                </button>
              </div>
            </div>
            <span className="comp-count-pill">
              {primary?.images?.length || 0} image{primary?.images?.length === 1 ? '' : 's'}
            </span>
          </div>
          <p className="comp-card-desc">Main component being reverse-engineered, dimensioned, and evaluated.</p>

          {/* Thumbnail Gallery with Full Image Controls */}
          <div className="comp-image-grid">
            {primary?.images?.map((img, idx) => (
              <ImageItemCard
                key={img.id}
                image={img}
                index={idx}
                total={primary.images.length}
                onDelete={() => handleRemoveImage(primary?.id || 'comp-primary-gear', img.id)}
                onReplace={() => triggerReplaceImage(primary?.id || 'comp-primary-gear', img.id)}
                onMoveLeft={() => handleReorder(primary?.id || 'comp-primary-gear', idx, idx - 1)}
                onMoveRight={() => handleReorder(primary?.id || 'comp-primary-gear', idx, idx + 1)}
                onUpdateMetadata={(key, val) => handleMetadataChange(primary?.id || 'comp-primary-gear', img.id, key, val)}
                isExpanded={expandedImageId === img.id}
                onToggleExpand={() => setExpandedImageId(expandedImageId === img.id ? null : img.id)}
              />
            ))}

            <button
              className="comp-thumb-add-box"
              onClick={() => triggerAddImages(primary?.id || 'comp-primary-gear')}
              title="Upload more photos for Primary Gear"
            >
              <Icon>add_photo_alternate</Icon>
              <span>+ Add Images</span>
            </button>
          </div>

          <div className="comp-notes-row">
            <input
              type="text"
              className="comp-note-input"
              placeholder="Optional notes for Primary Gear (e.g. 24 teeth, 15mm bore, mild wear on flank)..."
              value={primary?.notes || ''}
              onChange={(e) => {
                const targetId = primary?.id || 'comp-primary-gear';
                setMachineryState((prevState) => updateComponentNotes(prevState, targetId, e.target.value));
              }}
            />
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 2. COMPANION GEAR                                                         */}
        {/* ========================================================================= */}
        <section
          className={`comp-mgr-card companion-card ${dragOverSector === 'companion' ? 'drag-over' : ''}`}
          onDragOver={(e) => handleDragOver(e, 'companion')}
          onDragLeave={(e) => handleDragLeave(e, 'companion')}
          onDrop={(e) => handleDropFiles(e, companion?.id || 'comp-companion-gear', companion ? 'add_images' : 'add_companion')}
        >
          <div className="comp-card-header">
            <div className="comp-card-title">
              <span className="role-tag companion">COMPANION GEAR</span>
              {companion ? (
                <div className="gear-name-row">
                  <h3>{companion.name}</h3>
                  <button
                    className="gear-rename-btn"
                    onClick={() => setRenameModal({ targetId: companion.id, name: companion.name })}
                    title="Rename Companion Gear"
                  >
                    <Icon>edit</Icon>
                  </button>
                </div>
              ) : (
                <h3>No Companion Gear</h3>
              )}
            </div>
            {companion && (
              <span className="comp-count-pill">
                {companion.images?.length || 0} image{companion.images?.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {companion ? (
            <>
              <p className="comp-card-desc">Direct mating gear interacting with Primary Gear in the gear train.</p>

              <div className="comp-image-grid">
                {companion.images?.map((img, idx) => (
                  <ImageItemCard
                    key={img.id}
                    image={img}
                    index={idx}
                    total={companion.images.length}
                    onDelete={() => handleRemoveImage(companion.id, img.id)}
                    onReplace={() => triggerReplaceImage(companion.id, img.id)}
                    onMoveLeft={() => handleReorder(companion.id, idx, idx - 1)}
                    onMoveRight={() => handleReorder(companion.id, idx, idx + 1)}
                    onUpdateMetadata={(key, val) => handleMetadataChange(companion.id, img.id, key, val)}
                    isExpanded={expandedImageId === img.id}
                    onToggleExpand={() => setExpandedImageId(expandedImageId === img.id ? null : img.id)}
                  />
                ))}

                <button
                  className="comp-thumb-add-box"
                  onClick={() => triggerAddImages(companion.id)}
                  title="Upload more photos for Companion Gear"
                >
                  <Icon>add_photo_alternate</Icon>
                  <span>+ Add Images</span>
                </button>
              </div>

              <div className="comp-notes-row">
                <input
                  type="text"
                  className="comp-note-input"
                  placeholder="Optional notes for Companion Gear (e.g. driven gear, center distance ~75mm)..."
                  value={companion.notes || ''}
                  onChange={(e) => {
                    setMachineryState((prevState) => updateComponentNotes(prevState, companion.id, e.target.value));
                  }}
                />
              </div>

              <div className="comp-card-actions">
                <button
                  className="comp-action-link"
                  onClick={() => handleRoleChange(companion.id, ROLE_TYPES.ADDITIONAL_GEAR)}
                >
                  <Icon>swap_horiz</Icon> Demote to Additional Gear
                </button>
                <button
                  className="comp-action-link danger"
                  onClick={() => handleDeleteGear(companion.id)}
                >
                  <Icon>delete</Icon> Remove Companion Gear
                </button>
              </div>
            </>
          ) : (
            <div className="empty-companion-prompt">
              <p>Mating gear directly interacting with the Primary Gear. Unlocks center distance calibration and pair kinematics.</p>
              <button
                className="comp-btn-upload-action"
                onClick={triggerAddCompanionGear}
              >
                <Icon>add_photo_alternate</Icon> + Add Companion Gear → Upload Images
              </button>
            </div>
          )}
        </section>

        {/* ========================================================================= */}
        {/* 3. ADDITIONAL GEARS (Unlimited: Gear 3, Gear 4, ...)                      */}
        {/* ========================================================================= */}
        <section className="comp-mgr-card additional-gears-card">
          <div className="comp-card-header">
            <div className="comp-card-title">
              <span className="role-tag other">ADDITIONAL GEARS</span>
              <h3>Secondary Gear Train ({additional.length})</h3>
            </div>
            <span className="comp-count-pill">
              {additional.length} Gear{additional.length === 1 ? '' : 's'}
            </span>
          </div>
          <p className="comp-card-desc">Idlers, intermediate reduction gears, and multi-stage transmission gears.</p>

          <div className="additional-gears-list">
            {additional.map((gear) => (
              <div
                key={gear.id}
                className={`additional-gear-block ${dragOverSector === gear.id ? 'drag-over' : ''}`}
                onDragOver={(e) => handleDragOver(e, gear.id)}
                onDragLeave={(e) => handleDragLeave(e, gear.id)}
                onDrop={(e) => handleDropFiles(e, gear.id, 'add_images')}
              >
                <div className="gear-item-topbar">
                  <div className="gear-item-title-group">
                    <span className="gear-badge">{gear.role === ROLE_TYPES.ADDITIONAL_GEAR ? 'GEAR' : 'COMP'}</span>
                    <strong>{gear.name}</strong>
                    <button
                      className="gear-rename-btn"
                      onClick={() => setRenameModal({ targetId: gear.id, name: gear.name })}
                      title="Rename Gear"
                    >
                      <Icon>edit</Icon>
                    </button>
                  </div>

                  <div className="comp-menu-wrap">
                    <button
                      className="comp-menu-trigger"
                      onClick={() => setActionMenuOpenId(actionMenuOpenId === gear.id ? null : gear.id)}
                      title="Gear Actions"
                    >
                      <Icon>more_vert</Icon>
                    </button>
                    {actionMenuOpenId === gear.id && (
                      <div className="comp-action-dropdown">
                        <button onClick={() => handleRoleChange(gear.id, ROLE_TYPES.COMPANION)}>
                          <Icon>swap_horiz</Icon> Set as Companion Gear
                        </button>
                        <button onClick={() => handleRoleChange(gear.id, ROLE_TYPES.PRIMARY)}>
                          <Icon>star</Icon> Set as Primary Gear
                        </button>
                        <button className="danger" onClick={() => handleDeleteGear(gear.id)}>
                          <Icon>delete</Icon> Delete {gear.name}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Images for this additional gear */}
                <div className="comp-image-grid">
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

                <div className="comp-notes-row">
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
            ))}

            {/* Main Add Gear Button (Image Upload Only) */}
            <button
              className="comp-btn-add-gear-upload"
              onClick={triggerAddNewGear}
            >
              <Icon>add_photo_alternate</Icon> + Add Gear → Upload Images
            </button>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 4. ASSEMBLY CONTEXT                                                       */}
        {/* ========================================================================= */}
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

        {/* ========================================================================= */}
        {/* 5. ENVIRONMENT CONTEXT                                                    */}
        {/* ========================================================================= */}
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

      {/* ========================================================================= */}
      {/* MODAL 1: Replace Companion Confirmation                                    */}
      {/* ========================================================================= */}
      {replaceModal && (
        <div className="modal-backdrop-custom" role="dialog" aria-modal="true">
          <div className="modal-content-custom">
            <div className="modal-header-custom">
              <Icon className="warn-icon">swap_horiz</Icon>
              <h4>Replace Current Companion Gear?</h4>
            </div>
            <p className="modal-desc-custom">
              Only one gear can be designated as the Companion Gear at a time.
            </p>
            <div className="replace-comparison-box">
              <div className="replace-row">
                <span>Current Companion:</span>
                <strong>{replaceModal.conflict?.currentCompanion?.name || 'Current Gear'}</strong>
              </div>
              <div className="replace-row new-val">
                <span>New Companion:</span>
                <strong>
                  {getAllComponents(machineryState).find((c) => c.id === replaceModal.targetId)?.name || 'New Gear'}
                </strong>
              </div>
            </div>
            <p className="replace-note">
              The current companion gear will be safely demoted to an <em>Additional Gear</em> in the machinery.
            </p>
            <div className="modal-actions-custom">
              <button className="btn-cancel-custom" onClick={() => setReplaceModal(null)}>
                Cancel
              </button>
              <button className="btn-replace-custom" onClick={handleConfirmReplace}>
                Replace Companion
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: Rename Gear Modal                                                */}
      {/* ========================================================================= */}
      {renameModal && (
        <div className="modal-backdrop-custom" role="dialog" aria-modal="true">
          <form className="modal-content-custom" onSubmit={handleSaveRename}>
            <div className="modal-header-custom">
              <Icon>edit</Icon>
              <h4>Rename Gear</h4>
            </div>
            <div className="modal-form-fields">
              <label>
                <span>Gear Name</span>
                <input
                  type="text"
                  required
                  placeholder="e.g. Input Pinion, Idler Gear 32T, Output Bull Gear"
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
 * Individual Interactive Image Card supporting:
 * - Preview
 * - Delete
 * - Replace
 * - Reorder (Left/Right)
 * - Purpose Dropdown
 * - Priority Dropdown
 * - Expandable Note
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
          <img src={image.url} alt={image.name} className="comp-img-thumb" />
        ) : (
          <div className="no-preview">
            <Icon>image</Icon>
          </div>
        )}

        {/* Priority Badge */}
        <span className={`img-priority-badge ${image.priority || 'high'}`}>
          {image.priority === 'low' ? 'LOW' : image.priority === 'medium' ? 'MED' : 'HIGH'}
        </span>

        {/* Top Overlay Actions: Replace & Delete */}
        <div className="comp-img-top-actions">
          <button
            className="img-icon-btn replace"
            title="Replace this photo with a new file"
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

        {/* Bottom Overlay Actions: Reorder Arrows */}
        <div className="comp-img-bottom-actions">
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
      </div>

      {/* Image Metadata Strip */}
      <div className="comp-img-meta-strip">
        <select
          className="img-purpose-select"
          value={image.purpose || 'overall_view'}
          onChange={(e) => onUpdateMetadata('purpose', e.target.value)}
          title="Image Purpose / Feature focus"
        >
          {IMAGE_PURPOSES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        <select
          className="img-priority-select"
          value={image.priority || 'high'}
          onChange={(e) => onUpdateMetadata('priority', e.target.value)}
          title="Image Priority Level"
        >
          {IMAGE_PRIORITIES.map((pr) => (
            <option key={pr.id} value={pr.id}>
              {pr.label}
            </option>
          ))}
        </select>

        <button
          className={`img-note-toggle-btn ${image.note ? 'has-note' : ''}`}
          onClick={onToggleExpand}
          title={image.note ? `Note: ${image.note}` : 'Add note to photo'}
        >
          <Icon>sticky_note_2</Icon>
        </button>
      </div>

      {/* Expandable Image Note Drawer */}
      {isExpanded && (
        <div className="img-note-drawer">
          <input
            type="text"
            className="img-note-field"
            placeholder="Photo note (e.g. root undercut, tooth pitch 2.5mm)..."
            value={image.note || ''}
            onChange={(e) => onUpdateMetadata('note', e.target.value)}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}

export default ManageComponentsTab;
