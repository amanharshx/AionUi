/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientFactory } from '@/common/api/ClientFactory';
import type { OpenAIChatCompletionParams } from '@/common/api/OpenAI2AnthropicConverter';
import type { ConversationSideQuestionResult } from '@/common/adapter/ipcBridge';
import type { TMessage } from '@/common/chat/chatLib';
import type { TChatConversation, TProviderWithModel } from '@/common/config/storage';
import type { IConversationRepository } from '@process/services/database/IConversationRepository';
import type { IConversationService } from '@process/services/IConversationService';
import { ProcessConfig } from '@process/utils/initStorage';

const SIDE_QUESTION_SYSTEM_PROMPT =
  'You are answering a brief side question about an ongoing conversation. ' +
  'Answer only from the conversation context provided below. ' +
  'Do not attempt to use tools. If the answer is unclear from context, say so briefly. ' +
  'Keep your answer concise.';

const DEFAULT_CONTEXT_LIMIT = 32_000;
const RESERVED_TOKENS = 1_024;
const MAX_MESSAGE_COUNT = 1_000;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_SERIALIZED_MESSAGE_CHARS = 2_000;

type ResolvedProvider = {
  provider: TProviderWithModel;
  proxy?: string;
};

function hasProviderBackedModel(
  conversation: TChatConversation
): conversation is TChatConversation & { model: TProviderWithModel } {
  return 'model' in conversation && Boolean(conversation.model?.id && conversation.model?.useModel);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function truncateText(text: string, maxChars = MAX_SERIALIZED_MESSAGE_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function stringifyData(data: unknown): string {
  if (typeof data === 'string') {
    return truncateText(data.trim());
  }
  try {
    return truncateText(JSON.stringify(data));
  } catch {
    return '[unserializable]';
  }
}

function serializeTextMessage(message: Extract<TMessage, { type: 'text' }>): string | null {
  const content = message.content.content.trim();
  if (!content) {
    return null;
  }
  const speaker = message.position === 'right' ? 'User' : 'Assistant';
  return `${speaker}: ${truncateText(content)}`;
}

function serializeMessage(message: TMessage): string | null {
  switch (message.type) {
    case 'text':
      return serializeTextMessage(message);
    case 'tips':
      return `System note: ${truncateText(message.content.content)}`;
    case 'tool_call':
      return `Tool call ${message.content.name}: ${stringifyData(message.content.args)}${message.content.error ? ` | error: ${truncateText(message.content.error)}` : ''}`;
    case 'tool_group':
      return message.content
        .map((tool) => {
          const base = `${tool.name} [${tool.status}]`;
          const result =
            typeof tool.resultDisplay === 'string'
              ? truncateText(tool.resultDisplay)
              : stringifyData(tool.resultDisplay);
          return `${base}: ${truncateText(tool.description)}${result ? ` | ${result}` : ''}`;
        })
        .join('\n');
    case 'agent_status':
      return `Agent status: ${message.content.backend} -> ${message.content.status}`;
    case 'acp_permission':
    case 'codex_permission':
      return `Permission request: ${stringifyData(message.content)}`;
    case 'acp_tool_call':
    case 'codex_tool_call':
      return `Tool update: ${stringifyData(message.content)}`;
    case 'plan':
      return `Plan update: ${stringifyData(message.content.entries)}`;
    case 'available_commands':
      return null;
    default:
      return null;
  }
}

function buildTranscript(messages: TMessage[], contextLimit?: number): string {
  const maxContextTokens = Math.min(contextLimit || DEFAULT_CONTEXT_LIMIT, DEFAULT_CONTEXT_LIMIT);
  const transcriptBudget = Math.max(2_048, maxContextTokens - RESERVED_TOKENS);
  const lines: string[] = [];
  let usedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const serialized = serializeMessage(messages[index]);
    if (!serialized) {
      continue;
    }
    const line = `[${new Date(messages[index].createdAt || Date.now()).toISOString()}] ${serialized}`;
    const estimated = estimateTokens(line);
    if (usedTokens + estimated > transcriptBudget) {
      break;
    }
    lines.unshift(line);
    usedTokens += estimated;
  }

  return lines.join('\n');
}

function extractAnswerText(response: { choices?: Array<{ message?: { content?: unknown } }> }): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part: unknown) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
    return text;
  }
  return '';
}

