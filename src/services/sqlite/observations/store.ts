/**
 * Store observation function
 * Extracted from SessionStore.ts for modular organization
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { ObservationInput, StoreObservationResult } from './types.js';

/**
 * Store an observation (from SDK parsing)
 * Assumes session already exists (created by hook)
 *
 * Supports optional awareness metadata for the Cognitive Copilot architecture:
 * - awareness_layer: 1-4 (Raw → Soft → Contextual → Active)
 * - relevance_signals: Context signals when observation applies
 * - recurrence_count: How many times pattern observed
 * - promoted_at: When promoted to current layer
 * - suppressed_until: Temporary suppression timestamp
 */
export function storeObservation(
  db: Database,
  memorySessionId: string,
  project: string,
  observation: ObservationInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreObservationResult {
  // Use override timestamp if provided (for processing backlog messages with original timestamps)
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Extract awareness metadata with defaults
  const awareness = observation.awareness ?? {};
  const awarenessLayer = awareness.awareness_layer ?? 1; // Default: Raw
  const relevanceSignals = JSON.stringify(awareness.relevance_signals ?? []);
  const recurrenceCount = awareness.recurrence_count ?? 1;
  const promotedAt = awareness.promoted_at ?? null;
  const suppressedUntil = awareness.suppressed_until ?? null;

  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch,
     awareness_layer, relevance_signals, recurrence_count, promoted_at, suppressed_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    memorySessionId,
    project,
    observation.type,
    observation.title,
    observation.subtitle,
    JSON.stringify(observation.facts),
    observation.narrative,
    JSON.stringify(observation.concepts),
    JSON.stringify(observation.files_read),
    JSON.stringify(observation.files_modified),
    promptNumber || null,
    discoveryTokens,
    timestampIso,
    timestampEpoch,
    awarenessLayer,
    relevanceSignals,
    recurrenceCount,
    promotedAt,
    suppressedUntil
  );

  return {
    id: Number(result.lastInsertRowid),
    createdAtEpoch: timestampEpoch
  };
}
