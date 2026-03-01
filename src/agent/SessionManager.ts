import { randomUUID } from 'node:crypto';
import type { AgentSession } from '../types';

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  createSession(label = 'session'): AgentSession {
    const now = Date.now();
    const session: AgentSession = {
      id: randomUUID(),
      label,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  ensureSession(sessionId: string, label = 'session'): AgentSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const created: AgentSession = {
      id: sessionId,
      label,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  touchSession(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return;
    }
    existing.updatedAt = Date.now();
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  renameSession(sessionId: string, label: string): AgentSession | undefined {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return undefined;
    }

    existing.label = label;
    existing.updatedAt = Date.now();
    return { ...existing };
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values())
      .map((session) => ({ ...session }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  exportState(): AgentSession[] {
    return this.listSessions();
  }

  importState(sessions: AgentSession[]): void {
    this.sessions.clear();
    for (const session of sessions) {
      this.sessions.set(session.id, { ...session });
    }
  }
}
