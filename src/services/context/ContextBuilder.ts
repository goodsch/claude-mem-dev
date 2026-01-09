/**
 * ContextBuilder - Main orchestrator for context generation
 *
 * Coordinates all context generation components to build the final output.
 * This is the primary entry point for context generation.
 */

import path from 'path';
import { homedir } from 'os';
import { unlinkSync } from 'fs';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { getProjectName } from '../../utils/project-name.js';

import type { ContextInput, ContextConfig, Observation, SessionSummary } from './types.js';
import { loadContextConfig } from './ContextConfigLoader.js';
import { calculateTokenEconomics } from './TokenCalculator.js';
import {
  queryObservations,
  queryObservationsMulti,
  querySummaries,
  querySummariesMulti,
  getPriorSessionMessages,
  prepareSummariesForTimeline,
  buildTimeline,
  getFullObservationIds,
} from './ObservationCompiler.js';
import {
  filterByRelevance,
  type CurrentContext,
  type GateableObservation,
} from './RelevanceGate.js';
import { renderHeader } from './sections/HeaderRenderer.js';
import { renderTimeline } from './sections/TimelineRenderer.js';
import { shouldShowSummary, renderSummaryFields } from './sections/SummaryRenderer.js';
import { renderPreviouslySection, renderFooter } from './sections/FooterRenderer.js';
import { renderMarkdownEmptyState } from './formatters/MarkdownFormatter.js';
import { renderColorEmptyState } from './formatters/ColorFormatter.js';

// Version marker path for native module error handling
const VERSION_MARKER_PATH = path.join(
  homedir(),
  '.claude',
  'plugins',
  'marketplaces',
  'thedotmack',
  'plugin',
  '.install-version'
);

/**
 * Initialize database connection with error handling
 */
function initializeDatabase(): SessionStore | null {
  try {
    return new SessionStore();
  } catch (error: any) {
    if (error.code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        logger.debug('SYSTEM', 'Marker file cleanup failed (may not exist)', {}, unlinkError as Error);
      }
      logger.error('SYSTEM', 'Native module rebuild needed - restart Claude Code to auto-fix');
      return null;
    }
    throw error;
  }
}

/**
 * Render empty state when no data exists
 */
function renderEmptyState(project: string, useColors: boolean): string {
  return useColors ? renderColorEmptyState(project) : renderMarkdownEmptyState(project);
}

/**
 * Build context output from loaded data
 */
function buildContextOutput(
  project: string,
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
  useColors: boolean
): string {
  const output: string[] = [];

  // Calculate token economics
  const economics = calculateTokenEconomics(observations);

  // Render header section
  output.push(...renderHeader(project, economics, config, useColors));

  // Prepare timeline data
  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  const timeline = buildTimeline(observations, summariesForTimeline);
  const fullObservationIds = getFullObservationIds(observations, config.fullObservationCount);

  // Render timeline
  output.push(...renderTimeline(timeline, fullObservationIds, config, cwd, useColors));

  // Render most recent summary if applicable
  const mostRecentSummary = summaries[0];
  const mostRecentObservation = observations[0];

  if (shouldShowSummary(config, mostRecentSummary, mostRecentObservation)) {
    output.push(...renderSummaryFields(mostRecentSummary, useColors));
  }

  // Render previously section (prior assistant message)
  const priorMessages = getPriorSessionMessages(observations, config, sessionId, cwd);
  output.push(...renderPreviouslySection(priorMessages, useColors));

  // Render footer
  output.push(...renderFooter(economics, config, useColors));

  return output.join('\n').trimEnd();
}

/**
 * Generate context for a project
 *
 * Main entry point for context generation. Orchestrates loading config,
 * querying data, and rendering the final context string.
 */
