import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type UsageCommand = "start" | "help" | "cocoa";

interface UsageCounters {
  uses: number;
  commands: Record<UsageCommand, number>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface UsageUser extends UsageCounters {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
}

export interface UsageStatistics {
  version: 1;
  totalUses: number;
  anonymousUses: number;
  commands: Record<UsageCommand, number>;
  users: Record<string, UsageUser>;
  chats: Record<string, UsageCounters & { id: number; type: string; title?: string }>;
  recentUpdateIds: number[];
  startedAt: string;
}

export interface UsageEvent {
  updateId: number;
  command: UsageCommand;
  user?: Pick<UsageUser, "id" | "firstName" | "lastName" | "username" | "languageCode" | "isPremium">;
  chat?: { id: number; type: string; title?: string };
}

function emptyCommands(): Record<UsageCommand, number> {
  return { start: 0, help: 0, cocoa: 0 };
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCounters(value: unknown): value is UsageCounters {
  if (!value || typeof value !== "object") return false;
  const counters = value as UsageCounters;
  return isCount(counters.uses) && isCommands(counters.commands) &&
    typeof counters.firstSeenAt === "string" && typeof counters.lastSeenAt === "string";
}

function isCommands(value: unknown): value is Record<UsageCommand, number> {
  if (!value || typeof value !== "object") return false;
  const commands = value as Record<UsageCommand, number>;
  return ["start", "help", "cocoa"].every((key) => isCount(commands[key as UsageCommand]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function increment(counters: UsageCounters, command: UsageCommand, now: string): void {
  counters.uses += 1;
  counters.commands[command] += 1;
  counters.lastSeenAt = now;
}

/** One writer per file. Changes are published in memory only after atomic persistence. */
export class UsageStatisticsService {
  private pending: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private state: UsageStatistics) {}

  static async open(path: string): Promise<UsageStatisticsService> {
    let state: UsageStatistics;
    try {
      state = JSON.parse(await readFile(path, "utf8")) as UsageStatistics;
      if (
        !state || state.version !== 1 || !isCount(state.totalUses) ||
        !isCount(state.anonymousUses) || !isCommands(state.commands) ||
        typeof state.startedAt !== "string" ||
        !isRecord(state.users) || !isRecord(state.chats) ||
        !Object.entries(state.users).every(([id, user]) =>
          isCounters(user) && String(user.id) === id && Number.isSafeInteger(user.id) && typeof user.firstName === "string") ||
        !Object.entries(state.chats).every(([id, chat]) =>
          isCounters(chat) && String(chat.id) === id && Number.isSafeInteger(chat.id) && typeof chat.type === "string") ||
        !Array.isArray(state.recentUpdateIds) || !state.recentUpdateIds.every(isCount)
      ) {
        throw new Error("Invalid usage statistics file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      state = {
        version: 1, totalUses: 0, anonymousUses: 0, commands: emptyCommands(),
        users: {}, chats: {}, recentUpdateIds: [], startedAt: new Date().toISOString()
      };
    }
    await mkdir(dirname(path), { recursive: true });
    const service = new UsageStatisticsService(path, state);
    await service.persist(state);
    return service;
  }

  record(event: UsageEvent): Promise<void> {
    const operation = this.pending.then(async () => {
      if (this.state.recentUpdateIds.includes(event.updateId)) return;
      const state = structuredClone(this.state);
      const now = new Date().toISOString();
      const counters = (): UsageCounters => ({
        uses: 0, commands: emptyCommands(), firstSeenAt: now, lastSeenAt: now
      });
      state.totalUses += 1;
      state.commands[event.command] += 1;
      if (event.user) {
        const key = String(event.user.id);
        const previous = state.users[key] ?? counters();
        // Replace profile fields so removed usernames and names do not stay stale.
        state.users[key] = {
          uses: previous.uses, commands: previous.commands,
          firstSeenAt: previous.firstSeenAt, lastSeenAt: previous.lastSeenAt,
          ...event.user
        };
        increment(state.users[key], event.command, now);
      } else {
        state.anonymousUses += 1;
      }
      if (event.chat) {
        const key = String(event.chat.id);
        state.chats[key] = { ...(state.chats[key] ?? counters()), ...event.chat };
        increment(state.chats[key], event.command, now);
      }
      state.recentUpdateIds = [...state.recentUpdateIds.slice(-999), event.updateId];
      await this.persist(state);
      this.state = state;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async snapshot(): Promise<UsageStatistics> {
    await this.pending;
    return structuredClone(this.state);
  }

  private async persist(state: UsageStatistics): Promise<void> {
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}
