/**
 * dsh-auto-continue — browser half (read-only).
 *
 * A compact dock entry showing only an icon plus the number of sessions the
 * last boot scan resumed, so it costs almost no status-bar space. Clicking it
 * opens a detail modal (portalled to <body>) with the per-session breakdown —
 * resumed ids and skipped ids-with-reasons — grouped behind a summary strip.
 * The whole thing is read-only: it calls one owner-only POST route on its own
 * host half over the Connection rpc carrier. There is NO enable/disable
 * control — loading the plugin is what turns the feature on; to turn it off,
 * disable the plugin itself.
 *
 * Lazy-CJS bundle form: running this script only registers the factory; every
 * side effect lives inside it. Self-contained controls: no Harness Client
 * package is required (only `react`/`react-dom`), and colours come only from
 * `--dsw-alias-*` theme tokens inherited from <body>.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-continue',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Theme tokens — the only styling contract, all --dsw-alias-* names. */
    const TOKEN = {
      label: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      border: 'var(--dsw-alias-border-l2)',
      success: 'var(--dsw-alias-state-success-primary)',
      mask: 'var(--dsw-alias-bg-mask-1)',
    }

    /** Connection channel + endpoint; must match STATUS_PATH in lib/index.js. */
    const API_CHANNEL = '/api'
    const STATUS_ENDPOINT = 'auto-continue/status'

    /** Read the status result from the owner-only host route. Never throws. */
    async function readStatus(connection, signal) {
      if (connection?.rpc?.call === undefined) return { error: 'connection 服务未挂载' }
      try {
        const response = await connection.rpc.call(API_CHANNEL, STATUS_ENDPOINT, {}, signal)
        if (!response?.ok) {
          return { error: response?.error ? String(response.error.message ?? response.error) : '宿主读取失败' }
        }
        const value = response.value
        if (value === null || typeof value !== 'object' || typeof value.version !== 'string') {
          return { error: '宿主返回了无法识别的状态' }
        }
        return { value }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** Skip reasons, grouped by meaning rather than shown as raw internal codes. */
    const SKIP_LABEL = {
      live: '会话仍在运行',
      'became-live': '扫描期间开始运行',
      'no-open-turn': '上一轮已正常结束',
      unreadable: '日志尾部读取失败',
      'resume-failed': '恢复失败',
      'ownership-mismatch': '已被其它恢复占用',
      'followup-failed': '续跑指令投递失败',
    }

    /** One detail row: a monospace id on the left, a human reason/fate on the right. */
    function DetailRow({ id, tone, label }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            padding: '5px 0',
            borderBottom: `1px solid ${TOKEN.border}`,
          },
        },
        h('code', {
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11,
            color: TOKEN.label,
          },
          title: id,
        }, id),
        h('span', {
          style: { flex: '0 0 auto', fontSize: 11, color: tone ?? TOKEN.labelSecondary },
        }, label),
      )
    }

    /** Modal dialog portalled to <body>, so the dock's overflow cannot clip it. */
    function DetailDialog({ open, onClose, data, error }) {
      const dialogRef = React.useRef(null)

      React.useEffect(() => {
        if (open !== true) return undefined
        const previous = document.activeElement
        dialogRef.current?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          const dialog = dialogRef.current
          if (dialog === null) return
          const focusable = dialog.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          )
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (event.shiftKey && (active === first || active === dialog)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          if (previous && typeof previous.focus === 'function') previous.focus()
        }
      }, [open, onClose])

      if (open !== true) return null

      const scan = data?.lastScan
      const resumed = Array.isArray(scan?.resumed) ? scan.resumed : []
      const skipped = Array.isArray(scan?.skipped) ? scan.skipped : []

      return ReactDOM.createPortal(
        h(
          'div',
          {
            style: {
              position: 'fixed',
              inset: 0,
              background: TOKEN.mask,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
              zIndex: 2147483000,
            },
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) onClose()
            },
          },
          h(
            'div',
            {
              ref: dialogRef,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '自动续跑状态',
              tabIndex: -1,
              style: {
                background: TOKEN.surface,
                color: TOKEN.label,
                border: `1px solid ${TOKEN.border}`,
                borderRadius: 10,
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.22)',
                padding: '18px 18px 14px',
                width: '100%',
                maxWidth: 420,
                maxHeight: '80vh',
                overflow: 'auto',
                outline: 'none',
                font: 'inherit',
              },
            },
            // header
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 } },
              h('div', { style: { fontSize: 13, fontWeight: 600 } }, '↻ 自动续跑'),
              h('button', {
                type: 'button',
                'aria-label': '关闭',
                onClick: onClose,
                style: {
                  border: 'none',
                  background: 'transparent',
                  color: TOKEN.labelSecondary,
                  cursor: 'pointer',
                  fontSize: 16,
                  lineHeight: 1,
                  padding: 2,
                },
              }, '×'),
            ),
            error !== undefined
              ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, error)
              : scan === null || scan === undefined
                ? h('div', { style: { color: TOKEN.labelSecondary, fontSize: 12 } }, '上次扫描尚未完成。')
                : h(
                    'div',
                    null,
                    // summary strip
                    h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          gap: 20,
                          padding: '10px 12px',
                          marginBottom: 14,
                          borderRadius: 8,
                          background: 'var(--dsw-alias-bg-layer-2)',
                        },
                      },
                      h(
                        'div',
                        null,
                        h('div', { style: { fontSize: 18, fontWeight: 600, color: TOKEN.success } }, String(resumed.length)),
                        h('div', { style: { fontSize: 10, color: TOKEN.labelSecondary } }, '已续跑'),
                      ),
                      h(
                        'div',
                        null,
                        h('div', { style: { fontSize: 18, fontWeight: 600 } }, String(skipped.length)),
                        h('div', { style: { fontSize: 10, color: TOKEN.labelSecondary } }, '已跳过'),
                      ),
                      h(
                        'div',
                        null,
                        h('div', { style: { fontSize: 18, fontWeight: 600 } }, data?.version ?? '—'),
                        h('div', { style: { fontSize: 10, color: TOKEN.labelSecondary } }, '插件版本'),
                      ),
                    ),
                    // resumed list
                    h('div', { style: { fontSize: 11, fontWeight: 600, marginBottom: 4 } }, '已续会话'),
                    resumed.length === 0
                      ? h('div', { style: { fontSize: 11, color: TOKEN.labelSecondary, padding: '4px 0 10px' } }, '本次没有续跑任何会话。')
                      : h('div', { style: { marginBottom: 12 } }, resumed.map((id) => h(DetailRow, { key: id, id, tone: TOKEN.success, label: '已续' }))),
                    // skipped list
                    h('div', { style: { fontSize: 11, fontWeight: 600, margin: '4px 0' } }, '跳过会话'),
                    skipped.length === 0
                      ? h('div', { style: { fontSize: 11, color: TOKEN.labelSecondary, padding: '4px 0' } }, '没有跳过的会话。')
                      : h(
                          'div',
                          null,
                          skipped.map((entry, index) => {
                            const id = typeof entry === 'string' ? entry : entry?.id ?? String(entry)
                            const why = typeof entry === 'string' ? '' : entry?.why ?? ''
                            return h(DetailRow, { key: `${id}-${index}`, id, label: SKIP_LABEL[why] ?? why ?? '跳过' })
                          }),
                        ),
                  ),
            // footer
            h(
              'div',
              { style: { marginTop: 14, display: 'flex', justifyContent: 'flex-end' } },
              h('button', {
                type: 'button',
                onClick: onClose,
                style: {
                  border: `1px solid ${TOKEN.border}`,
                  background: 'transparent',
                  color: TOKEN.label,
                  borderRadius: 6,
                  padding: '5px 14px',
                  fontSize: 11,
                  cursor: 'pointer',
                  font: 'inherit',
                },
              }, '关闭'),
            ),
          ),
        ),
        document.body,
      )
    }

    /** Compact dock entry: an icon plus the number of sessions resumed at last boot. */
    function StatusChip({ load }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(undefined)
      const [open, setOpen] = React.useState(false)
      const close = React.useCallback(() => setOpen(false), [])

      React.useEffect(() => {
        let alive = true
        // The status is global to the last boot scan, not per-session: the
        // inject face's `load(sessionId, signal)` ignores sessionId, so call it
        // with no session and an undefined signal.
        load(undefined, undefined).then((result) => {
          if (!alive) return
          if (result.error !== undefined) setError(result.error)
          else setData(result.value)
        })
        return () => { alive = false }
      }, [load])

      const scan = data?.lastScan
      const resumed = Array.isArray(scan?.resumed) ? scan.resumed : []
      const count = error !== undefined || scan === null || scan === undefined ? '—' : String(resumed.length)
      const title = error !== undefined ? '自动续跑：读取失败' : '自动续跑：点击查看上次扫描详情'

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            'aria-label': title,
            title,
            onClick: () => setOpen(true),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0,
              font: 'inherit',
              fontSize: 11,
              lineHeight: 1,
              color: error === undefined && resumed.length > 0 ? TOKEN.success : TOKEN.labelSecondary,
              background: 'transparent',
              border: 'none',
              padding: '2px 0',
              cursor: 'pointer',
            },
          },
          h('span', { 'aria-hidden': true }, '↻'),
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, count),
        ),
        h(DetailDialog, { open, onClose: close, data, error }),
      )
    }

    /** Client services used: slots to dock, connection to read the host route. */
    const inject = ['slots', 'connection']

    function apply(ctx) {
      const connection = ctx.connection
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'auto-continue-status',
            order: 70,
            inject: () => ({
              load: (sessionId, signal) => readStatus(connection, signal),
            }),
          },
          StatusChip,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
