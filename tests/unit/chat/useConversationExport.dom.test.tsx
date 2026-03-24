import React from 'react';
import { act, fireEvent, render, screen, waitFor, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationExport } from '@/renderer/hooks/file/useConversationExport';

const mockConversationGet = vi.fn();
const mockMessagesGet = vi.fn();
const mockWriteFile = vi.fn();
const mockCopyText = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      get: { invoke: (...args: unknown[]) => mockConversationGet(...args) },
    },
    database: {
      getConversationMessages: { invoke: (...args: unknown[]) => mockMessagesGet(...args) },
    },
    fs: {
      writeFile: { invoke: (...args: unknown[]) => mockWriteFile(...args) },
    },
    application: {
      getPath: { invoke: vi.fn().mockResolvedValue('/Desktop') },
    },
  },
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({
  copyText: (...args: unknown[]) => mockCopyText(...args),
}));

const t = (key: string, options?: Record<string, unknown>) => {
  if (key === 'messages.export.saveSuccess') {
    return `saved:${options?.path ?? ''}`;
  }
  if (key === 'messages.export.conversationLabel') return 'Conversation';
  if (key === 'messages.export.conversationIdLabel') return 'Conversation ID';
  if (key === 'messages.export.exportedAtLabel') return 'Exported At';
  if (key === 'messages.export.typeLabel') return 'Type';
  if (key === 'messages.export.noMessages') return 'No messages';
  if (key === 'messages.export.userLabel') return 'Visitor';
  if (key === 'messages.export.assistantLabel') return 'Responder';
  if (key === 'messages.export.systemLabel') return 'System';
  if (key === 'messages.copy') {
    return 'Copy';
  }
  if (key === 'common.copySuccess') {
    return 'Copied';
  }
  if (key === 'common.copyFailed') {
    return 'Copy failed';
  }
  return key;
};

describe('useConversationExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversationGet.mockResolvedValue({
      id: 'conv-1',
      name: 'Current chat',
      type: 'gemini',
    });
    mockMessagesGet.mockResolvedValue([
      {
        id: 'msg-1',
        conversation_id: 'conv-1',
        type: 'text',
        position: 'right',
        content: { content: 'hello export' },
      },
    ]);
    mockWriteFile.mockResolvedValue(true);
    mockCopyText.mockResolvedValue(undefined);
  });

  it('shows a copy-path action in the save success message', async () => {
    const success = vi.fn();
    const error = vi.fn();

    const { result } = renderHook(() =>
      useConversationExport({
        conversationId: 'conv-1',
        workspace: '/workspace',
        t,
        messageApi: { success, error },
      })
    );

    await act(async () => {
      await result.current.openExportFlow();
    });

    expect(result.current.filename).toMatch(/^\d{4}-\d{2}-\d{2}-conv-1-hello-export\.txt$/);

    await act(async () => {
      result.current.onSelectMenuItem('save');
    });

    await act(async () => {
      await result.current.submitFilename();
    });

    expect(mockWriteFile).toHaveBeenCalledWith({
      path: expect.stringMatching(/^\/workspace\/.+\.txt$/),
      data: expect.stringContaining('Visitor:\nhello export'),
    });

    const successPayload = success.mock.calls[0]?.[0];
    expect(successPayload).toMatchObject({ duration: 5000 });

    if (!successPayload || typeof successPayload !== 'object' || !('content' in successPayload)) {
      throw new Error('Expected save success message payload with content');
    }

    render(<>{successPayload.content}</>);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(mockCopyText).toHaveBeenCalledWith(expect.stringMatching(/^\/workspace\/.+\.txt$/));
    });

    expect(success).toHaveBeenLastCalledWith('Copied');
    expect(error).not.toHaveBeenCalled();
  });

  it('reports unavailable export when no conversation id exists', async () => {
    const success = vi.fn();
    const error = vi.fn();

    const { result } = renderHook(() =>
      useConversationExport({
        workspace: '/workspace',
        t,
        messageApi: { success, error },
      })
    );

    await act(async () => {
      await result.current.openExportFlow();
    });

    expect(error).toHaveBeenCalledWith('messages.export.unavailable');
    expect(success).not.toHaveBeenCalled();
  });

  it('reports prepare failure when conversation loading throws', async () => {
    mockConversationGet.mockRejectedValueOnce(new Error('boom'));
    const error = vi.fn();

    const { result } = renderHook(() =>
      useConversationExport({
        conversationId: 'conv-1',
        workspace: '/workspace',
        t,
        messageApi: { success: vi.fn(), error },
      })
    );

    await act(async () => {
      await result.current.openExportFlow();
    });

    expect(error).toHaveBeenCalledWith('messages.export.prepareFailed');
  });
});
