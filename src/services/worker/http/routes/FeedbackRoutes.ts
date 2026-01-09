/**
 * Feedback Routes
 *
 * Handles feedback collection for the awareness system.
 * Provides API endpoints for recording feedback signals on observations.
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { FeedbackCollector, FeedbackSignal } from '../../FeedbackCollector.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { logger } from '../../../../utils/logger.js';

export class FeedbackRoutes extends BaseRouteHandler {
  private feedbackCollector: FeedbackCollector;

  constructor(dbManager: DatabaseManager) {
    super();
    this.feedbackCollector = new FeedbackCollector(dbManager);
  }

  setupRoutes(app: express.Application): void {
    // Record feedback signal
    app.post('/api/feedback', this.handleRecordFeedback.bind(this));

    // Record that context was shown (implicit feedback)
    app.post('/api/feedback/shown', this.handleRecordShown.bind(this));

    // Get effectiveness stats
    app.get('/api/feedback/effectiveness/:observationId', this.handleGetEffectiveness.bind(this));

    // Evaluate and adjust layers (batch operation)
    app.post('/api/feedback/evaluate', this.handleEvaluateLayers.bind(this));

    // Clear expired suppressions
    app.post('/api/feedback/clear-suppressions', this.handleClearSuppressions.bind(this));
  }

  /**
   * Record a feedback signal
   * POST /api/feedback
   * Body: { observationId: number, signal: 'helpful' | 'ignored' | 'suppress' | 'demote', context?: string, sessionId?: string }
   */
  private handleRecordFeedback = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { observationId, signal, context, sessionId } = req.body;

    if (!observationId || !signal) {
      res.status(400).json({ error: 'observationId and signal are required' });
      return;
    }

    const validSignals: FeedbackSignal[] = ['helpful', 'ignored', 'suppress', 'demote'];
    if (!validSignals.includes(signal)) {
      res.status(400).json({ error: `Invalid signal. Must be one of: ${validSignals.join(', ')}` });
      return;
    }

    const result = await this.feedbackCollector.recordFeedback({
      observationId: Number(observationId),
      signal,
      timestamp: Date.now(),
      context,
      sessionId
    });

    logger.info('FEEDBACK', 'Recorded feedback via API', {
      observationId,
      signal,
      layerChanges: result.layerChanges.length,
      suppressions: result.suppressions
    });

    res.json(result);
  });

  /**
   * Record that an observation was shown in context
   * POST /api/feedback/shown
   * Body: { observationId: number, sessionId: string }
   */
  private handleRecordShown = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { observationId, sessionId } = req.body;

    if (!observationId || !sessionId) {
      res.status(400).json({ error: 'observationId and sessionId are required' });
      return;
    }

    await this.feedbackCollector.recordContextShown(Number(observationId), sessionId);

    res.json({ success: true });
  });

  /**
   * Get effectiveness stats for an observation
   * GET /api/feedback/effectiveness/:observationId
   */
  private handleGetEffectiveness = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const observationId = Number(req.params.observationId);

    if (isNaN(observationId)) {
      res.status(400).json({ error: 'Invalid observationId' });
      return;
    }

    const stats = await this.feedbackCollector.getEffectiveness(observationId);

    if (!stats) {
      res.status(404).json({ error: 'Observation not found' });
      return;
    }

    res.json(stats);
  });

  /**
   * Evaluate observations and adjust layers based on effectiveness
   * POST /api/feedback/evaluate
   * Body: { project: string }
   */
  private handleEvaluateLayers = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { project } = req.body;

    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }

    const result = await this.feedbackCollector.evaluateAndAdjustLayers(project);

    logger.info('FEEDBACK', 'Evaluated layers via API', {
      project,
      processed: result.processed,
      layerChanges: result.layerChanges.length
    });

    res.json(result);
  });

  /**
   * Clear expired suppressions
   * POST /api/feedback/clear-suppressions
   */
  private handleClearSuppressions = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const cleared = await this.feedbackCollector.clearExpiredSuppressions();

    res.json({ cleared });
  });
}
