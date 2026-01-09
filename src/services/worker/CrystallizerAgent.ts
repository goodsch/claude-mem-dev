/**
 * CrystallizerAgent: Background document maintenance agent
 *
 * Responsibility:
 * - Runs periodically (time-based or after N observations)
 * - Analyzes patterns and observations across a project
 * - Maintains living document of decided vs fluid concepts
 * - Tracks evolution of understanding over time
 * - Outputs human-readable summaries
 *
 * Design:
 * - Uses Haiku for cost efficiency (always-on background agent)
 * - Non-blocking: doesn't affect primary conversation
 * - Project-scoped: crystallizes understanding per project
 * - Promotes patterns from Layer 2 → Layer 3 when crystallized
 */

import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { WorkerRef } from './agents/index.js';
import type { ObservationRecord } from '../../types/database.js';

// Anthropic API endpoint
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Haiku model for cost-efficient background processing
const CRYSTALLIZER_MODEL = 'claude-3-5-haiku-latest';

// Minimum patterns needed before crystallization
const MIN_PATTERNS_FOR_CRYSTALLIZATION = 3;

// How many recent patterns to analyze
const PATTERN_WINDOW = 50;

// Cooldown between crystallization runs (ms) - longer than Noticer
const CRYSTALLIZATION_COOLDOWN_MS = 300000; // 5 minutes

// Minimum observations since last crystallization
const MIN_NEW_OBSERVATIONS = 5;

interface CrystallizationContext {
  project: string;
  patterns: PatternRecord[];
  recentObservations: ObservationRecord[];
  existingDocument: LivingDocument | null;
}

interface PatternRecord {
  id: number;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string;
  narrative: string | null;
  concepts: string;
  relevance_signals: string;
  recurrence_count: number;
  awareness_layer: number;
  created_at_epoch: number;
}

/**
 * Living document structure maintained by the Crystallizer
 */
export interface LivingDocument {
  /** Project this document describes */
  project: string;
  /** When the document was last updated */
  lastUpdated: number;
  /** Total observations analyzed */
  observationsAnalyzed: number;
  /** Crystallized insights - things we're confident about */
  decidedConcepts: CrystallizedConcept[];
  /** Fluid insights - things still evolving */
  fluidConcepts: CrystallizedConcept[];
  /** Evolution timeline - major changes in understanding */
  evolutionTimeline: EvolutionEvent[];
  /** Current focus areas */
  currentFocus: string[];
  /** Markdown summary for human reading */
  markdownSummary: string;
}

interface CrystallizedConcept {
  /** Concept name/title */
  name: string;
  /** Brief description */
  description: string;
  /** Supporting evidence (observation IDs) */
  evidence: number[];
  /** Confidence level (0-1) */
  confidence: number;
  /** When this was crystallized */
  crystallizedAt: number;
  /** Related concepts */
  relatedConcepts: string[];
}

interface EvolutionEvent {
  /** When this change occurred */
  timestamp: number;
  /** What changed */
  change: string;
  /** From what understanding */
  from: string | null;
  /** To what understanding */
  to: string;
}

