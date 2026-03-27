import { ipcBridge } from '@/common';
import { Message } from '@arco-design/web-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type BtwCommandState = {
  answer: string;
  isLoading: boolean;
  isOpen: boolean;
  question: string;
};

const INITIAL_STATE: BtwCommandState = {
  answer: '',
  isLoading: false,
  isOpen: false,
  question: '',
};

export function useBtwCommand(conversationId?: string) {
  const { t } = useTranslation();
  const requestIdRef = useRef(0);
  const [state, setState] = useState<BtwCommandState>(INITIAL_STATE);

  const dismiss = useCallback(() => {
    requestIdRef.current += 1;
    setState(INITIAL_STATE);
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const requestId = ++requestIdRef.current;
      Message.info(t('conversation.sideQuestion.started'));
      setState({
        answer: '',
        isLoading: true,
        isOpen: true,
        question,
      });

      if (!conversationId) {
        Message.warning(t('conversation.sideQuestion.unsupported'));
        setState({
          answer: t('conversation.sideQuestion.unsupported'),
          isLoading: false,
          isOpen: true,
          question,
        });
        return;
      }

      try {
        const response = await ipcBridge.conversation.askSideQuestion.invoke({
          conversation_id: conversationId,
          question,
        });

        if (requestId !== requestIdRef.current) {
          return;
        }

        if (!response.success || !response.data) {
          Message.error(t('conversation.sideQuestion.error'));
          setState({
            answer: t('conversation.sideQuestion.error'),
            isLoading: false,
            isOpen: true,
            question,
          });
          return;
        }

        switch (response.data.status) {
          case 'ok':
            Message.success(t('conversation.sideQuestion.answered'));
            setState({
              answer: response.data.answer,
              isLoading: false,
              isOpen: true,
              question,
            });
            return;
          case 'unsupported':
            Message.warning(t('conversation.sideQuestion.unsupported'));
            setState({
              answer: t('conversation.sideQuestion.unsupported'),
              isLoading: false,
              isOpen: true,
              question,
            });
            return;
          case 'invalid':
            Message.warning(t('conversation.sideQuestion.emptyQuestion'));
            setState({
              answer: t('conversation.sideQuestion.emptyQuestion'),
              isLoading: false,
              isOpen: true,
              question,
            });
            return;
        }
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        Message.error(t('conversation.sideQuestion.error'));
        setState({
          answer: t('conversation.sideQuestion.error'),
          isLoading: false,
          isOpen: true,
          question,
        });
      }
    },
    [conversationId, t]
  );

  return {
    ask,
    dismiss,
    ...state,
  };
}