export class ConversationSideQuestionService {
  constructor(
    private readonly conversationService: IConversationService,
    private readonly repo: IConversationRepository
  ) {}

  async ask(conversationId: string, question: string): Promise<ConversationSideQuestionResult> {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      console.info('[ConversationSideQuestionService] Rejected empty /btw question', {
        conversationId,
      });
      return { status: 'invalid', reason: 'emptyQuestion' };
    }

    const conversation = await this.conversationService.getConversation(conversationId);
    if (!conversation) {
      console.info('[ConversationSideQuestionService] Conversation not found for /btw', {
        conversationId,
      });
      return { status: 'unsupported' };
    }

    const resolvedProvider = await this.resolveProviderForSideQuestion(conversation);
    if (!resolvedProvider) {
      console.info('[ConversationSideQuestionService] No provider-backed model available for /btw', {
        conversationId,
        conversationType: conversation.type,
      });
      return { status: 'unsupported' };
    }

    const messagesResult = await this.repo.getMessages(conversation.id, 0, MAX_MESSAGE_COUNT, 'ASC');
    const transcript = buildTranscript(messagesResult.data, resolvedProvider.provider.contextLimit);
    const prompt = `Conversation transcript:\n${transcript || '[no persisted transcript available]'}\n\nSide question: ${trimmedQuestion}`;

    const client = await ClientFactory.createRotatingClient(resolvedProvider.provider, {
      proxy: resolvedProvider.proxy,
      rotatingOptions: { maxRetries: 2, retryDelay: 500 },
    });
    console.info('[ConversationSideQuestionService] Resolved provider for /btw', {
      conversationId,
      platform: resolvedProvider.provider.platform,
      providerId: resolvedProvider.provider.id,
      model: resolvedProvider.provider.useModel,
      transcriptChars: transcript.length,
      transcriptMessages: messagesResult.data.length,
    });

    const request: OpenAIChatCompletionParams = {
      model: resolvedProvider.provider.useModel,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: 'system', content: SIDE_QUESTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    };

    const completionClient = client as {
      createChatCompletion: (params: OpenAIChatCompletionParams) => Promise<{
        choices?: Array<{ message?: { content?: unknown } }>;
      }>;
    };
    const completion = await completionClient.createChatCompletion(request);

    const answer = extractAnswerText(completion);
    console.info('[ConversationSideQuestionService] /btw answer generated', {
      conversationId,
      answerLength: answer.length,
    });
    return {
      status: 'ok',
      answer: answer || 'The conversation context does not contain a clear answer.',
    };
  }

  private async resolveProviderForSideQuestion(conversation: TChatConversation): Promise<ResolvedProvider | null> {
    if (!hasProviderBackedModel(conversation)) {
      return null;
    }

    const providers = (await ProcessConfig.get('model.config')) || [];
    const savedProvider = providers.find((provider) => provider.id === conversation.model.id);
    if (!savedProvider || savedProvider.enabled === false) {
      return null;
    }
    if (!savedProvider.apiKey?.trim()) {
      return null;
    }
    if (savedProvider.modelEnabled?.[conversation.model.useModel] === false) {
      return null;
    }
    if (!savedProvider.model.includes(conversation.model.useModel)) {
      return null;
    }

    const provider: TProviderWithModel = {
      ...savedProvider,
      useModel: conversation.model.useModel,
    };

    const proxy = provider.platform === 'gemini' ? (await ProcessConfig.get('gemini.config'))?.proxy : undefined;

    return { provider, proxy };
  }
}