export class CrystallizerAgent {
  private dbManager: DatabaseManager;
  private lastCrystallizationTime: Map<string, number> = new Map();
  private lastObservationCount: Map<string, number> = new Map();
  private apiKey: string | undefined;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
    this.apiKey = process.env.ANTHROPIC_API_KEY;
  }

  /**
   * Trigger crystallization for a project (fire-and-forget)
   * Called periodically or after significant observation accumulation
   */
  async crystallize(
    project: string,
    worker?: WorkerRef
  ): Promise<LivingDocument | null> {
    // Check cooldown
    const lastCrystallization = this.lastCrystallizationTime.get(project) || 0;
    if (Date.now() - lastCrystallization < CRYSTALLIZATION_COOLDOWN_MS) {
      logger.debug('CRYSTALLIZER', 'Skipping crystallization - cooldown active', {
        project,
        cooldownRemaining: CRYSTALLIZATION_COOLDOWN_MS - (Date.now() - lastCrystallization)
      });
      return null;
    }

    try {
      // Fetch patterns (observations with type='pattern' from NoticerAgent)
      const patterns = await this.fetchPatterns(project);

      // Check minimum patterns threshold
      if (patterns.length < MIN_PATTERNS_FOR_CRYSTALLIZATION) {
        logger.debug('CRYSTALLIZER', 'Insufficient patterns for crystallization', {
          project,
          count: patterns.length,
          required: MIN_PATTERNS_FOR_CRYSTALLIZATION
        });
        return null;
      }

      // Check if enough new observations since last run
      const currentObsCount = await this.getObservationCount(project);
      const lastCount = this.lastObservationCount.get(project) || 0;
      if (currentObsCount - lastCount < MIN_NEW_OBSERVATIONS && lastCount > 0) {
        logger.debug('CRYSTALLIZER', 'Insufficient new observations', {
          project,
          newCount: currentObsCount - lastCount,
          required: MIN_NEW_OBSERVATIONS
        });
        return null;
      }

      // Fetch recent observations for context
      const recentObservations = await this.fetchRecentObservations(project);

      // Load existing living document if any
      const existingDocument = await this.loadLivingDocument(project);

      // Update tracking
      this.lastCrystallizationTime.set(project, Date.now());
      this.lastObservationCount.set(project, currentObsCount);

      logger.info('CRYSTALLIZER', 'Starting crystallization', {
        project,
        patternCount: patterns.length,
        recentObsCount: recentObservations.length,
        hasExistingDoc: !!existingDocument
      });

      // Run crystallization
      const document = await this.analyzePatternsForCrystallization({
        project,
        patterns,
        recentObservations,
        existingDocument
      });

      if (document) {
        // Store the living document
        await this.storeLivingDocument(project, document);

        // Promote crystallized observations to Layer 3
        await this.promotecrystallizedObservations(
          patterns.map(p => p.id),
          document
        );

        logger.success('CRYSTALLIZER', 'Crystallization complete', {
          project,
          decidedCount: document.decidedConcepts.length,
          fluidCount: document.fluidConcepts.length
        });

        return document;
      }

      return null;
    } catch (error) {
      // Fire-and-forget: log error but don't throw
      logger.error('CRYSTALLIZER', 'Crystallization failed', { project }, error as Error);
      return null;
    }
  }

  /**
   * Fetch patterns for a project (observations with type='pattern')
   */
  private async fetchPatterns(project: string): Promise<PatternRecord[]> {
    const sessionStore = this.dbManager.getSessionStore();
    return sessionStore.getPatternObservationsForProject(project, PATTERN_WINDOW);
  }

  /**
   * Fetch recent observations for context
   */
  private async fetchRecentObservations(project: string): Promise<ObservationRecord[]> {
    const sessionStore = this.dbManager.getSessionStore();
    return sessionStore.getRecentObservationsForProject(project, 30);
  }

  /**
   * Get total observation count for project
   */
  private async getObservationCount(project: string): Promise<number> {
    const sessionStore = this.dbManager.getSessionStore();
    return sessionStore.getObservationCountForProject(project);
  }

  /**
   * Load existing living document for project
   */
  private async loadLivingDocument(project: string): Promise<LivingDocument | null> {
    const sessionStore = this.dbManager.getSessionStore();
    return sessionStore.getLivingDocument(project);
  }

  /**
   * Store living document for project
   */
  private async storeLivingDocument(project: string, document: LivingDocument): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();
    sessionStore.storeLivingDocument(project, document);
  }

  /**
   * Analyze patterns and create/update living document using Haiku
   */
  private async analyzePatternsForCrystallization(
    context: CrystallizationContext
  ): Promise<LivingDocument | null> {
    if (!this.apiKey) {
      logger.warn('CRYSTALLIZER', 'ANTHROPIC_API_KEY not set, skipping crystallization');
      return null;
    }

    const prompt = this.buildCrystallizationPrompt(context);

    // Call Anthropic API directly using fetch
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CRYSTALLIZER_MODEL,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    // Extract text content
    const textContent = data.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    // Parse living document from response
    return this.parseCrystallizationResponse(textContent, context);
  }

  /**
   * Build prompt for crystallization
   */
  private buildCrystallizationPrompt(context: CrystallizationContext): string {
    const patternSummaries = context.patterns.map((p, i) => {
      const signals = p.relevance_signals ? JSON.parse(p.relevance_signals) : [];
      return `  ${i + 1}. [${p.type}] ${p.title || '(untitled)'}
    Recurrence: ${p.recurrence_count}x | Signals: ${signals.join(', ') || 'none'}
    ${p.narrative ? `    Narrative: ${p.narrative.substring(0, 200)}...` : ''}`;
    }).join('\n');

    const existingDocSummary = context.existingDocument
      ? `\nExisting Understanding:
- Decided Concepts: ${context.existingDocument.decidedConcepts.map(c => c.name).join(', ') || 'none'}
- Fluid Concepts: ${context.existingDocument.fluidConcepts.map(c => c.name).join(', ') || 'none'}
- Last Updated: ${new Date(context.existingDocument.lastUpdated).toISOString()}`
      : '\nNo existing living document - this is the first crystallization.';

    return `You are a knowledge crystallization agent analyzing patterns in Claude Code sessions.

Project: ${context.project}
${existingDocSummary}

Detected Patterns (${context.patterns.length} total):
${patternSummaries}

Your task: Crystallize these patterns into a living document that distinguishes:

1. **Decided Concepts**: Things we're confident about based on recurring patterns
   - Must have recurrence_count >= 3 OR strong evidence from multiple patterns
   - Should be actionable for future sessions
   - Examples: "User prefers explicit error handling", "Project uses TypeScript strictly"

2. **Fluid Concepts**: Things still evolving or uncertain
   - Patterns observed but not yet confirmed
   - May need more evidence before promotion
   - Examples: "User might prefer functional style", "Testing approach unclear"

3. **Evolution Timeline**: Track how understanding has changed
   - What concepts moved from fluid to decided?
   - What new patterns emerged?
   - What previous assumptions were revised?

Output your analysis in this JSON format:

\`\`\`json
{
  "decidedConcepts": [
    {
      "name": "Concept Name",
      "description": "Brief description of the crystallized insight",
      "confidence": 0.9,
      "relatedConcepts": ["related1", "related2"]
    }
  ],
  "fluidConcepts": [
    {
      "name": "Concept Name",
      "description": "What we're noticing but not yet confident about",
      "confidence": 0.5,
      "relatedConcepts": []
    }
  ],
  "evolutionEvents": [
    {
      "change": "What changed in understanding",
      "from": "Previous understanding (null if new)",
      "to": "New understanding"
    }
  ],
  "currentFocus": ["area1", "area2"],
  "markdownSummary": "# Living Document: project-name\\n\\n## Decided Concepts\\n...\\n## Fluid Concepts\\n...\\n## Evolution\\n..."
}
\`\`\`

Be concise but complete. Focus on insights that will help future Claude sessions work more effectively with this user on this project.`;
  }

  /**
   * Parse crystallization response into LivingDocument
   */
  private parseCrystallizationResponse(
    response: string,
    context: CrystallizationContext
  ): LivingDocument | null {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
      if (!jsonMatch) {
        logger.warn('CRYSTALLIZER', 'No JSON found in crystallization response');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[1]) as {
        decidedConcepts: Array<{
          name: string;
          description: string;
          confidence: number;
          relatedConcepts: string[];
        }>;
        fluidConcepts: Array<{
          name: string;
          description: string;
          confidence: number;
          relatedConcepts: string[];
        }>;
        evolutionEvents: Array<{
          change: string;
          from: string | null;
          to: string;
        }>;
        currentFocus: string[];
        markdownSummary: string;
      };

      const now = Date.now();

      // Build decided concepts with evidence
      const decidedConcepts: CrystallizedConcept[] = parsed.decidedConcepts.map(c => ({
        name: c.name,
        description: c.description,
        evidence: [], // Would need pattern-to-concept mapping
        confidence: c.confidence,
        crystallizedAt: now,
        relatedConcepts: c.relatedConcepts
      }));

      // Build fluid concepts
      const fluidConcepts: CrystallizedConcept[] = parsed.fluidConcepts.map(c => ({
        name: c.name,
        description: c.description,
        evidence: [],
        confidence: c.confidence,
        crystallizedAt: now,
        relatedConcepts: c.relatedConcepts
      }));

      // Build evolution timeline
      const evolutionTimeline: EvolutionEvent[] = parsed.evolutionEvents.map(e => ({
        timestamp: now,
        change: e.change,
        from: e.from,
        to: e.to
      }));

      // Merge with existing evolution timeline if any
      if (context.existingDocument?.evolutionTimeline) {
        evolutionTimeline.unshift(...context.existingDocument.evolutionTimeline);
      }

      return {
        project: context.project,
        lastUpdated: now,
        observationsAnalyzed: context.patterns.length + context.recentObservations.length,
        decidedConcepts,
        fluidConcepts,
        evolutionTimeline,
        currentFocus: parsed.currentFocus,
        markdownSummary: parsed.markdownSummary
      };
    } catch (error) {
      logger.error('CRYSTALLIZER', 'Failed to parse crystallization response', {
        project: context.project
      }, error as Error);
      return null;
    }
  }

  /**
   * Promote crystallized observations from Layer 2 to Layer 3
   */
  private async promotecrystallizedObservations(
    patternIds: number[],
    document: LivingDocument
  ): Promise<void> {
    // Only promote patterns that contributed to decided concepts
    // For now, promote all patterns that were analyzed (they're crystallized)
    const sessionStore = this.dbManager.getSessionStore();

    for (const id of patternIds) {
      sessionStore.promoteObservationLayer(id, 3, Date.now());
    }

    logger.info('CRYSTALLIZER', 'Promoted observations to Layer 3', {
      count: patternIds.length
    });
  }
}
