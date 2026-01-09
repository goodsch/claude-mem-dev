/**
 * FeedbackCollector: Implicit and explicit feedback collection for awareness system
 *
 * Responsibility:
 * - Collect implicit feedback signals (context usage patterns)
 * - Process explicit feedback (suppress/helpful markers)
 * - Adjust observation awareness layers based on feedback
 * - Track observation effectiveness over time
 *
 * Design:
 * - Non-blocking: doesn't affect primary conversation
 * - Works with RelevanceGate to improve injection decisions
 * - Supports both implicit (behavioral) and explicit (user action) feedback
 *
 * Feedback Signals:
 * - HELPFUL: User engaged with injected context (asked follow-up, used suggestion)
 * - IGNORED: Context was shown but user didn't interact
 * - SUPPRESS: User explicitly marked as not helpful (temporary hide)
 * - DEMOTE: Repeatedly ignored observations should drop layers
 */

import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { AwarenessLayer } from '../sqlite/observations/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Feedback signal types
 */
export type FeedbackSignal = 'helpful' | 'ignored' | 'suppress' | 'demote';

/**
 * Feedback event record
 */
export interface FeedbackEvent {
  /** Observation that received feedback */
  observationId: number;
  /** Type of feedback signal */
  signal: FeedbackSignal;
  /** When feedback was recorded */
  timestamp: number;
  /** Optional context about the feedback */
  context?: string;
  /** Session where feedback occurred */
  sessionId?: string;
}

/**
 * Observation effectiveness stats
 */
export interface ObservationEffectiveness {
  observationId: number;
  /** Total times shown */
  showCount: number;
  /** Times user engaged */
  helpfulCount: number;
  /** Times user ignored */
  ignoredCount: number;
  /** Times explicitly suppressed */
  suppressCount: number;
  /** Effectiveness ratio (helpful / shown) */
  effectivenessRatio: number;
  /** Last feedback timestamp */
  lastFeedback: number;
}

/**
 * Batch feedback result
 */
export interface FeedbackResult {
  processed: number;
  layerChanges: Array<{
    observationId: number;
    fromLayer: AwarenessLayer;
    toLayer: AwarenessLayer;
    reason: string;
  }>;
  suppressions: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default suppression duration (24 hours) */
const DEFAULT_SUPPRESSION_DURATION_MS = 24 * 60 * 60 * 1000;

/** Ignore threshold for demotion (times ignored before considering demotion) */
const IGNORE_THRESHOLD_FOR_DEMOTION = 5;

/** Effectiveness ratio threshold for promotion */
const EFFECTIVENESS_THRESHOLD_FOR_PROMOTION = 0.7;

/** Effectiveness ratio threshold for demotion */
const EFFECTIVENESS_THRESHOLD_FOR_DEMOTION = 0.2;

/** Minimum show count before evaluating effectiveness */
const MIN_SHOWS_FOR_EVALUATION = 3;

// ============================================================================
// FeedbackCollector Class
// ============================================================================

export class FeedbackCollector {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Record a feedback signal for an observation
   */
  async recordFeedback(event: FeedbackEvent): Promise<FeedbackResult> {
    const sessionStore = this.dbManager.getSessionStore();
    const result: FeedbackResult = {
      processed: 1,
      layerChanges: [],
      suppressions: 0
    };

    try {
      // Store feedback event
      sessionStore.recordFeedbackEvent(
        event.observationId,
        event.signal,
        event.timestamp,
        event.context,
        event.sessionId
      );

      // Handle immediate actions based on signal type
      switch (event.signal) {
        case 'suppress':
          await this.handleSuppression(event, result);
          break;

        case 'demote':
          await this.handleExplicitDemotion(event, result);
          break;

        case 'helpful':
          await this.handleHelpfulFeedback(event, result);
          break;

        case 'ignored':
          await this.handleIgnoredFeedback(event, result);
          break;
      }

      logger.info('FEEDBACK', 'Recorded feedback signal', {
        observationId: event.observationId,
        signal: event.signal,
        layerChanges: result.layerChanges.length,
        suppressions: result.suppressions
      });

      return result;
    } catch (error) {
      logger.error('FEEDBACK', 'Failed to record feedback', {
        observationId: event.observationId,
        signal: event.signal
      }, error as Error);
      throw error;
    }
  }

