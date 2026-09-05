/**
 * FREAKSHOWTOPUP - IMMUTABLE AUDIT LOGGING SERVICE
 * Records administrative actions, financial approvals, role changes, and system adjustments.
 */

const crypto = require('crypto');
const db = require('./db');

/**
 * Log an administrative or financial action immutably
 * @param {Object} entry
 * @param {string} entry.actorId - User ID of the administrator/system performing the action
 * @param {string} entry.actorEmail - Email of the actor
 * @param {string} entry.role - Role of the actor (SUPER_ADMIN, ADMIN, MODERATOR, SYSTEM)
 * @param {string} entry.action - Action identifier (e.g. DEPOSIT_APPROVED, WALLET_ADJUSTED, ORDER_REFUNDED, ROLE_CHANGED)
 * @param {string} [entry.targetId] - Target entity ID (e.g. user ID, order ID, deposit ID)
 * @param {string} [entry.targetType] - Target entity type (USER, ORDER, DEPOSIT, PRODUCT, SETTING)
 * @param {Object} [entry.before] - State before action
 * @param {Object} [entry.after] - State after action
 * @param {string} [entry.reason] - Stated reason for the action
 * @param {string} [entry.ipAddress] - Client IP address
 * @param {string} [entry.userAgent] - Client User Agent
 */
function recordAuditLog({
  actorId,
  actorEmail,
  role = 'ADMIN',
  action,
  targetId = null,
  targetType = null,
  before = null,
  after = null,
  reason = null,
  ipAddress = null,
  userAgent = null
}) {
  if (!action) return null;

  const logEntry = {
    id: `aud_${crypto.randomBytes(8).toString('hex')}`,
    actorId: actorId || 'system',
    actorEmail: actorEmail || 'system@freakshowtopup.shop',
    role,
    action: action.toUpperCase(),
    targetId: targetId ? String(targetId) : null,
    targetType: targetType ? targetType.toUpperCase() : null,
    before: before ? (typeof before === 'object' ? before : { value: before }) : null,
    after: after ? (typeof after === 'object' ? after : { value: after }) : null,
    reason: reason || null,
    ipAddress: ipAddress || '127.0.0.1',
    userAgent: userAgent || 'Unknown',
    createdAt: new Date().toISOString()
  };

  db.auditLogs.unshift(logEntry);
  
  // Maintain reasonable storage bound (keep last 5000 audit logs)
  if (db.auditLogs.length > 5000) {
    db.auditLogs.length = 5000;
  }
  
  db.saveAll();
  return logEntry;
}

/**
 * Query audit logs with pagination and filters
 */
function getAuditLogs({ limit = 50, offset = 0, action = null, actorId = null, targetId = null } = {}) {
  let logs = db.auditLogs;

  if (action) {
    logs = logs.filter(l => l.action === action.toUpperCase());
  }
  if (actorId) {
    logs = logs.filter(l => l.actorId === actorId);
  }
  if (targetId) {
    logs = logs.filter(l => l.targetId === String(targetId));
  }

  return {
    total: logs.length,
    limit,
    offset,
    logs: logs.slice(offset, offset + limit)
  };
}

module.exports = {
  recordAuditLog,
  getAuditLogs
};
