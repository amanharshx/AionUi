import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWarning = vi.fn();
const mockAsk = vi.fn();
const mockDismiss = vi.fn();
const mockBtwOverlay = vi.fn(() => React.createElement('div', {}, 'BtwOverlay'));

const mockUseConversationContextSafe = vi.fn(() => ({ conversationId: 'conv-1' }));
const mockUseLayoutContext = vi.fn(() => ({ isMobile: false }));
const mockUsePreviewContext = vi.fn(() => ({
  setSendBoxHandler: vi.fn(),
  domSnippets: [],
  removeDomSnippet: vi.fn(),
  clearDomSnippets: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      warmup: { invoke: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => mockUseConversationContextSafe(),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => mockUseLayoutContext(),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => mockUsePreviewContext(),
}));

vi.mock('@/renderer/hooks/chat/useInputFocusRing', () => ({
  useInputFocusRing: () => ({
    activeBorderColor: '#000',
    inactiveBorderColor: '#ccc',
    activeShadow: '0 0 0 2px rgba(0,0,0,0.1)',
  }),
}));

vi.mock('@/renderer/hooks/chat/useCompositionInput', () => ({
  useCompositionInput: () => ({
    compositionHandlers: {},
    createKeyDownHandler: (onEnterPress: () => void, onKeyDownIntercept?: (e: React.KeyboardEvent) => boolean) => {
      return (event: React.KeyboardEvent) => {
        if (onKeyDownIntercept?.(event)) {
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          onEnterPress();
        }
      };
    },
  }),
}));

vi.mock('@/renderer/hooks/file/useDragUpload', () => ({
  useDragUpload: () => ({
    isFileDragging: false,
    dragHandlers: {},
  }),
}));

vi.mock('@/renderer/hooks/file/usePasteService', () => ({
  usePasteService: () => ({
    onPaste: vi.fn(),
    onFocus: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/ui/useLatestRef', () => ({
  useLatestRef: (value: unknown) => ({ current: value }),
}));

vi.mock('@renderer/services/FileService', () => ({
  allSupportedExts: [],
}));

vi.mock('@renderer/hooks/file/useUploadState', () => ({
  useUploadState: () => ({ isUploading: false }),
}));

vi.mock('@renderer/components/media/UploadProgressBar', () => ({
  __esModule: true,
  default: () => React.createElement('div', {}, 'UploadProgressBar'),
}));

vi.mock('@/renderer/components/chat/SlashCommandMenu', () => ({
  __esModule: true,
  default: () => React.createElement('div', {}, 'SlashCommandMenu'),
}));

vi.mock('@/renderer/components/chat/BtwOverlay', () => ({
  __esModule: true,
  default: (props: unknown) => mockBtwOverlay(props),
}));

vi.mock('@/renderer/components/chat/BtwOverlay/useBtwCommand', () => ({
  useBtwCommand: () => ({
    ask: mockAsk,
    dismiss: mockDismiss,
    answer: '',
    isLoading: false,
    isOpen: false,
    question: '',
  }),
}));

vi.mock('@/renderer/hooks/chat/useSlashCommandController', () => ({
  useSlashCommandController: () => ({
    isOpen: false,
    filteredCommands: [],
    activeIndex: 0,
    setActiveIndex: vi.fn(),
    onSelectByIndex: vi.fn(),
    onKeyDown: vi.fn(() => false),
  }),
}));

vi.mock('@/renderer/utils/ui/focus', () => ({
  blurActiveElement: vi.fn(),
  shouldBlockMobileInputFocus: vi.fn(() => false),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({ onClick, children, icon, ...props }: React.ComponentProps<'button'>) =>
    React.createElement('button', { onClick, ...props }, icon ?? children),
  Input: {
    TextArea: ({ onKeyDown, onChange, value, ...props }: React.ComponentProps<'textarea'> & { value?: string }) =>
      React.createElement('textarea', {
        onKeyDown,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(event.target.value),
        value,
        ...props,
      }),
  },
  Message: {
    useMessage: () => [{ warning: mockWarning }, null],
  },
  Tag: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
}));

vi.mock('@icon-park/react', () => ({
  ArrowUp: () => React.createElement('span', {}, 'ArrowUp'),
  CloseSmall: () => React.createElement('span', {}, 'CloseSmall'),
}));

import SendBox from '@/renderer/components/chat/sendbox';

describe('SendBox /btw handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePreviewContext.mockReturnValue({
      setSendBoxHandler: vi.fn(),
      domSnippets: [],
      removeDomSnippet: vi.fn(),
      clearDomSnippets: vi.fn(),
    });
  });

  it('routes /btw through side-question flow even while loading', () => {
    const onChange = vi.fn();
    const onSend = vi.fn();

    const { container } = render(
      <SendBox value='/btw what file did we use?' onChange={onChange} onSend={onSend} loading />
    );

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();

    fireEvent.keyDown(textarea!, { key: 'Enter' });

    expect(mockAsk).toHaveBeenCalledWith('what file did we use?');
    expect(onSend).not.toHaveBeenCalled();
    expect(mockWarning).not.toHaveBeenCalledWith('messages.conversationInProgress');
  });

  it('blocks /btw when attachments are pending', () => {
    const { container } = render(
      <SendBox value='/btw what file did we use?' onChange={vi.fn()} onSend={vi.fn()} hasPendingAttachments />
    );

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();

    fireEvent.keyDown(textarea!, { key: 'Enter' });

    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockWarning).toHaveBeenCalledWith('conversation.sideQuestion.attachmentsNotAllowed');
  });

  it('passes parent task running state to the btw overlay', () => {
    const { rerender } = render(
      <SendBox value='/btw what file did we use?' onChange={vi.fn()} onSend={vi.fn()} loading />
    );

    expect(mockBtwOverlay).toHaveBeenCalled();
    expect(mockBtwOverlay.mock.calls.at(-1)?.[0]).toMatchObject({
      parentTaskRunning: true,
    });

    rerender(<SendBox value='/btw what file did we use?' onChange={vi.fn()} onSend={vi.fn()} loading={false} />);

    expect(mockBtwOverlay.mock.calls.at(-1)?.[0]).toMatchObject({
      parentTaskRunning: false,
    });
  });
});
