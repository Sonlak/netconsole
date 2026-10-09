/**
 * Persistence helpers for the assistant.
 *
 * The conversation itself lives in the frontend (re-sent each turn
 * for simplicity), but the backend keeps an authoritative audit
 * trail: every message + every usage record. This module is the
 * only place that writes to the AssistantSession / AssistantMessage
 * / AssistantUsageLog tables — keeps schema knowledge in one spot.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { AssistantModel, UsageInfo } from './llmClient.js';
import type { AssistantMessage, AssistantToolName, ToolContext } from './types.js';

/**
 * Find an existing session by id, scoped to the user. Returns null
 * if the session does not exist OR belongs to a different user. We
 * always scope by userId so a user can't continue someone else's
 * session by guessing a UUID.
 */
export async function loadSession(
  sessionId: string,
  userId: string | null,
): Promise<{ id: string; userId: string | null; model: string } | null> {
  if (!sessionId) return null;
  const row = await prisma.assistantSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, model: true },
  });
  if (!row) return null;
  if (row.userId && userId && row.userId !== userId) return null;
  return row;
}

/**
 * Create a new session. The first user message is persisted as the
 * opening row so the Sessions page can list conversations by
 * `updatedAt` without scanning the messages table.
 */
export async function createSession(
  userId: string | null,
  username: string | null,
  model: AssistantModel,
  firstUserMessage: string,
): Promise<{ id: string; title: string }> {
  const title = deriveTitle(firstUserMessage);
  const session = await prisma.assistantSession.create({
    data: {
      userId: userId ?? null,
      model,
      title,
    },
    select: { id: true },
  });

  await prisma.assistantMessage.create({
    data: {
      sessionId: session.id,
      role: 'user',
      content: firstUserMessage,
      metadata: { username },
    },
  });

  return { id: session.id, title };
}

/** Append a message to an existing session. */
export async function appendMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'tool' | 'system',
  fields: {
    content?: string | null;
    toolCalls?: unknown;
    toolCallId?: string | null;
    toolName?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  return prisma.assistantMessage.create({
    data: {
      sessionId,
      role,
      content: fields.content ?? null,
      toolCalls: (fields.toolCalls as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      toolCallId: fields.toolCallId ?? null,
      toolName: fields.toolName ?? null,
      metadata: (fields.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
    },
  });
}

/** Record a single LLM call's usage. Append-only. */
export async function recordUsage(
  ctx: Pick<ToolContext, 'sessionId' | 'userId' | 'username'>,
  usage: UsageInfo,
  reason: 'turn' | 'continuation' | 'confirmation',
) {
  return prisma.assistantUsageLog.create({
    data: {
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      username: ctx.username,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costMicrodollars: usage.costMicrodollars,
      latencyMs: usage.latencyMs,
      model: usage.model,
      reason,
    },
  });
}

/**
 * Aggregate usage for a user (for the dashboard).
 * Returns the totals for the last `days` days.
 */
export async function usageSummary(userId: string, days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.assistantUsageLog.groupBy({
    by: ['model'],
    where: { userId, createdAt: { gte: since } },
    _sum: {
      inputTokens: true,
      cachedInputTokens: true,
      outputTokens: true,
      totalTokens: true,
      costMicrodollars: true,
    },
    _count: { _all: true },
  });
  return rows.map((row) => ({
    model: row.model,
    calls: row._count._all,
    inputTokens: row._sum.inputTokens ?? 0,
    cachedInputTokens: row._sum.cachedInputTokens ?? 0,
    outputTokens: row._sum.outputTokens ?? 0,
    costUsd: (row._sum.costMicrodollars ?? 0) / 1_000_000,
  }));
}

// ── helpers ──────────────────────────────────────────────────────────────────

const TITLE_MAX = 60;

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '(empty)';
  return trimmed.length <= TITLE_MAX ? trimmed : `${trimmed.slice(0, TITLE_MAX - 1)}…`;
}

/** Convert raw OpenAI ChatCompletionMessageParam into our shape. */
export function toAssistantMessage(m: AssistantMessage): {
  content?: string | null;
  toolCalls?: unknown;
  toolCallId?: string | null;
  toolName?: string | null;
} {
  // 'tool' role carries tool_call_id + (optionally) name
  if (m.role === 'tool') {
    return {
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      toolCallId: m.tool_call_id,
      toolName: null,
    };
  }
  // 'assistant' role may carry tool_calls
  if (m.role === 'assistant') {
    const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : undefined;
    return {
      content: typeof m.content === 'string' ? m.content : null,
      toolCalls: tcs ?? null,
    };
  }
  return { content: typeof m.content === 'string' ? m.content : null };
}
