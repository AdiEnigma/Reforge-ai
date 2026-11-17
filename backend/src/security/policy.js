/**
 * Central Authorization Policy Module for ReForge AI
 *
 * Roles hierarchy:
 * owner > admin > engineer > viewer
 */

export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  ENGINEER: "engineer",
  VIEWER: "viewer",
};

export const ROLE_HIERARCHY = {
  owner: 4,
  admin: 3,
  engineer: 2,
  viewer: 1,
};

export const ACTIONS = {
  // Organization management
  ORG_DELETE: "org:delete",
  ORG_UPDATE: "org:update",
  ORG_VIEW: "org:view",

  // Member management
  MEMBER_INVITE: "member:invite",
  MEMBER_REMOVE: "member:remove",
  MEMBER_ROLE_CHANGE: "member:role_change",
  MEMBER_LIST: "member:list",

  // Engineering workflows & CAD
  PART_CREATE: "part:create",
  PART_EDIT: "part:edit",
  PART_DELETE: "part:delete",
  PART_VIEW: "part:view",
  CAD_EXPORT: "cad:export",
  SIMULATION_RUN: "simulation:run",

  // Audit logs
  AUDIT_VIEW: "audit:view",
};

const ACTION_MIN_ROLES = {
  [ACTIONS.ORG_DELETE]: ROLES.OWNER,
  [ACTIONS.ORG_UPDATE]: ROLES.ADMIN,
  [ACTIONS.ORG_VIEW]: ROLES.VIEWER,

  [ACTIONS.MEMBER_INVITE]: ROLES.ADMIN,
  [ACTIONS.MEMBER_REMOVE]: ROLES.ADMIN,
  [ACTIONS.MEMBER_ROLE_CHANGE]: ROLES.ADMIN,
  [ACTIONS.MEMBER_LIST]: ROLES.VIEWER,

  [ACTIONS.PART_CREATE]: ROLES.ENGINEER,
  [ACTIONS.PART_EDIT]: ROLES.ENGINEER,
  [ACTIONS.PART_DELETE]: ROLES.ADMIN,
  [ACTIONS.PART_VIEW]: ROLES.VIEWER,
  [ACTIONS.CAD_EXPORT]: ROLES.ENGINEER,
  [ACTIONS.SIMULATION_RUN]: ROLES.ENGINEER,

  [ACTIONS.AUDIT_VIEW]: ROLES.ADMIN,
};

export function hasRoleAtLeast(userRole, requiredRole) {
  const userLevel = ROLE_HIERARCHY[userRole] || 0;
  const reqLevel = ROLE_HIERARCHY[requiredRole] || 0;
  return userLevel >= reqLevel;
}

export function canPerform(userRole, action) {
  const minRole = ACTION_MIN_ROLES[action];
  if (!minRole) return false;
  return hasRoleAtLeast(userRole, minRole);
}

export function validateRole(role) {
  if (!Object.values(ROLES).includes(role)) {
    throw new Error(`Invalid membership role: ${role}. Allowed roles: ${Object.values(ROLES).join(", ")}`);
  }
  return role;
}