export async function generateContext(
  input?: ContextInput,
  useColors: boolean = false
): Promise<string> {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const project = getProjectName(cwd);

  // Use provided projects array (for worktree support) or fall back to single project
  const projects = input?.projects || [project];

  // Initialize database
  const db = initializeDatabase();
  if (!db) {
    return '';
  }

  try {
    // Query data for all projects (supports worktree: parent + worktree combined)
    const rawObservations = projects.length > 1
      ? queryObservationsMulti(db, projects, config)
      : queryObservations(db, project, config);
    const summaries = projects.length > 1
      ? querySummariesMulti(db, projects, config)
      : querySummaries(db, project, config);

    // Handle empty state
    if (rawObservations.length === 0 && summaries.length === 0) {
      return renderEmptyState(project, useColors);
    }

    // Apply relevance gating to filter observations by awareness layer
    // Build current context for relevance evaluation
    const currentContext: CurrentContext = {
      project,
      currentTime: Date.now(),
      // Extract recent concepts from observations for context matching
      recentConcepts: extractRecentConcepts(rawObservations.slice(0, 5)),
      // Extract recent types for pattern matching
      recentTypes: extractRecentTypes(rawObservations.slice(0, 10)),
    };

    // Filter observations through relevance gate
    // Observations without awareness_layer (legacy) bypass gating
    const observations = applyRelevanceGating(rawObservations, currentContext, config);

    // Build and return context
    return buildContextOutput(
      project,
      observations,
      summaries,
      config,
      cwd,
      input?.session_id,
      useColors
    );
  } finally {
    db.close();
  }
}

/**
 * Apply relevance gating to filter observations by awareness layer
 *
 * Observations without awareness_layer (legacy data) are passed through unchanged.
 * New observations with awareness metadata are filtered based on layer rules:
 * - Layer 1 (Raw): Never injected
 * - Layer 2 (Soft): Injected if signal match >= 60%
 * - Layer 3 (Contextual): Injected if signal match >= 30%
 * - Layer 4 (Active): Always injected
 */
function applyRelevanceGating(
  observations: Observation[],
  context: CurrentContext,
  config: ContextConfig
): Observation[] {
  // Separate legacy (no awareness layer) from gated observations
  const legacyObservations: Observation[] = [];
  const gateableObservations: GateableObservation[] = [];

  for (const obs of observations) {
    if (obs.awareness_layer === null || obs.awareness_layer === undefined) {
      // Legacy observation - pass through unchanged
      legacyObservations.push(obs);
    } else {
      // Convert to gateable format for evaluation
      gateableObservations.push({
        id: obs.id,
        type: obs.type,
        title: obs.title,
        concepts: obs.concepts || '[]',
        files_read: obs.files_read || undefined,
        files_modified: obs.files_modified || undefined,
        awareness_layer: obs.awareness_layer as 1 | 2 | 3 | 4,
        relevance_signals: obs.relevance_signals || null,
        recurrence_count: obs.recurrence_count || null,
        suppressed_until: obs.suppressed_until || null,
      });
    }
  }

  // Apply relevance filtering to gated observations
  // Reserve most of the budget for gated observations, but ensure some legacy ones show
  const legacyBudget = Math.min(legacyObservations.length, Math.floor(config.totalObservationCount * 0.3));
  const gatedBudget = config.totalObservationCount - legacyBudget;

  const filteredGated = filterByRelevance(gateableObservations, context, gatedBudget);

  // Convert filtered results back to Observation type
  const gatedResults: Observation[] = filteredGated.map(({ observation }) => {
    // Find original observation to preserve all fields
    const original = observations.find(o => o.id === observation.id);
    return original!;
  });

  // Combine: gated results first (most relevant), then legacy
  return [...gatedResults, ...legacyObservations.slice(0, legacyBudget)];
}

/**
 * Extract recent concepts from observations for context matching
 */
function extractRecentConcepts(observations: Observation[]): string[] {
  const concepts = new Set<string>();

  for (const obs of observations) {
    if (obs.concepts) {
      try {
        const parsed = JSON.parse(obs.concepts);
        if (Array.isArray(parsed)) {
          for (const concept of parsed) {
            concepts.add(concept);
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return Array.from(concepts);
}

/**
 * Extract recent observation types for pattern matching
 */
function extractRecentTypes(observations: Observation[]): string[] {
  const types = new Set<string>();

  for (const obs of observations) {
    if (obs.type) {
      types.add(obs.type);
    }
  }

  return Array.from(types);
}
