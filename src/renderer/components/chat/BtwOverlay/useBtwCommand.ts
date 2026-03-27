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
    console.info('[useBtwCommand] Dismissing /btw state');
    requestIdRef.current += 1;
    setState(INITIAL_STATE);
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const requestId = ++requestIdRef.current;
      console.info('[useBtwCommand] Starting /btw request', {
        conversationId,
        questionLength: question.length,
      });
      Message.info(t('conversation.sideQuestion.started'));
      setState({
        answer: '',
        isLoading: true,
        isOpen: true,
        question,
      });

      if (!conversationId) {
        console.info('[useBtwCommand] /btw unsupported: missing conversation id');
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
          console.info('[useBtwCommand] Ignoring stale /btw response', {
            conversationId,
            requestId,
            activeRequestId: requestIdRef.current,
          });
          return;
        }

        console.info('[useBtwCommand] Received /btw IPC response', {
          conversationId,
          success: response.success,
          status: response.data?.status,
        });

        if (!response.success || !response.data) {
          console.error('[useBtwCommand] /btw failed', {
            conversationId,
            error: response.msg || 'unknown error',
          });
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
            console.info('[useBtwCommand] /btw answered', {
              conversationId,
              answerLength: response.data.answer.length,
            });
            Message.success(t('conversation.sideQuestion.answered'));
            setState({
              answer: response.data.answer,
              isLoading: false,
              isOpen: true,
              question,
            });
            return;
          case 'unsupported':
            console.info('[useBtwCommand] /btw unsupported', {
              conversationId,
            });
            Message.warning(t('conversation.sideQuestion.unsupported'));
            setState({
              answer: t('conversation.sideQuestion.unsupported'),
              isLoading: false,
              isOpen: true,
              question,
            });
            return;
          case 'invalid':
            console.info('[useBtwCommand] /btw invalid', {
              conversationId,
              reason: response.data.reason,
            });
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
        console.error('[useBtwCommand] Failed to ask side question:', error);
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
