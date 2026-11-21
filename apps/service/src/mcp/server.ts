// E09 MCP server factory (§8). One McpServer (name `recall`) per session; the
// five tools are registered with the exact §8 description strings and the zod
// schemas from tools.ts. ToolValidationError messages go back to the model
// verbatim (§8.6); any other throw is logged with the request id and answered
// with "Memory is unavailable right now" so the client session continues.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RememberInputSchema, type RememberInput } from '../ingest/enqueue.js';
import {
  ForgetToolSchema,
  GetMemoryToolSchema,
  MarkUsedToolSchema,
  RecallToolSchema,
  ToolValidationError,
  forgetTool,
  getMemoryTool,
  logError,
  markUsedTool,
  recallTool,
  rememberTool,
  type McpToolDeps,
  type RecallToolInput,
} from './tools.js';

const SERVER_NAME = 'recall';
const SERVER_VERSION = '0.1.0';

const UNAVAILABLE = 'Memory is unavailable right now';

// §8.1 client enum; an unknown transport client name must not 400 a valid
// `remember`, so it falls back to the argument (or 'manual' downstream).
const CLIENT_ENUM = ['claude-code', 'hermes', 'omp', 'manual'] as const;

// §8 tool descriptions — the exact strings from PRD §8.1–8.5.
const DESCRIPTIONS = {
  remember:
    'Save something worth remembering about the user or their work. Returns immediately; processing happens in the background.',
  recall:
    "Recall memories related to the current conversation. Pass the user's message or a short description of what you need. Call mark_used with the ids you actually rely on.",
  mark_used:
    'Tell memory which recalled ids you actually used in your answer. This strengthens them.',
  get_memory: 'Get one memory by id, with its connections.',
  forget: 'Forget a memory the user asked you to forget. Use only when the user asks.',
} as const;

interface ToolResult {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(result: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

function errorResult(requestId: string, err: unknown): ToolResult {
  if (err instanceof ToolValidationError) {
    // §8.6: short, model-actionable message returned verbatim.
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
  logError(requestId, err);
  return { content: [{ type: 'text', text: UNAVAILABLE }], isError: true };
}

/**
 * When the transport carries a client name (initialize request clientInfo.name),
 * it wins over the argument (§8 preamble). For `remember` the name must be one
 * of the §8.1 enum values; anything else falls back to the argument.
 */
function withClientOverride(input: Record<string, unknown>, clientName?: string): Record<string, unknown> {
  if (clientName === undefined || input.client === clientName) return input;
  return { ...input, client: clientName };
}

export function createMcpServer(deps: McpToolDeps, requestId: string, clientName?: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'remember',
    {
      description: DESCRIPTIONS.remember,
      inputSchema: RememberInputSchema.shape,
    },
    async (args) => {
      try {
        const input = (
          clientName !== undefined && (CLIENT_ENUM as readonly string[]).includes(clientName)
            ? withClientOverride(args, clientName)
            : args
        ) as RememberInput;
        return ok(await rememberTool(deps, input));
      } catch (err) {
        return errorResult(requestId, err);
      }
    },
  );

  server.registerTool(
    'recall',
    {
      description: DESCRIPTIONS.recall,
      inputSchema: RecallToolSchema.shape,
    },
    async (args) => {
      try {
        const input = withClientOverride(args, clientName) as unknown as RecallToolInput;
        return ok(await recallTool(deps, input));
      } catch (err) {
        return errorResult(requestId, err);
      }
    },
  );

  server.registerTool(
    'mark_used',
    {
      description: DESCRIPTIONS.mark_used,
      inputSchema: MarkUsedToolSchema.shape,
    },
    async (args) => {
      try {
        return ok(await markUsedTool(deps, args as { trace_id?: number; ids: number[] }));
      } catch (err) {
        return errorResult(requestId, err);
      }
    },
  );

  server.registerTool(
    'get_memory',
    {
      description: DESCRIPTIONS.get_memory,
      inputSchema: GetMemoryToolSchema.shape,
    },
    async (args) => {
      try {
        return ok(await getMemoryTool(deps, args));
      } catch (err) {
        return errorResult(requestId, err);
      }
    },
  );

  server.registerTool(
    'forget',
    {
      description: DESCRIPTIONS.forget,
      inputSchema: ForgetToolSchema.shape,
    },
    async (args) => {
      try {
        return ok(await forgetTool(deps, args as { id: number; reason?: string }));
      } catch (err) {
        return errorResult(requestId, err);
      }
    },
  );

  return server;
}
