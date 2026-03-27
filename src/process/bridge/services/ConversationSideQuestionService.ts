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
import type {
  AcpBackend,
  AcpPermissionRequest,
  AcpSessionUpdate,
} from '@/common/types/acpTypes';
import type { IConversationRepository } from '@process/services/database/IConversationRepository';
import { AcpConnection } from '@process/agent/acp/AcpConnection';
import type { IConversationService } from '@process/services/IConversationService';
import { ProcessConfig } from '@process/utils/initStorage';
import { ACP_BACKENDS_ALL } from '@/common/types/acpTypes';

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
const ACP_SIDE_QUESTION_TIMEOUT_MS = 30_000;
const ACP_SIDE_QUESTION_PROMPT_TIMEOUT_SECONDS = 30;

type ResolvedProvider = {
  provider: TProviderWithModel;
  proxy?: string;
};

type ResolvedAcpContext = {
  acpSessionId: string;
  backend: AcpBackend;
  cliPath?: string;
  customEnv?: Record<string, string>;
  customArgs?: string[];
  workspace: string;
};

class AcpSideQuestionUnsupportedError extends Error {}
class AcpSideQuestionFailedError extends Error {}

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
    if (resolvedProvider) {
      return await this.askWithProvider(conversationId, trimmedQuestion, resolvedProvider);
    }

    const resolvedAcpContext = await this.resolveAcpSideQuestionContext(conversation);
    if (resolvedAcpContext) {
      try {
        const answer = await this.askWithAcpFork(conversationId, trimmedQuestion, resolvedAcpContext);
        return {
          status: 'ok',
          answer: answer || 'The conversation context does not contain a clear answer.',
        };
      } catch (error) {
        if (error instanceof AcpSideQuestionUnsupportedError) {
          return { status: 'unsupported' };
        }
        throw error;
      }
    }

    console.info('[ConversationSideQuestionService] No supported /btw execution path available', {
      conversationId,
      conversationType: conversation.type,
    });
    return { status: 'unsupported' };
  }

  private async askWithProvider(
    conversationId: string,
    trimmedQuestion: string,
    resolvedProvider: ResolvedProvider
  ): Promise<ConversationSideQuestionResult> {
    const messagesResult = await this.repo.getMessages(conversationId, 0, MAX_MESSAGE_COUNT, 'ASC');
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
      transport: 'provider',
    });
    return {
      status: 'ok',
      answer: answer || 'The conversation context does not contain a clear answer.',
    };
  }

  private async askWithAcpFork(
    conversationId: string,
    question: string,
    context: ResolvedAcpContext
  ): Promise<string> {
    console.info('[ConversationSideQuestionService] Starting ACP /btw fork', {
      backend: context.backend,
      conversationId,
      hasCliPath: Boolean(context.cliPath),
      workspace: context.workspace,
    });

    const connection = new AcpConnection();
    connection.setPromptTimeout(ACP_SIDE_QUESTION_PROMPT_TIMEOUT_SECONDS);

    const completion = this.createAcpCompletionPromise(connection, conversationId, context.backend);

    try {
      await this.runWithTimeout(
        (async () => {
          await connection.connect(
            context.backend,
            context.cliPath,
            context.workspace,
            context.customArgs,
            context.customEnv
          );

          try {
            const response = await connection.newSession(context.workspace, {
              resumeSessionId: context.acpSessionId,
              forkSession: true,
              mcpServers: [],
            });
            console.info('[ConversationSideQuestionService] ACP /btw fork session created', {
              backend: context.backend,
              conversationId,
              forkedSessionId: response.sessionId,
              parentSessionId: context.acpSessionId,
            });
          } catch (error) {
            console.info('[ConversationSideQuestionService] ACP /btw fork unsupported', {
              backend: context.backend,
              conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
            throw new AcpSideQuestionUnsupportedError('ACP forked side questions are not supported for this backend.');
          }

          await Promise.all([
            completion.promise,
            connection.sendPrompt(this.buildAcpSideQuestionPrompt(question)),
          ]);
        })(),
        ACP_SIDE_QUESTION_TIMEOUT_MS
      );

      const answer = completion.getAnswer();
      console.info('[ConversationSideQuestionService] ACP /btw answer generated', {
        answerLength: answer.length,
        backend: context.backend,
        conversationId,
        transport: 'acp',
      });
      return answer;
    } finally {
      completion.dispose();
      await connection.disconnect().catch((error: unknown) => {
        console.warn('[ConversationSideQuestionService] Failed to disconnect ACP /btw runner', {
          backend: context.backend,
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
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

  private async resolveAcpSideQuestionContext(conversation: TChatConversation): Promise<ResolvedAcpContext | null> {
    if (conversation.type !== 'acp') {
      return null;
    }

    const extra = conversation.extra;
    if (!extra?.backend || !extra.acpSessionId || !extra.workspace) {
      return null;
    }

    if (extra.backend === 'custom') {
      if (!extra.customAgentId) {
        return null;
      }
      const customAgents = (await ProcessConfig.get('acp.customAgents')) || [];
      const customAgent = customAgents.find((agent) => agent.id === extra.customAgentId);
      if (!customAgent?.defaultCliPath?.trim()) {
        return null;
      }
      return {
        acpSessionId: extra.acpSessionId,
        backend: extra.backend,
        cliPath: extra.cliPath || customAgent.defaultCliPath.trim(),
        customArgs: customAgent.acpArgs,
        customEnv: customAgent.env,
        workspace: extra.workspace,
      };
    }

    const acpConfig = await ProcessConfig.get('acp.config');
    const backendConfig = ACP_BACKENDS_ALL[extra.backend];
    const cliPath = extra.cliPath || acpConfig?.[extra.backend]?.cliPath || backendConfig?.cliCommand;
    if (!cliPath?.trim()) {
      return null;
    }

    return {
      acpSessionId: extra.acpSessionId,
      backend: extra.backend,
      cliPath: cliPath.trim(),
      customArgs: backendConfig?.acpArgs,
      workspace: extra.workspace,
    };
  }

  private buildAcpSideQuestionPrompt(question: string): string {
    return [
      'Answer this brief side question using the current session context.',
      'Do not use tools.',
      'Do not ask follow-up questions.',
      'Return one concise answer only.',
      '',
      `Side question: ${question}`,
    ].join('\n');
  }

  private createAcpCompletionPromise(connection: AcpConnection, conversationId: string, backend: AcpBackend): {
    dispose: () => void;
    getAnswer: () => string;
    promise: Promise<void>;
  } {
    let settled = false;
    let answer = '';

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });

    const previousSessionUpdate = connection.onSessionUpdate;
    const previousPermissionRequest = connection.onPermissionRequest;
    const previousEndTurn = connection.onEndTurn;
    const previousDisconnect = connection.onDisconnect;

    connection.onSessionUpdate = (data: AcpSessionUpdate) => {
      previousSessionUpdate(data);
      if (data.update.sessionUpdate === 'agent_message_chunk' && data.update.content.type === 'text') {
        answer += data.update.content.text || '';
        return;
      }
      if (data.update.sessionUpdate === 'tool_call' || data.update.sessionUpdate === 'tool_call_update') {
        console.warn('[ConversationSideQuestionService] ACP /btw rejected tool activity', {
          backend,
          conversationId,
          update: data.update.sessionUpdate,
        });
        connection.cancelPrompt();
        fail(new AcpSideQuestionFailedError('ACP /btw attempted to use tools.'));
      }
    };

    connection.onPermissionRequest = async (data: AcpPermissionRequest) => {
      console.warn('[ConversationSideQuestionService] ACP /btw rejected permission request', {
        backend,
        conversationId,
        tool: data.toolCall.title,
      });
      connection.cancelPrompt();
      fail(new AcpSideQuestionFailedError('ACP /btw requires permission and cannot continue.'));
      return {
        optionId: data.options.find((option) => option.kind.startsWith('reject'))?.optionId || 'reject_once',
      };
    };

    connection.onEndTurn = () => {
      previousEndTurn();
      succeed();
    };

    connection.onDisconnect = (error) => {
      previousDisconnect(error);
      fail(
        new AcpSideQuestionFailedError(
          `ACP /btw runner disconnected unexpectedly (${error.code ?? 'unknown'}:${error.signal ?? 'none'}).`
        )
      );
    };

    return {
      dispose: () => {
        connection.onSessionUpdate = previousSessionUpdate;
        connection.onPermissionRequest = previousPermissionRequest;
        connection.onEndTurn = previousEndTurn;
        connection.onDisconnect = previousDisconnect;
      },
      getAnswer: () => answer.trim(),
      promise,
    };
  }

  private async runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new AcpSideQuestionFailedError('ACP /btw timed out.'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
