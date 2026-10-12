#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentMemoryGateway, gatewayConfigFromEnvironment } from './gateway.js';
import { MemoryStore } from './store.js';

const contextSchema = z.object({
  request_id: z.string(),
  project_id: z.string(),
  evidence_ref: z.string(),
  retention_intent: z.string(),
  idempotency_key: z.string(),
}).strict();

const artifactSchema = z.record(z.string(), z.unknown());
const writeFields = {
  context: contextSchema,
  title: z.string(),
  tags: z.string(),
  summary: z.string(),
  type: z.enum(['work', 'observation']),
  artifacts: z.array(artifactSchema).optional(),
  event_date: z.string().optional(),
  forget_after: z.string().optional(),
};

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

async function main() {
  const config = gatewayConfigFromEnvironment();
  const store = new MemoryStore(undefined, {
    skipBackfill: true,
    source: `gateway:${config.runtimeId}:${config.clientId}`,
  });
  const gateway = new AgentMemoryGateway(store, config);
  const server = new McpServer({ name: 'memory-gateway', version: '1.0.0' });

  server.tool('memory_search', 'Read-only memory search through the restricted gateway.', {
    query: z.string(),
    type: z.enum(['work', 'observation']).optional(),
    limit: z.number().int().min(1).max(15).optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
  }, async args => text(await gateway.search(args)));

  server.tool('memory_list_recent', 'Read-only recent memory list through the restricted gateway.', {
    count: z.number().int().min(1).max(20).optional(),
    type: z.enum(['work', 'observation']).optional(),
  }, async args => text(gateway.listRecent(args)));

  server.tool('memory_write', 'Store a new durable memory with mandatory provenance and idempotency.', writeFields,
    async args => text(await gateway.write(args)));

  server.tool('memory_update', 'Create an update version of an existing memory with mandatory provenance and idempotency.', {
    ...writeFields,
    parent_id: z.number().int().positive(),
  }, async args => text(await gateway.update(args)));

  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error('[memory-gateway] Fatal:', error);
  process.exit(1);
});