  /**
   * Record that an observation was shown in context (implicit feedback)
   */
  async recordContextShown(
    observationId: number,
    sessionId: string
  ): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();

    try {
      sessionStore.incrementObservationShowCount(observationId, Date.now());

      logger.debug('FEEDBACK', 'Recorded context shown', {
        observationId,
        sessionId
      });
    } catch (error) {
      logger.warn('FEEDBACK', 'Failed to record context shown', {
        observationId,
        sessionId
      }, error as Error);
    }
  }

  /**
   * Get effectiveness stats for an observation
   */
  async getEffectiveness(observationId: number): Promise<ObservationEffectiveness | null> {
    const sessionStore = this.dbManager.getSessionStore();

    try {
      return sessionStore.getObservationEffectiveness(observationId);
    } catch (error) {
      logger.warn('FEEDBACK', 'Failed to get effectiveness', {
        observationId
      }, error as Error);
      return null;
    }
  }

  /**
   * Batch evaluate observations and adjust layers based on effectiveness
   *
   * This should be called periodically (e.g., by CrystallizerAgent or daily job)
   */
  async evaluateAndAdjustLayers(project: string): Promise<FeedbackResult> {
    const sessionStore = this.dbManager.getSessionStore();
    const result: FeedbackResult = {
      processed: 0,
      layerChanges: [],
      suppressions: 0
    };

    try {
      // Get observations with enough data for evaluation
      const candidates = sessionStore.getObservationsForEffectivenessEvaluation(
        project,
        MIN_SHOWS_FOR_EVALUATION
      );

      for (const obs of candidates) {
        result.processed++;

        // Get effectiveness stats
        const stats = await this.getEffectiveness(obs.id);
        if (!stats) continue;

        // Evaluate for promotion or demotion
        const currentLayer = obs.awareness_layer as AwarenessLayer || 1;

        if (stats.effectivenessRatio >= EFFECTIVENESS_THRESHOLD_FOR_PROMOTION && currentLayer < 4) {
          // Promote effective observations
          const newLayer = Math.min(currentLayer + 1, 4) as AwarenessLayer;
          sessionStore.promoteObservationLayer(obs.id, newLayer, Date.now());

          result.layerChanges.push({
            observationId: obs.id,
            fromLayer: currentLayer,
            toLayer: newLayer,
            reason: `High effectiveness (${(stats.effectivenessRatio * 100).toFixed(0)}%)`
          });

        } else if (stats.effectivenessRatio <= EFFECTIVENESS_THRESHOLD_FOR_DEMOTION && currentLayer > 1) {
          // Demote ineffective observations
          const newLayer = Math.max(currentLayer - 1, 1) as AwarenessLayer;
          sessionStore.demoteObservationLayer(obs.id, newLayer, Date.now());

          result.layerChanges.push({
            observationId: obs.id,
            fromLayer: currentLayer,
            toLayer: newLayer,
            reason: `Low effectiveness (${(stats.effectivenessRatio * 100).toFixed(0)}%)`
          });
        }
      }

      if (result.layerChanges.length > 0) {
        logger.info('FEEDBACK', 'Adjusted observation layers', {
          project,
          processed: result.processed,
          changes: result.layerChanges.length
        });
      }

      return result;
    } catch (error) {
      logger.error('FEEDBACK', 'Failed to evaluate and adjust layers', {
        project
      }, error as Error);
      throw error;
    }
  }

  /**
   * Clear expired suppressions
   *
   * Should be called periodically to re-enable suppressed observations
   */
  async clearExpiredSuppressions(): Promise<number> {
    const sessionStore = this.dbManager.getSessionStore();

    try {
      const cleared = sessionStore.clearExpiredSuppressions(Date.now());

      if (cleared > 0) {
        logger.info('FEEDBACK', 'Cleared expired suppressions', { count: cleared });
      }

      return cleared;
    } catch (error) {
      logger.error('FEEDBACK', 'Failed to clear expired suppressions', {}, error as Error);
      return 0;
    }
  }

