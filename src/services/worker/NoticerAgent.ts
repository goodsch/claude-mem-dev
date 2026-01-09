/**
 * NoticerAgent: Background pattern detection agent
 *
 * Responsibility:
 * - Runs after observations are stored (async, non-blocking)
 * - Analyzes recent observations for patterns
 * - Detects: repeated behaviors, friction signals, preferences
 * - Stores pattern observations with awareness_layer: 1 (Raw)
 *
 * Design:
 * - Uses Haiku for cost efficiency (always-on background agent)
 * - Fire-and-forget: doesn't block primary conversation
 * - Processes in batches to reduce API calls
 */

import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import { parseObservations } from '../../sdk/parser.js';
import type { WorkerRef } from './agents/index.js';
import { broadcastObservation } from './agents/ObservationBroadcaster.js';
import type { ObservationRecord } from '../../types/database.js';

// Anthropic API endpoint
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Haiku model for cost-efficient background processing
const NOTICER_MODEL = 'claude-3-5-haiku-latest';

// Minimum observations needed before pattern detection
const MIN_OBSERVATIONS_FOR_ANALYSIS = 3;

// How many recent observations to analyze
const OBSERVATION_WINDOW = 20;

// Cooldown between pattern detection runs (ms)
const ANALYSIS_COOLDOWN_MS = 60000; // 1 minute

interface PatternContext {
  sessionDbId: number;
  memorySessionId: string;
  project: string;
  observations: ObservationRecord[];
}

