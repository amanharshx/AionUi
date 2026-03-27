import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import type { IConversationRepository } from '@/process/services/database/IConversationRepository';
import type { IConversationService } from '@/process/services/IConversationService';

const mockCreateRotatingClient = vi.fn();
const mockProcessConfigGet = vi.fn();

vi.mock('@/common/api/ClientFactory', () => ({
  ClientFactory: {
    createRotatingClient: (...args: unknown[]) => mockCreateRotatingClient(...args),
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: (...args: unknown[]) => mockProcessConfigGet(...args),
  },
}));

import { ConversationSideQuestionService } from '@/process/bridge/services/ConversationSideQuestionService';

function makeConversation(overrides: Partial<TChatConversation> = {}): TChatConversation {
  return {
    id: 'conv-1',
    name: 'Conversation',
    type: 'gemini',
    extra: { workspace: '/tmp/ws' },
    model: {
      id: 'provider-1',
      platform: 'gemini',
      name: 'Gemini',
      baseUrl: 'https://example.com',
      apiKey: 'secret',
      useModel: 'gemini-2.5-flash',
    },
    createTime: Date.now(),
    modifyTime: Date.now(),
    ...overrides,
  } as TChatConversation;
}

function makeService(conversation: TChatConversation | undefined): IConversationService {
  return {
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    updateConversation: vi.fn(),
    getConversation: vi.fn(async () => conversation),
    createWithMigration: vi.fn(),
    listAllConversations: vi.fn(async () => []),
  };
}

function makeRepo(messages: unknown[] = []): IConversationRepository {
  return {
    getConversation: vi.fn(async () => undefined),
    createConversation: vi.fn(async () => {}),
    updateConversation: vi.fn(async () => {}),
    deleteConversation: vi.fn(async () => {}),
    getMessages: vi.fn(async () => ({ data: messages as any, total: messages.length, hasMore: false })),
    insertMessage: vi.fn(async () => {}),
    getUserConversations: vi.fn(async () => ({ data: [], total: 0, hasMore: false })),
    listAllConversations: vi.fn(async () => []),
    searchMessages: vi.fn(async () => ({ data: [], total: 0, hasMore: false })),
  };
}

describe('ConversationSideQuestionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns invalid for an empty question', async () => {
    const service = new ConversationSideQuestionService(makeService(undefined), makeRepo());

    await expect(service.ask('conv-1', '   ')).resolves.toEqual({
      status: 'invalid',
      reason: 'emptyQuestion',
    });
  });

  it('returns unsupported when the conversation has no provider-backed model', async () => {
    const conversation = {
      id: 'conv-1',
      type: 'acp',
      name: 'ACP Conversation',
      extra: { backend: 'claude' },
      createTime: Date.now(),
      modifyTime: Date.now(),
    } as TChatConversation;
    const service = new ConversationSideQuestionService(makeService(conversation), makeRepo());

    await expect(service.ask('conv-1', 'what model are we using?')).resolves.toEqual({
      status: 'unsupported',
    });
  });

  it('uses a saved provider config and returns the generated answer', async () => {
    const conversation = makeConversation();
    const service = new ConversationSideQuestionService(
      makeService(conversation),
      makeRepo([
        {
          id: 'msg-1',
          type: 'text',
          position: 'right',
          conversation_id: 'conv-1',
          content: { content: 'What config file were we using?' },
          createdAt: Date.now() - 1_000,
        },
        {
          id: 'msg-2',
          type: 'text',
          position: 'left',
          conversation_id: 'conv-1',
          content: { content: 'We were using config/aion.json.' },
          createdAt: Date.now(),
        },
      ])
    );

    mockProcessConfigGet.mockImplementation(async (key: string) => {
      if (key === 'model.config') {
        return [
          {
            id: 'provider-1',
            platform: 'gemini',
            name: 'Gemini',
            baseUrl: 'https://example.com',
            apiKey: 'secret',
            model: ['gemini-2.5-flash'],
          },
        ];
      }
      if (key === 'gemini.config') {
        return {};
      }
      return undefined;
    });
    mockCreateRotatingClient.mockResolvedValue({
      createChatCompletion: vi.fn(async () => ({
        choices: [
          {
            message: {
              content: 'You were using `config/aion.json`.',
            },
          },
        ],
      })),
    });

    await expect(service.ask('conv-1', 'what config file were we using?')).resolves.toEqual({
      status: 'ok',
      answer: 'You were using `config/aion.json`.',
    });
    expect(mockCreateRotatingClient).toHaveBeenCalledOnce();
  });
});