  // ============================================================================
  // Private Handlers
  // ============================================================================

  /**
   * Handle suppress feedback - temporarily hide observation
   */
  private async handleSuppression(
    event: FeedbackEvent,
    result: FeedbackResult
  ): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();

    // Set suppression until timestamp
    const suppressUntil = event.timestamp + DEFAULT_SUPPRESSION_DURATION_MS;
    sessionStore.suppressObservation(event.observationId, suppressUntil);

    result.suppressions = 1;

    logger.info('FEEDBACK', 'Suppressed observation', {
      observationId: event.observationId,
      until: new Date(suppressUntil).toISOString()
    });
  }

  /**
   * Handle explicit demotion request
   */
  private async handleExplicitDemotion(
    event: FeedbackEvent,
    result: FeedbackResult
  ): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();

    // Get current layer
    const obs = sessionStore.getObservationById(event.observationId);
    if (!obs) return;

    const currentLayer = (obs.awareness_layer as AwarenessLayer) || 1;
    if (currentLayer <= 1) return; // Can't demote below Layer 1

    const newLayer = (currentLayer - 1) as AwarenessLayer;
    sessionStore.demoteObservationLayer(event.observationId, newLayer, event.timestamp);

    result.layerChanges.push({
      observationId: event.observationId,
      fromLayer: currentLayer,
      toLayer: newLayer,
      reason: 'Explicit user demotion'
    });
  }

  /**
   * Handle helpful feedback - potentially promote
   */
  private async handleHelpfulFeedback(
    event: FeedbackEvent,
    result: FeedbackResult
  ): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();

    // Increment helpful count
    sessionStore.incrementObservationHelpfulCount(event.observationId, event.timestamp);

    // Check if this warrants immediate promotion
    const stats = await this.getEffectiveness(event.observationId);
    if (!stats) return;

    // Only consider promotion if we have enough data
    if (stats.showCount < MIN_SHOWS_FOR_EVALUATION) return;

    const obs = sessionStore.getObservationById(event.observationId);
    if (!obs) return;

    const currentLayer = (obs.awareness_layer as AwarenessLayer) || 1;

    // Promote if effectiveness exceeds threshold and not at max layer
    if (stats.effectivenessRatio >= EFFECTIVENESS_THRESHOLD_FOR_PROMOTION && currentLayer < 4) {
      const newLayer = Math.min(currentLayer + 1, 4) as AwarenessLayer;
      sessionStore.promoteObservationLayer(event.observationId, newLayer, event.timestamp);

      result.layerChanges.push({
        observationId: event.observationId,
        fromLayer: currentLayer,
        toLayer: newLayer,
        reason: `Helpful feedback (${(stats.effectivenessRatio * 100).toFixed(0)}% effective)`
      });
    }
  }

  /**
   * Handle ignored feedback - potentially demote
   */
  private async handleIgnoredFeedback(
    event: FeedbackEvent,
    result: FeedbackResult
  ): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();

    // Increment ignored count
    sessionStore.incrementObservationIgnoredCount(event.observationId, event.timestamp);

    // Check if this warrants demotion
    const stats = await this.getEffectiveness(event.observationId);
    if (!stats) return;

    // Consider demotion if ignored too many times
    if (stats.ignoredCount < IGNORE_THRESHOLD_FOR_DEMOTION) return;

    const obs = sessionStore.getObservationById(event.observationId);
    if (!obs) return;

    const currentLayer = (obs.awareness_layer as AwarenessLayer) || 1;

    // Demote if effectiveness is below threshold
    if (stats.effectivenessRatio <= EFFECTIVENESS_THRESHOLD_FOR_DEMOTION && currentLayer > 1) {
      const newLayer = Math.max(currentLayer - 1, 1) as AwarenessLayer;
      sessionStore.demoteObservationLayer(event.observationId, newLayer, event.timestamp);

      result.layerChanges.push({
        observationId: event.observationId,
        fromLayer: currentLayer,
        toLayer: newLayer,
        reason: `Ignored ${stats.ignoredCount}x (${(stats.effectivenessRatio * 100).toFixed(0)}% effective)`
      });
    }
  }
}
