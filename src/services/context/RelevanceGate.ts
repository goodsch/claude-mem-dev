/**
 * RelevanceGate - Awareness layer filtering for context injection
 *
 * Responsibility:
 * - Evaluate observations against relevance criteria
 * - Filter based on awareness_layer thresholds
 * - Match relevance_signals against current context
 * - Support promotion decisions for layer advancement
 *
 * Design:
 * - Layer 1 (Raw): Never injected - just observed
 * - Layer 2 (Soft): Injected only if signals match strongly
 * - Layer 3 (Contextual): Injected when context matches
 * - Layer 4 (Active): Always injected when in scope
 */

import type { AwarenessLayer } from '../sqlite/observations/types.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Relevance gate criteria for evaluating observations
 */
export interface RelevanceGate {
  /** Has the pattern been observed multiple times? */
  recurrence: boolean;
  /** Is there a clear usage context when this applies? */
  when_context: boolean;
  /** Is this relevant to the current situation? */
  relevant_now: boolean;
}

/**
 * Current context for relevance evaluation
 */
export interface CurrentContext {
  /** Project being worked on */
  project: string;
  /** Files currently being touched (if known) */
  activeFiles?: string[];
  /** Recent observation types in this session */
  recentTypes?: string[];
  /** Recent concepts observed in this session */
  recentConcepts?: string[];
  /** Current time (for suppression checks) */
  currentTime: number;
}

/**
 * Observation with awareness metadata for gating evaluation
 */
export interface GateableObservation {
  id: number;
  type: string;
  title: string | null;
  concepts: string; // JSON stringified array
  files_read?: string; // JSON stringified array
  files_modified?: string; // JSON stringified array
  awareness_layer: AwarenessLayer | null;
  relevance_signals: string | null; // JSON stringified array
  recurrence_count: number | null;
  suppressed_until: number | null;
}

/**
 * Result of relevance evaluation
 */
export interface RelevanceResult {
  /** Should this observation be injected? */
  shouldInject: boolean;
  /** Confidence score (0-1) for injection */
  confidence: number;
  /** Reason for the decision */
  reason: string;
  /** Suggested layer promotion (if any) */
  suggestedPromotion?: {
    toLayer: AwarenessLayer;
    reason: string;
  };
}

/**
 * Promotion decision result
 */
