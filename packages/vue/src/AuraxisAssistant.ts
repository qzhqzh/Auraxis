import {
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  type PropType
} from 'vue'

type PageContext = Record<string, unknown>

type Conversation = {
  id: string
  pageTitle: string | null
  sourceUrl: string | null
  status: string
  createdAt: string
  updatedAt: string
}

type Message = {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt: string
}

type Identity = {
  displayName?: string
  externalUserId: string
}

const STYLE_ID = 'auraxis-assistant-style'
const styles = `
.auraxis-assistant {
  position: fixed;
  z-index: 2147483000;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #e7ecf3;
}
.auraxis-assistant--bottom-right { right: 24px; bottom: 24px; }
.auraxis-assistant--bottom-left { left: 24px; bottom: 24px; }
.auraxis-assistant__trigger {
  border: 0;
  border-radius: 999px;
  background: linear-gradient(135deg, #121826 0%, #1f2a44 100%);
  color: #f5f7fb;
  box-shadow: 0 16px 40px rgba(9, 14, 25, 0.28);
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  padding: 14px 18px;
}
.auraxis-assistant__panel {
  width: min(380px, calc(100vw - 24px));
  height: min(620px, calc(100vh - 96px));
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid rgba(134, 151, 190, 0.18);
  border-radius: 16px;
  background: linear-gradient(180deg, #08101a 0%, #101927 100%);
  box-shadow: 0 30px 90px rgba(6, 10, 20, 0.42);
  display: grid;
  grid-template-rows: auto auto 1fr auto;
}
.auraxis-assistant__header {
  padding: 18px 18px 10px;
  border-bottom: 1px solid rgba(134, 151, 190, 0.12);
}
.auraxis-assistant__title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.auraxis-assistant__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #9ca9c3;
}
.auraxis-assistant__status,
.auraxis-assistant__error {
  padding: 10px 18px;
  font-size: 12px;
}
.auraxis-assistant__status { color: #90a0c0; }
.auraxis-assistant__error {
  color: #ffb4b4;
  background: rgba(126, 34, 34, 0.18);
}
.auraxis-assistant__messages {
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.auraxis-assistant__empty {
  margin: auto 0;
  color: #8d99b2;
  font-size: 13px;
  line-height: 1.5;
}
.auraxis-assistant__bubble {
  max-width: 85%;
  padding: 10px 12px;
  border-radius: 12px;
  white-space: pre-wrap;
  line-height: 1.5;
  font-size: 13px;
}
.auraxis-assistant__bubble--user {
  align-self: flex-end;
  background: #e8eefb;
  color: #152033;
}
.auraxis-assistant__bubble--assistant,
.auraxis-assistant__bubble--system,
.auraxis-assistant__bubble--tool {
  align-self: flex-start;
  background: rgba(154, 173, 215, 0.12);
  color: #e7ecf3;
}
.auraxis-assistant__composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 18px 18px;
  border-top: 1px solid rgba(134, 151, 190, 0.12);
}
.auraxis-assistant__input {
  min-width: 0;
  border: 1px solid rgba(143, 160, 199, 0.18);
  border-radius: 12px;
  background: rgba(5, 12, 22, 0.72);
  color: #eef2f9;
  padding: 12px 14px;
  font-size: 13px;
  outline: none;
}
.auraxis-assistant__input::placeholder { color: #7f8da9; }
.auraxis-assistant__send {
  border: 0;
  border-radius: 12px;
  background: #d9e4fb;
  color: #172033;
  padding: 0 16px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.auraxis-assistant__send:disabled,
.auraxis-assistant__input:disabled,
.auraxis-assistant__trigger:disabled {
  opacity: 0.6;
  cursor: default;
}
@media (max-width: 640px) {
  .auraxis-assistant--bottom-right,
  .auraxis-assistant--bottom-left {
    left: 12px;
    right: 12px;
    bottom: 12px;
  }
  .auraxis-assistant__panel {
    width: auto;
    height: min(70vh, 560px);
  }
}
`

function ensureStyles() {
  if (typeof document === 'undefined') {
    return
  }

  if (document.getElementById(STYLE_ID)) {
    return
  }

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = styles
  document.head.appendChild(style)
}

async function parseJson<T>(response: Response) {
  const text = await response.text()
  return text ? (JSON.parse(text) as T) : ({} as T)
}

function getRuntimePageContext(pageContext: PageContext) {
  if (typeof window === 'undefined') {
    return pageContext
  }

  return {
    url: window.location.href,
    title: document.title,
    ...pageContext
  }
}

