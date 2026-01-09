/**
 * Type definitions for observation operations
 * Extracted from SessionStore.ts for modular organization
 */
import { logger } from '../../../utils/logger.js';

/**
 * Awareness layer levels for the Cognitive Copilot architecture
 * 1 = Raw: Just observed, not yet validated
 * 2 = Soft: Noticed pattern, may be relevant
 * 3 = Contextual: Confirmed relevant in specific contexts
 * 4 = Active: Ready for injection when context matches
 */
export type AwarenessLayer = 1 | 2 | 3 | 4;

/**
 * Awareness metadata for observations
 * Tracks the observation's position in the awareness lifecycle
 */
export interface AwarenessMetadata {
  /** Current awareness layer (1-4) */
  awareness_layer?: AwarenessLayer;
  /** Context signals when this observation is relevant (e.g., ["debugging", "typescript"]) */
  relevance_signals?: string[];
  /** How many times this pattern has been observed */
  recurrence_count?: number;
  /** Epoch timestamp when promoted to current layer */
  promoted_at?: number;
  /** Epoch timestamp until which this should not be injected (null = not suppressed) */
  suppressed_until?: number | null;
}

/**
 * Input type for storeObservation function
 */
export interface ObservationInput {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  /** Optional awareness metadata for layer-based context management */
  awareness?: AwarenessMetadata;
}

/**
 * Result from storing an observation
 */
export interface StoreObservationResult {
  id: number;
  createdAtEpoch: number;
}

/**
 * Options for getObservationsByIds
 */
export interface GetObservationsByIdsOptions {
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
  type?: string | string[];
  concepts?: string | string[];
  files?: string | string[];
}

/**
 * Result type for getFilesForSession
 */
export interface SessionFilesResult {
  filesRead: string[];
  filesModified: string[];
}

/**
 * Simple observation row for getObservationsForSession
 */
export interface ObservationSessionRow {
  title: string;
  subtitle: string;
  type: string;
  prompt_number: number | null;
}

/**
 * Recent observation row type
 */
export interface RecentObservationRow {
  type: string;
  text: string;
  prompt_number: number | null;
  created_at: string;
}

/**
 * Full recent observation row (for web UI)
 */
export interface AllRecentObservationRow {
  id: number;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string;
  project: string;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}
