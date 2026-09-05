/**
 * FREAKSHOWTOPUP - TELEGRAM ADMIN INTERACTIVE SESSION ENGINE
 * Manages conversational state, wizard flows, and multi-step dialogs
 * for administrative actions performed via Telegram Bot.
 */

class TelegramSessionManager {
  constructor() {
    this.sessions = new Map();
    // Auto cleanup expired sessions every 10 minutes (30 min TTL)
    setInterval(() => this.cleanupExpired(), 10 * 60 * 1000);
  }

  /**
   * Set or update active session state
   */
  setSession(chatId, stateData) {
    const key = String(chatId);
    const current = this.sessions.get(key) || {};
    this.sessions.set(key, {
      ...current,
      ...stateData,
      updatedAt: Date.now()
    });
  }

  /**
   * Get active session state
   */
  getSession(chatId) {
    const key = String(chatId);
    const session = this.sessions.get(key);
    if (!session) return null;

    // Check 30 minutes expiry
    if (Date.now() - session.updatedAt > 30 * 60 * 1000) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  /**
   * Clear active session
   */
  clearSession(chatId) {
    this.sessions.delete(String(chatId));
  }

  /**
   * Remove stale sessions older than 30 minutes
   */
  cleanupExpired() {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.updatedAt > 30 * 60 * 1000) {
        this.sessions.delete(key);
      }
    }
  }
}

const sessionManager = new TelegramSessionManager();
module.exports = sessionManager;
