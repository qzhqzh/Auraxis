import { defineComponent, h, ref, type PropType } from 'vue'

type PageContext = Record<string, unknown>

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
    const isOpen = ref(false)

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
              onClick: () => {
                isOpen.value = !isOpen.value
              }
            },
            'Auraxis'
          ),
          isOpen.value
            ? h('section', { class: 'auraxis-assistant__panel' }, [
                h('div', { class: 'auraxis-assistant__messages' }),
                h('form', { class: 'auraxis-assistant__composer' }, [
                  h('input', {
                    class: 'auraxis-assistant__input',
                    type: 'text',
                    disabled: true,
                    placeholder: 'Auraxis assistant'
                  })
                ])
              ])
            : null
        ]
      )
  }
})
