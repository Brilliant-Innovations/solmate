import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PositionRiskShadow, type Sha256Hex } from '@sol-agent-trader/contracts';

/**
 * Worker-local durable shadow journal (§15.10A): append-only JSON lines on the worker's own disk,
 * readable with Postgres down. Each entry carries the shadow, its fingerprint and the token
 * decimals the DB-down price check needs (decimals are not part of the shared contract).
 */

export interface ShadowJournalEntry {
  shadow: PositionRiskShadow;
  fingerprint: Sha256Hex;
  decimals: Record<string, number>;
  recordedAt: string;
}

export interface ShadowJournal {
  append(entry: ShadowJournalEntry): Promise<void>;
  latest(): Promise<ShadowJournalEntry | null>;
}

export class FileShadowJournal implements ShadowJournal {
  constructor(private readonly path: string) {}
  async append(entry: ShadowJournalEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8');
  }
  async latest(): Promise<ShadowJournalEntry | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return null;
    }
    const lines = text.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as ShadowJournalEntry;
        PositionRiskShadow.parse(parsed.shadow);
        return parsed;
      } catch {
        // a torn last line is skipped; the previous complete entry is the truth
      }
    }
    return null;
  }
}

export class MemoryShadowJournal implements ShadowJournal {
  entries: ShadowJournalEntry[] = [];
  async append(entry: ShadowJournalEntry): Promise<void> {
    this.entries.push(entry);
  }
  async latest(): Promise<ShadowJournalEntry | null> {
    return this.entries.at(-1) ?? null;
  }
}