export const AuraxisAssistant = defineComponent({
  name: 'AuraxisAssistant',
  props: {
    appId: {
      type: String,
      required: true
    },
    getAuthToken: {
      type: Function as PropType<() => string | Promise<string>>,
      required: true
    },
    pageContext: {
      type: Object as PropType<PageContext>,
      default: () => ({})
    },
    apiBaseUrl: {
      type: String,
      default: ''
    },
    position: {
      type: String as PropType<'bottom-right' | 'bottom-left'>,
      default: 'bottom-right'
    }
  },
  setup(props) {
    ensureStyles()

    const isOpen = ref(false)
    const isBootstrapping = ref(false)
    const isSending = ref(false)
    const statusText = ref('')
    const errorText = ref('')
    const draft = ref('')
    const messages = ref<Message[]>([])
    const identity = shallowRef<Identity | null>(null)
    const conversations = ref<Conversation[]>([])
    const activeConversationId = ref<string | null>(null)
    const token = ref<string | null>(null)
    const composerRef = ref<HTMLInputElement | null>(null)

    function getHeaders() {
      return {
        authorization: `Bearer ${token.value}`,
        'content-type': 'application/json',
        'x-auraxis-app-id': props.appId
      }
    }

    async function request<T>(path: string, init?: RequestInit) {
      const response = await fetch(`${props.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          ...getHeaders(),
          ...(init?.headers ?? {})
        }
      })
      const payload = await parseJson<T & { error?: string; message?: string }>(response)

      if (!response.ok) {
        throw new Error((payload as { message?: string }).message || 'Auraxis request failed.')
      }

      return payload
    }

    async function loadMessages(conversationId: string) {
      const payload = await request<{ messages: Message[] }>(`/v1/conversations/${conversationId}/messages`)
      messages.value = payload.messages
      activeConversationId.value = conversationId
    }

    async function bootstrap() {
      if (isBootstrapping.value || token.value) {
        return
      }

      isBootstrapping.value = true
      errorText.value = ''
      statusText.value = '正在连接 Auraxis...'

      try {
        token.value = await props.getAuthToken()
        const me = await request<{ identity: Identity }>('/v1/auth/me')
        identity.value = me.identity

        const conversationPayload = await request<{ conversations: Conversation[] }>('/v1/conversations')
        conversations.value = conversationPayload.conversations

        if (conversations.value[0]) {
          statusText.value = '已恢复最近一次会话。'
          await loadMessages(conversations.value[0].id)
        } else {
          statusText.value = '已连接，可以开始发消息。'
        }
      } catch (error) {
        token.value = null
        errorText.value = error instanceof Error ? error.message : 'Auraxis 初始化失败。'
      } finally {
        isBootstrapping.value = false
      }
    }

    async function openPanel() {
      isOpen.value = !isOpen.value

      if (!isOpen.value) {
        return
      }

      await bootstrap()
      await nextTick()
      composerRef.value?.focus()
    }

    async function submitMessage() {
      const content = draft.value.trim()

      if (!content || isSending.value) {
        return
      }

      if (!token.value) {
        await bootstrap()
      }

      if (!token.value) {
        return
      }

      isSending.value = true
      errorText.value = ''
      statusText.value = '正在保存消息...'

      try {
        if (!activeConversationId.value) {
          const runtimeContext = getRuntimePageContext(props.pageContext)
          const payload = await request<{ conversation: Conversation }>('/v1/conversations', {
            method: 'POST',
            body: JSON.stringify({
              pageTitle: typeof runtimeContext.title === 'string' ? runtimeContext.title : undefined,
              sourceUrl: typeof runtimeContext.url === 'string' ? runtimeContext.url : undefined,
              metadata: runtimeContext,
              initialMessage: content
            })
          })

          activeConversationId.value = payload.conversation.id
          conversations.value = [payload.conversation, ...conversations.value]
        } else {
          await request<{ message: Message }>(`/v1/conversations/${activeConversationId.value}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content })
          })
        }

        draft.value = ''
        statusText.value = '消息已保存。'

        if (activeConversationId.value) {
          await loadMessages(activeConversationId.value)
        }
      } catch (error) {
        errorText.value = error instanceof Error ? error.message : '消息发送失败。'
      } finally {
        isSending.value = false
        await nextTick()
        composerRef.value?.focus()
      }
    }

    onBeforeUnmount(() => {
      messages.value = []
    })

    return () =>
      h(
        'div',
        {
          class: ['auraxis-assistant', `auraxis-assistant--${props.position}`],
          'data-app-id': props.appId
        },
        [
          h(
            'button',
            {
              type: 'button',
              class: 'auraxis-assistant__trigger',
              'aria-expanded': String(isOpen.value),
              disabled: isBootstrapping.value,
              onClick: openPanel
            },
            isOpen.value ? '关闭 Auraxis' : '打开 Auraxis'
          ),
          isOpen.value
            ? h('section', { class: 'auraxis-assistant__panel' }, [
                h('header', { class: 'auraxis-assistant__header' }, [
                  h('h2', { class: 'auraxis-assistant__title' }, 'Auraxis Assistant'),
                  h(
                    'div',
                    { class: 'auraxis-assistant__meta' },
                    identity.value
                      ? `${identity.value.displayName || identity.value.externalUserId} · ${props.appId}`
                      : props.appId
                  )
                ]),
                statusText.value ? h('div', { class: 'auraxis-assistant__status' }, statusText.value) : null,
                errorText.value ? h('div', { class: 'auraxis-assistant__error' }, errorText.value) : null,
                h(
                  'div',
                  { class: 'auraxis-assistant__messages' },
                  messages.value.length
                    ? messages.value.map((message) =>
                        h(
                          'div',
                          {
                            key: message.id,
                            class: [
                              'auraxis-assistant__bubble',
                              `auraxis-assistant__bubble--${message.role}`
                            ]
                          },
                          message.content
                        )
                      )
                    : [
                        h(
                          'div',
                          { class: 'auraxis-assistant__empty' },
                          '会话已连接。这里会显示当前用户最近会话里的消息。'
                        )
                      ]
                ),
                h(
                  'form',
                  {
                    class: 'auraxis-assistant__composer',
                    onSubmit: (event: Event) => {
                      event.preventDefault()
                      void submitMessage()
                    }
                  },
                  [
                    h('input', {
                      ref: composerRef,
                      class: 'auraxis-assistant__input',
                      type: 'text',
                      value: draft.value,
                      disabled: isBootstrapping.value || isSending.value,
                      placeholder: '输入一条消息',
                      onInput: (event: Event) => {
                        draft.value = (event.target as HTMLInputElement).value
                      }
                    }),
                    h(
                      'button',
                      {
                        type: 'submit',
                        class: 'auraxis-assistant__send',
                        disabled: isBootstrapping.value || isSending.value || !draft.value.trim()
                      },
                      isSending.value ? '发送中' : '发送'
                    )
                  ]
                )
              ])
            : null
        ]
      )
  }
})
