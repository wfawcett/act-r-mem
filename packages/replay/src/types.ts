// Replay scenario types (E03, PRD §15.2). Zod schemas parse the YAML scenario
// files; unknown action/expectation keys are rejected so typo'd scenarios fail
// loudly instead of silently dropping a step.
import { z } from 'zod';
import { ParamSchema } from '../../../apps/service/src/config.js';
import type { Params, HalfLifeClass } from '../../../packages/activation/src/types.js';

// --- RememberInput.structured (PRD §8.1, structured only — no LLM judge) -----

export const StructuredSchema = z.object({
  entities: z
    .array(z.object({ label: z.string().min(1), aliases: z.array(z.string()).optional() }))
    .default([]),
  facts: z
    .array(
      z.object({
        subject: z.string().min(1),
        statement: z.string().min(1),
        half_life_class: z.enum(['identity', 'default', 'incidental']).optional(),
      }),
    )
    .default([]),
  episode: z
    .object({ label: z.string().min(1), summary: z.string().min(1) })
    .optional(),
  edges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        predicate: z.string().min(1),
        half_life_class: z.enum(['identity', 'default', 'incidental']).optional(),
      }),
    )
    .default([]),
});

export type Structured = z.infer<typeof StructuredSchema>;

// Replay `remember` steps are structured-only: `text` exists on the real tool
// input but here it is just a scenario comment; the graph is built from
// `structured`.
export const RememberInputSchema = z.object({
  text: z.string().min(1),
  occurred_at: z.string().optional(),
  session_id: z.string().optional(),
  client: z.enum(['claude-code', 'hermes', 'omp', 'manual']).optional(),
  structured: StructuredSchema.optional(),
});

export type RememberInput = z.infer<typeof RememberInputSchema>;

// --- Scenario graph ----------------------------------------------------------

export const KindSchema = z.enum(['entity', 'fact', 'episode']);
export type Kind = z.infer<typeof KindSchema>;

export const ScenarioNodeSchema = z.object({
  key: z.string().min(1),
  kind: KindSchema,
  label: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  accesses: z.array(z.number().nonnegative()).default([]),
  created: z.number().nonnegative(),
});
export type ScenarioNode = z.infer<typeof ScenarioNodeSchema>;

export const ScenarioEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  predicate: z.string().min(1),
  half_life_class: z.enum(['identity', 'default', 'incidental']).optional(),
  strength: z.number().nonnegative().default(1),
  lastUsed: z.number().nonnegative(),
});
export type ScenarioEdge = z.infer<typeof ScenarioEdgeSchema>;

// --- Expectations (PRD §15.3) ------------------------------------------------

export const NodeExpectSchema = z.object({
  key: z.string().min(1),
  dormant: z.boolean().optional(),
  active: z.boolean().optional(),
  B_gt: z.number().optional(),
  B_lt: z.number().optional(),
});

export const EdgeExpectSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  strength_gt: z.number().optional(),
  strength_lt: z.number().optional(),
});

export const ExpectationsSchema = z
  .object({
    associative_includes: z.array(z.string().min(1)).optional(),
    associative_excludes: z.array(z.string().min(1)).optional(),
    associative_top: z.array(z.string().min(1)).optional(),
    exposure_includes: z.array(z.string().min(1)).optional(),
    direct_is: z.array(z.string().min(1)).optional(),
    none_of: z.array(z.string().min(1)).optional(),
    node: z.array(NodeExpectSchema).optional(),
    edge: z.array(EdgeExpectSchema).optional(),
  })
  .strict();
export type Expectations = z.infer<typeof ExpectationsSchema>;

// --- Steps --------------------------------------------------------------------

export const RecallActionSchema = z
  .object({
    cues: z.array(z.string().min(1)).optional(),
    query: z.string().optional(),
    similar: z.record(z.string(), z.number()).optional(),
    session_id: z.string().optional(),
    client: z.enum(['claude-code', 'hermes', 'omp', 'manual']).optional(),
  })
  .refine(
    (r) => (r.cues !== undefined && r.cues.length > 0) || (r.query !== undefined && r.query.length > 0),
    { message: 'recall step needs cues or query' },
  );

export const StepSchema = z
  .object({
    at: z.number().nonnegative(),
    recall: RecallActionSchema.optional(),
    use: z.array(z.string().min(1)).optional(),
    remember: RememberInputSchema.optional(),
    advance: z.number().nonnegative().optional(),
    expect: ExpectationsSchema.optional(),
  })
  .strict();

export type ScenarioStep = z.infer<typeof StepSchema>;

// --- Scenario -------------------------------------------------------------------

export const ScenarioSchema = z.object({
  name: z.string().min(1),
  params: ParamSchema.partial().optional(),
  // Optional named fixture hook (SC-15 scale seed); resolved by the runner.
  setup: z.string().min(1).optional(),
  nodes: z.array(ScenarioNodeSchema).min(1),
  edges: z.array(ScenarioEdgeSchema).default([]),
  steps: z.array(StepSchema).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

// Re-exports so downstream modules (store/runner/expect) can import everything
// they need from this file.
export type { Params, HalfLifeClass };
export { ParamSchema };