export interface PromotionDecision {
  promote: boolean;
  toLayer: AwarenessLayer;
  reason: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum recurrence count to consider for promotion */
const MIN_RECURRENCE_FOR_LAYER_2 = 2;

/** Minimum recurrence count for layer 3 promotion */
const MIN_RECURRENCE_FOR_LAYER_3 = 3;

/** Signal match threshold for layer 2 injection (0-1) */
const LAYER_2_SIGNAL_MATCH_THRESHOLD = 0.6;

/** Signal match threshold for layer 3 injection (0-1) */
const LAYER_3_SIGNAL_MATCH_THRESHOLD = 0.3;

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Evaluate if an observation should be injected into context
 *
 * @param observation - The observation to evaluate
 * @param context - Current context for relevance matching
 * @returns Relevance result with injection decision
 */
export function evaluateRelevance(
  observation: GateableObservation,
  context: CurrentContext
): RelevanceResult {
  // Check suppression first
  if (observation.suppressed_until && observation.suppressed_until > context.currentTime) {
    return {
      shouldInject: false,
      confidence: 0,
      reason: 'Observation is suppressed until ' + new Date(observation.suppressed_until).toISOString()
    };
  }

  const layer = observation.awareness_layer ?? 1;

  // Layer 1 (Raw): Never inject - still in validation
  if (layer === 1) {
    const gate = evaluateGateCriteria(observation, context);
    const suggestedPromotion = shouldPromoteFromLayer1(observation, gate);

    return {
      shouldInject: false,
      confidence: 0,
      reason: 'Layer 1 (Raw) - awaiting pattern validation',
      suggestedPromotion
    };
  }

  // Layer 2 (Soft): Inject only if signals match strongly
  if (layer === 2) {
    const signalMatch = calculateSignalMatch(observation, context);

    if (signalMatch >= LAYER_2_SIGNAL_MATCH_THRESHOLD) {
      const gate = evaluateGateCriteria(observation, context);
      const suggestedPromotion = shouldPromoteFromLayer2(observation, gate);

      return {
        shouldInject: true,
        confidence: signalMatch,
        reason: `Layer 2 (Soft) - strong signal match (${(signalMatch * 100).toFixed(0)}%)`,
        suggestedPromotion
      };
    }

    return {
      shouldInject: false,
      confidence: signalMatch,
      reason: `Layer 2 (Soft) - signal match too weak (${(signalMatch * 100).toFixed(0)}% < ${(LAYER_2_SIGNAL_MATCH_THRESHOLD * 100).toFixed(0)}%)`
    };
  }

  // Layer 3 (Contextual): Inject when context matches
  if (layer === 3) {
    const signalMatch = calculateSignalMatch(observation, context);

    if (signalMatch >= LAYER_3_SIGNAL_MATCH_THRESHOLD) {
      const gate = evaluateGateCriteria(observation, context);
      const suggestedPromotion = shouldPromoteFromLayer3(observation, gate);

      return {
        shouldInject: true,
        confidence: Math.min(signalMatch + 0.3, 1.0), // Boost confidence for layer 3
        reason: `Layer 3 (Contextual) - context match (${(signalMatch * 100).toFixed(0)}%)`,
        suggestedPromotion
      };
    }

    return {
      shouldInject: false,
      confidence: signalMatch,
      reason: `Layer 3 (Contextual) - context mismatch (${(signalMatch * 100).toFixed(0)}% < ${(LAYER_3_SIGNAL_MATCH_THRESHOLD * 100).toFixed(0)}%)`
    };
  }

  // Layer 4 (Active): Always inject when in scope
  if (layer === 4) {
    return {
      shouldInject: true,
      confidence: 1.0,
      reason: 'Layer 4 (Active) - actively relevant'
    };
  }

  // Fallback for unknown layers
  return {
    shouldInject: false,
    confidence: 0,
    reason: `Unknown awareness layer: ${layer}`
  };
}

/**
 * Evaluate gate criteria for an observation
 */
export function evaluateGateCriteria(
  observation: GateableObservation,
  context: CurrentContext
): RelevanceGate {
  const recurrence = (observation.recurrence_count ?? 0) >= MIN_RECURRENCE_FOR_LAYER_2;

  // Parse relevance signals
  const signals = parseJsonArray(observation.relevance_signals);
  const when_context = signals.length > 0;

  // Check if relevant now based on signal matching
  const signalMatch = calculateSignalMatch(observation, context);
  const relevant_now = signalMatch > 0.2; // Low threshold for "relevant at all"

  return {
    recurrence,
    when_context,
    relevant_now
  };
}

/**
 * Determine if an observation should be promoted to a higher layer
 */
export function shouldPromoteToLayer(
  observation: GateableObservation,
  context: CurrentContext
): PromotionDecision {
  const currentLayer = observation.awareness_layer ?? 1;
  const gate = evaluateGateCriteria(observation, context);

  // Check promotions based on current layer
  switch (currentLayer) {
    case 1: {
      const promotion = shouldPromoteFromLayer1(observation, gate);
      if (promotion) {
        return { promote: true, ...promotion };
      }
      break;
    }
    case 2: {
      const promotion = shouldPromoteFromLayer2(observation, gate);
      if (promotion) {
        return { promote: true, ...promotion };
      }
      break;
    }
    case 3: {
      const promotion = shouldPromoteFromLayer3(observation, gate);
      if (promotion) {
        return { promote: true, ...promotion };
      }
      break;
    }
    case 4:
      // Already at max layer
      break;
  }

  return {
    promote: false,
    toLayer: currentLayer as AwarenessLayer,
    reason: 'No promotion criteria met'
  };
}

/**
 * Filter observations by relevance for context injection
 *
 * @param observations - All candidate observations
 * @param context - Current context
 * @param limit - Maximum observations to include
 * @returns Filtered observations sorted by relevance
 */
export function filterByRelevance(
  observations: GateableObservation[],
  context: CurrentContext,
  limit: number
): { observation: GateableObservation; result: RelevanceResult }[] {
  const evaluated = observations.map(obs => ({
    observation: obs,
    result: evaluateRelevance(obs, context)
  }));

  // Filter to only injectable observations
  const injectable = evaluated.filter(e => e.result.shouldInject);

  // Sort by confidence (highest first), then by layer (highest first)
  injectable.sort((a, b) => {
    // First by confidence
    if (b.result.confidence !== a.result.confidence) {
      return b.result.confidence - a.result.confidence;
    }
    // Then by layer
    const layerA = a.observation.awareness_layer ?? 1;
    const layerB = b.observation.awareness_layer ?? 1;
    return layerB - layerA;
  });

  // Return limited set
  return injectable.slice(0, limit);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate signal match score between observation and context
 */
function calculateSignalMatch(
  observation: GateableObservation,
  context: CurrentContext
): number {
  const signals = parseJsonArray(observation.relevance_signals);

  if (signals.length === 0) {
    // No signals defined - check type and concept matches instead
    return calculateImplicitMatch(observation, context);
  }

  let matchScore = 0;
  let totalSignals = signals.length;

  for (const signal of signals) {
    const normalizedSignal = signal.toLowerCase();

    // Check project match
    if (normalizedSignal.includes(context.project.toLowerCase())) {
      matchScore += 1;
      continue;
    }

    // Check file path matches
    if (context.activeFiles) {
      for (const file of context.activeFiles) {
        if (normalizedSignal.includes(file.toLowerCase()) ||
            file.toLowerCase().includes(normalizedSignal)) {
          matchScore += 1;
          break;
        }
      }
    }

    // Check concept matches
    if (context.recentConcepts) {
      for (const concept of context.recentConcepts) {
        if (normalizedSignal.includes(concept.toLowerCase())) {
          matchScore += 0.5; // Partial match for concept overlap
        }
      }
    }

    // Check type matches
    if (context.recentTypes) {
      for (const type of context.recentTypes) {
        if (normalizedSignal.includes(type.toLowerCase())) {
          matchScore += 0.5; // Partial match for type overlap
        }
      }
    }
  }

  return Math.min(matchScore / totalSignals, 1.0);
}

/**
 * Calculate implicit match when no explicit signals are defined
 */
function calculateImplicitMatch(
  observation: GateableObservation,
  context: CurrentContext
): number {
  let score = 0;

  // Check file overlap
  const obsFilesRead = parseJsonArray(observation.files_read);
  const obsFilesModified = parseJsonArray(observation.files_modified);
  const obsFiles = [...obsFilesRead, ...obsFilesModified];

  if (context.activeFiles && obsFiles.length > 0) {
    const overlap = obsFiles.filter(f =>
      context.activeFiles!.some(af =>
        af.includes(f) || f.includes(af)
      )
    );
    score += overlap.length / obsFiles.length * 0.5;
  }

  // Check concept overlap
  const obsConcepts = parseJsonArray(observation.concepts);
  if (context.recentConcepts && obsConcepts.length > 0) {
    const overlap = obsConcepts.filter(c =>
      context.recentConcepts!.includes(c)
    );
    score += overlap.length / obsConcepts.length * 0.3;
  }

  // Check type overlap
  if (context.recentTypes && context.recentTypes.includes(observation.type)) {
    score += 0.2;
  }

  return Math.min(score, 1.0);
}

/**
 * Determine promotion from Layer 1 (Raw)
 */
function shouldPromoteFromLayer1(
  observation: GateableObservation,
  gate: RelevanceGate
): { toLayer: AwarenessLayer; reason: string } | undefined {
  // Promote to Layer 2 if recurrence threshold met
  if (gate.recurrence) {
    return {
      toLayer: 2,
      reason: `Recurrence threshold met (${observation.recurrence_count ?? 0}x observed)`
    };
  }

  // Promote to Layer 2 if clear context signals defined
  if (gate.when_context) {
    return {
      toLayer: 2,
      reason: 'Clear context signals defined'
    };
  }

  return undefined;
}

/**
 * Determine promotion from Layer 2 (Soft)
 */
function shouldPromoteFromLayer2(
  observation: GateableObservation,
  gate: RelevanceGate
): { toLayer: AwarenessLayer; reason: string } | undefined {
  const recurrence = observation.recurrence_count ?? 0;

  // Promote to Layer 3 if high recurrence AND currently relevant
  if (recurrence >= MIN_RECURRENCE_FOR_LAYER_3 && gate.relevant_now) {
    return {
      toLayer: 3,
      reason: `High recurrence (${recurrence}x) and currently relevant`
    };
  }

  return undefined;
}

/**
 * Determine promotion from Layer 3 (Contextual)
 */
function shouldPromoteFromLayer3(
  observation: GateableObservation,
  gate: RelevanceGate
): { toLayer: AwarenessLayer; reason: string } | undefined {
  const recurrence = observation.recurrence_count ?? 0;

  // Promote to Layer 4 if all gate criteria met AND very high recurrence
  if (gate.recurrence && gate.when_context && gate.relevant_now && recurrence >= 5) {
    return {
      toLayer: 4,
      reason: `All gate criteria met with high recurrence (${recurrence}x)`
    };
  }

  return undefined;
}

/**
 * Safely parse JSON array from string
 */
function parseJsonArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
