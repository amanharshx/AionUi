import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import type { IConversationRepository } from '@/process/services/database/IConversationRepository';
import type { IConversationService } from '@/process/services/IConversationService';

const {
  mockAcpConnect,
  mockAcpCancelPrompt,
  mockAcpDisconnect,
  mockAcpNewSession,
  mockAcpSendPrompt,
  mockAcpSetPromptTimeout,
  mockCreateRotatingClient,
  mockProcessConfigGet,
} = vi.hoisted(() => ({
  mockAcpConnect: vi.fn(),
  mockAcpCancelPrompt: vi.fn(),
  mockAcpDisconnect: vi.fn(),
  mockAcpNewSession: vi.fn(),
  mockAcpSendPrompt: vi.fn(),
  mockAcpSetPromptTimeout: vi.fn(),
  mockCreateRotatingClient: vi.fn(),
  mockProcessConfigGet: vi.fn(),
}));

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

vi.mock('@process/agent/acp/AcpConnection', () => ({
  AcpConnection: class {
    onSessionUpdate: (data: any) => void = () => {};
    onPermissionRequest: (data: any) => Promise<{ optionId: string }> = () => Promise.resolve({ optionId: 'reject_once' });
    onEndTurn: () => void = () => {};
    onDisconnect: (error: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};

    connect = (...args: unknown[]) => mockAcpConnect(...args);
    newSession = (...args: unknown[]) => mockAcpNewSession(...args);
    sendPrompt = (...args: unknown[]) => mockAcpSendPrompt(this, ...args);
    disconnect = (...args: unknown[]) => mockAcpDisconnect(...args);
    setPromptTimeout = (...args: unknown[]) => mockAcpSetPromptTimeout(...args);
    cancelPrompt = (...args: unknown[]) => mockAcpCancelPrompt(...args);
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
    mockAcpConnect.mockResolvedValue(undefined);
    mockAcpCancelPrompt.mockReset();
    mockAcpNewSession.mockResolvedValue({ sessionId: 'fork-1' });
    mockAcpSendPrompt.mockImplementation(async (connection: {
      onEndTurn: () => void;
      onSessionUpdate: (data: any) => void;
    }) => {
      connection.onSessionUpdate({
        sessionId: 'fork-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'The file was `config/aion.json`.',
          },
        },
      });
      connection.onEndTurn();
      return {};
    });
    mockAcpDisconnect.mockResolvedValue(undefined);
    mockAcpSetPromptTimeout.mockReturnValue(undefined);
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
      extra: { backend: 'opencode' },
      createTime: Date.now(),
      modifyTime: Date.now(),
    } as TChatConversation;
    const service = new ConversationSideQuestionService(makeService(conversation), makeRepo());

    await expect(service.ask('conv-1', 'what model are we using?')).resolves.toEqual({
      status: 'unsupported',
    });
  });

  it('returns unsupported for non-claude ACP conversations even with session metadata', async () => {
    const conversation = {
      id: 'conv-1',
      type: 'acp',
      name: 'ACP Conversation',
      extra: {
        acpSessionId: 'parent-session-1',
        backend: 'opencode',
        workspace: '/tmp/ws',
      },
      createTime: Date.now(),
      modifyTime: Date.now(),
    } as TChatConversation;
    const service = new ConversationSideQuestionService(makeService(conversation), makeRepo());

    await expect(service.ask('conv-1', 'what file did we use?')).resolves.toEqual({
      status: 'unsupported',
    });
    expect(mockAcpConnect).not.toHaveBeenCalled();
  });

  it('uses an ACP forked session when ACP session metadata is available', async () => {
    const conversation = {
      id: 'conv-1',
      type: 'acp',
      name: 'ACP Conversation',
      extra: {
        acpSessionId: 'parent-session-1',
        backend: 'claude',
        workspace: '/tmp/ws',
      },
      createTime: Date.now(),
      modifyTime: Date.now(),
    } as TChatConversation;
    const service = new ConversationSideQuestionService(makeService(conversation), makeRepo());

    mockProcessConfigGet.mockImplementation(async (key: string) => {
      if (key === 'model.config') {
        return [];
      }
      if (key === 'acp.config') {
        return {
          claude: {
            cliPath: 'claude',
          },
        };
      }
      return undefined;
    });

    await expect(service.ask('conv-1', 'what file did we use?')).resolves.toEqual({
      status: 'ok',
      answer: 'The file was `config/aion.json`.',
    });

    expect(mockAcpConnect).toHaveBeenCalledWith('claude', 'claude', '/tmp/ws', undefined, undefined);
    expect(mockAcpNewSession).toHaveBeenCalledWith('/tmp/ws', {
      forkSession: true,
      mcpServers: [],
      resumeSessionId: 'parent-session-1',
    });
  });

  it('returns unsupported when the ACP backend rejects forked sessions', async () => {
    const conversation = {
      id: 'conv-1',
      type: 'acp',
      name: 'ACP Conversation',
      extra: {
        acpSessionId: 'parent-session-1',
        backend: 'claude',
        workspace: '/tmp/ws',
      },
      createTime: Date.now(),
      modifyTime: Date.now(),
    } as TChatConversation;
    const service = new ConversationSideQuestionService(makeService(conversation), makeRepo());

    mockProcessConfigGet.mockImplementation(async (key: string) => {
      if (key === 'model.config') {
        return [];
      }
      if (key === 'acp.config') {
        return {
          claude: {
            cliPath: 'claude',
          },
        };
      }
      return undefined;
    });
    mockAcpNewSession.mockRejectedValueOnce(new Error('fork not supported'));

    await expect(service.ask('conv-1', 'what file did we use?')).resolves.toEqual({
      status: 'unsupported',
    });
  });

  it('rejects when the ACP side question times out', async () => {
    vi.useFakeTimers();
    const conversation = {
      id: 'conv-1',
      type: 'acp',
      name: 'ACP Conversation',
      extra: {
        acpSessionId: 'parent-session-1',
        backend: 'claude',
        workspace: '/tmp/ws',
      },
      createTime: Date.now(),
      modifyTime: Date.now(),
    } as TChatConversation;
    const service = new ConversationSideQuestionService(makeService(conversation), makeRepo());

    mockProcessConfigGet.mockImplementation(async (key: string) => {
      if (key === 'model.config') {
        return [];
      }
      if (key === 'acp.config') {
        return {
          claude: {
            cliPath: 'claude',
          },
        };
      }
      return undefined;
    });
    mockAcpSendPrompt.mockImplementationOnce(() => new Promise(() => {}));

    const promise = service.ask('conv-1', 'what file did we use?');
    const expectation = expect(promise).rejects.toThrow('ACP /btw timed out.');
    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
    expect(mockAcpDisconnect).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('rejects when the ACP side question triggers a permission request', async () => {
    const conversation = {
      id: 'conv-1',
      type: 'acp',
      name: 'ACP Conversation',
      extra: {
        acpSessionId: 'parent-session-1',
        backend: 'claude',
        workspace: '/tmp/ws',
      },
      createTime: Date.now(),
      modifyTime: Date.now(),
    } as TChatConversation;
    const service = new ConversationSideQuestionService(makeService(conversation), makeRepo());

    mockProcessConfigGet.mockImplementation(async (key: string) => {
      if (key === 'model.config') {
        return [];
      }
      if (key === 'acp.config') {
        return {
          claude: {
            cliPath: 'claude',
          },
        };
      }
      return undefined;
    });
    mockAcpSendPrompt.mockImplementationOnce(async (connection: {
      onPermissionRequest: (data: any) => Promise<{ optionId: string }>;
    }) => {
      await connection.onPermissionRequest({
        options: [{ kind: 'reject_once', name: 'Reject', optionId: 'reject_once' }],
        sessionId: 'fork-1',
        toolCall: {
          title: 'Bash',
          toolCallId: 'tool-1',
        },
      });
      return {};
    });

    await expect(service.ask('conv-1', 'what file did we use?')).rejects.toThrow(
      'ACP /btw requires permission and cannot continue.'
    );
    expect(mockAcpCancelPrompt).toHaveBeenCalled();
  });

  it('rejects when the ACP side question attempts a tool call', async () => {
    const conversation = {
      id: 'conv-1',
      type: 'acp',
      name: 'ACP Conversation',
      extra: {
        acpSessionId: 'parent-session-1',
        backend: 'claude',
        workspace: '/tmp/ws',
      },
      createTime: Date.now(),
      modifyTime: Date.now(),
    } as TChatConversation;
    const service = new ConversationSideQuestionService(makeService(conversation), makeRepo());

    mockProcessConfigGet.mockImplementation(async (key: string) => {
      if (key === 'model.config') {
        return [];
      }
      if (key === 'acp.config') {
        return {
          claude: {
            cliPath: 'claude',
          },
        };
      }
      return undefined;
    });
    mockAcpSendPrompt.mockImplementationOnce(async (connection: {
      onSessionUpdate: (data: any) => void;
    }) => {
      connection.onSessionUpdate({
        sessionId: 'fork-1',
        update: {
          kind: 'execute',
          sessionUpdate: 'tool_call',
          status: 'pending',
          title: 'Bash',
          toolCallId: 'tool-1',
        },
      });
      return {};
    });

    await expect(service.ask('conv-1', 'what file did we use?')).rejects.toThrow(
      'ACP /btw attempted to use tools.'
    );
    expect(mockAcpCancelPrompt).toHaveBeenCalled();
  });

  it('returns unsupported for provider-backed conversations outside Claude Code', async () => {
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
      status: 'unsupported',
    });
    expect(mockCreateRotatingClient).not.toHaveBeenCalled();
  });
});