export class NoticerAgent {
  private dbManager: DatabaseManager;
  private lastAnalysisTime: Map<string, number> = new Map();
  private apiKey: string | undefined;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
    // Use ANTHROPIC_API_KEY from environment
    this.apiKey = process.env.ANTHROPIC_API_KEY;
  }

  /**
   * Trigger pattern detection for a session (fire-and-forget)
   * Call this after SDKAgent stores observations
   */
  async detectPatterns(
    sessionDbId: number,
    memorySessionId: string,
    project: string,
    worker?: WorkerRef
  ): Promise<void> {
    // Check cooldown
    const lastAnalysis = this.lastAnalysisTime.get(memorySessionId) || 0;
    if (Date.now() - lastAnalysis < ANALYSIS_COOLDOWN_MS) {
      logger.debug('NOTICER', 'Skipping analysis - cooldown active', {
        sessionId: sessionDbId,
        cooldownRemaining: ANALYSIS_COOLDOWN_MS - (Date.now() - lastAnalysis)
      });
      return;
    }

    try {
      // Fetch recent observations for this session
      const observations = await this.fetchRecentObservations(memorySessionId);

      if (observations.length < MIN_OBSERVATIONS_FOR_ANALYSIS) {
        logger.debug('NOTICER', 'Insufficient observations for pattern detection', {
          sessionId: sessionDbId,
          count: observations.length,
          required: MIN_OBSERVATIONS_FOR_ANALYSIS
        });
        return;
      }

      // Update cooldown timestamp
      this.lastAnalysisTime.set(memorySessionId, Date.now());

      logger.info('NOTICER', 'Starting pattern detection', {
        sessionId: sessionDbId,
        observationCount: observations.length
      });

      // Run pattern detection
      const patterns = await this.analyzePatterns({
        sessionDbId,
        memorySessionId,
        project,
        observations
      });

      if (patterns.length > 0) {
        // Store pattern observations
        await this.storePatternObservations(
          sessionDbId,
          memorySessionId,
          project,
          patterns,
          worker
        );

        logger.success('NOTICER', 'Pattern detection complete', {
          sessionId: sessionDbId,
          patternsFound: patterns.length
        });
      } else {
        logger.debug('NOTICER', 'No patterns detected', { sessionId: sessionDbId });
      }
    } catch (error) {
      // Fire-and-forget: log error but don't throw
      logger.error('NOTICER', 'Pattern detection failed', { sessionId: sessionDbId }, error as Error);
    }
  }

  /**
   * Fetch recent observations for analysis
   */
  private async fetchRecentObservations(memorySessionId: string): Promise<ObservationRecord[]> {
    const sessionStore = this.dbManager.getSessionStore();

    // Query recent observations with full data for pattern analysis
    return sessionStore.getRecentObservationsForSession(memorySessionId, OBSERVATION_WINDOW);
  }

  /**
   * Analyze observations for patterns using Haiku
   */
  private async analyzePatterns(context: PatternContext): Promise<PatternObservation[]> {
    if (!this.apiKey) {
      logger.warn('NOTICER', 'ANTHROPIC_API_KEY not set, skipping pattern detection');
      return [];
    }

    const prompt = this.buildPatternPrompt(context);

    // Call Anthropic API directly using fetch
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: NOTICER_MODEL,
        max_tokens: 2048,
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

    // Parse pattern observations from response
    return this.parsePatternResponse(textContent);
  }

  /**
   * Build prompt for pattern detection
   */
  private buildPatternPrompt(context: PatternContext): string {
    const observationSummaries = context.observations.map((obs, i) => {
      // Parse facts from JSON string
      const factsArray: string[] = obs.facts ? JSON.parse(obs.facts) : [];
      const facts = factsArray.length > 0 ? `\n    Facts: ${factsArray.slice(0, 3).join('; ')}` : '';
      return `  ${i + 1}. [${obs.type}] ${obs.title}${facts}`;
    }).join('\n');

    return `You are a pattern detection agent analyzing recent Claude Code observations.

Project: ${context.project}

Recent Observations:
${observationSummaries}

Your task: Identify patterns in these observations that would be valuable for future context injection.

Look for:
1. **Repeated Behaviors**: Actions the user performs multiple times (same type of files, same operations)
2. **Friction Signals**: Errors, retries, or confusion patterns that suggest areas needing attention
3. **Preferences**: Consistent choices or styles that reveal user preferences
4. **Knowledge Gaps**: Areas where the user or assistant struggled

For each pattern found, output an observation in this XML format:

\`\`\`xml
<observation>
  <type>pattern</type>
  <title>[Pattern name - concise, action-oriented]</title>
  <subtitle>[What this pattern means for future sessions]</subtitle>
  <facts>
    <fact>[Evidence from observations supporting this pattern]</fact>
    <fact>[Additional evidence or frequency count]</fact>
  </facts>
  <narrative>[Why this pattern matters and how it should influence future behavior]</narrative>
  <concepts>
    <concept>pattern</concept>
    <concept>[relevant-category: behavior|friction|preference|knowledge]</concept>
  </concepts>
  <relevance_signals>
    <signal>[When this pattern should be surfaced - e.g., "working on TypeScript files"]</signal>
    <signal>[Additional context trigger]</signal>
  </relevance_signals>
</observation>
\`\`\`

Only output patterns that are:
- Supported by at least 2 observations
- Actionable for future sessions
- Not obvious or trivial

If no meaningful patterns are found, output nothing.

Output patterns now:`;
  }

  /**
   * Parse pattern observations from Haiku response
   */
  private parsePatternResponse(response: string): PatternObservation[] {
    // Use existing parser for observation structure
    const parsed = parseObservations(response);

    // Filter to only pattern-type observations and extract relevance signals
    return parsed
      .filter(obs => obs.type === 'pattern')
      .map(obs => {
        // Extract relevance_signals from response (custom parsing since not in standard schema)
        const signalsMatch = response.match(/<relevance_signals>([\s\S]*?)<\/relevance_signals>/);
        const signals: string[] = [];
        if (signalsMatch) {
          const signalMatches = signalsMatch[1].matchAll(/<signal>([\s\S]*?)<\/signal>/g);
          for (const match of signalMatches) {
            signals.push(match[1].trim());
          }
        }

        return {
          ...obs,
          relevance_signals: signals
        };
      });
  }

  /**
   * Store pattern observations with awareness metadata
   */
  private async storePatternObservations(
    sessionDbId: number,
    memorySessionId: string,
    project: string,
    patterns: PatternObservation[],
    worker?: WorkerRef
  ): Promise<void> {
    const sessionStore = this.dbManager.getSessionStore();

    for (const pattern of patterns) {
      // Store with awareness metadata (Layer 1 = Raw detection)
      // storeObservation signature: (memorySessionId, project, observation, promptNumber?, discoveryTokens?, overrideTimestamp?)
      sessionStore.storeObservation(
        memorySessionId,
        project,
        {
          type: pattern.type,
          title: pattern.title,
          subtitle: pattern.subtitle,
          facts: pattern.facts,
          narrative: pattern.narrative,
          concepts: pattern.concepts,
          files_read: [],
          files_modified: [],
          awareness: {
            awareness_layer: 1, // Raw - just detected
            relevance_signals: pattern.relevance_signals,
            recurrence_count: 1
          }
        },
        undefined, // promptNumber
        0 // discoveryTokens - 0 for pattern observations
      );

      // Broadcast to SSE clients
      if (worker?.sseBroadcaster) {
        broadcastObservation(worker.sseBroadcaster, {
          type: pattern.type,
          title: pattern.title || '',
          subtitle: pattern.subtitle || '',
          project,
          timestamp: new Date().toISOString()
        });
      }

      logger.info('NOTICER', 'Stored pattern observation', {
        title: pattern.title,
        signals: pattern.relevance_signals
      });
    }
  }
}

interface PatternObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  relevance_signals: string[];
}
