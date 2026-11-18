/**
 * dsh-connect-cursor-pro — browser half.
 *
 * Contributes one settings section (`settings.section` id
 * `dsh-connect-cursor-pro`): a compact header (title + refresh + live credential
 * status), the model catalog (4 shown, expandable), an optional credential
 * editor, and a one-line diagnostics footer. Data is read over the plugin's
 * own same-origin `/api/dsh-connect-cursor-pro/*` routes served by the Host.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-connect-cursor-pro',
  factory(require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const NS = 'dsh-connect-cursor-pro'
    const API = '/api/dsh-connect-cursor-pro'
    const PREVIEW_COUNT = 4

    const DICT = {
      zh: {
        nav: 'Cursor 接入',
        title: 'Cursor 接入',
        'credential.ok': '已连接',
        'credential.fail': '未连接',
        'credential.pending': '探测中',
        models: '可用模型',
        'models.empty': '暂无模型',
        expand: '展开全部',
        collapse: '收起',
        refresh: '刷新',
        loading: '加载中…',
        loadFailed: '无法连接插件后端',
        credentials: '凭据（可选）',
        credentialsHint: '留空即自动读取本机登录态。',
        accessToken: '访问令牌',
        apiKey: 'API Key',
        save: '保存',
        clear: '清除',
        saved: '已保存',
        configured: '已配置',
        notConfigured: '未配置',
        saveFailed: '保存失败',
        sourceEnv: '环境变量',
        sourceCredential: '凭据存储',
        multiTurn: '多轮',
        tools: '工具',
        on: '开',
        off: '关',
      },
      en: {
        nav: 'Connect Cursor',
        title: 'Connect Cursor',
        'credential.ok': 'Connected',
        'credential.fail': 'Not connected',
        'credential.pending': 'Probing',
        models: 'Available models',
        'models.empty': 'No models',
        expand: 'Show all',
        collapse: 'Collapse',
        refresh: 'Refresh',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        credentials: 'Credentials (optional)',
        credentialsHint: 'Leave empty to auto-read the local login.',
        accessToken: 'Access token',
        apiKey: 'API key',
        save: 'Save',
        clear: 'Clear',
        saved: 'Saved',
        configured: 'configured',
        notConfigured: 'not configured',
        saveFailed: 'Save failed',
        sourceEnv: 'environment',
        sourceCredential: 'credential store',
        multiTurn: 'Multi-turn',
        tools: 'Tools',
        on: 'on',
        off: 'off',
      },
    }

    const CSS = `
.ccp_root{display:flex;flex-direction:column;gap:14px;max-width:1080px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.ccp_head{display:flex;flex-direction:column;gap:9px}
.ccp_headrow{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ccp_title{margin:0;font-size:19px;font-weight:720;letter-spacing:-.3px;line-height:1.2}
.ccp_status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);min-height:18px}
.ccp_dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.ccp_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.ccp_dot.err{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
.ccp_panel{padding:14px 16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);display:flex;flex-direction:column;gap:12px}
.ccp_paneltitle{font-size:12px;font-weight:680;letter-spacing:.2px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.ccp_models{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.ccp_card{display:flex;flex-direction:column;gap:5px;padding:10px 12px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent)}
.ccp_cardhead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.ccp_mname{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccp_ctx{flex:none;font-size:10px;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ccp_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccp_foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ccp_sep{color:var(--dsw-alias-border-l2)}
.ccp_flag{font-variant-numeric:tabular-nums}
.ccp_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ccp_label{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:64px}
.ccp_input{flex:1;min-width:0;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ccp_input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ccp_badge{font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ccp_badge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.ccp_btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary);font-size:12.5px;font-weight:600;cursor:pointer}
.ccp_btn:hover{opacity:.86}
.ccp_btn:disabled{opacity:.5;cursor:default}
.ccp_btn2{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.ccp_btn2:hover{opacity:.86}
.ccp_btn2:disabled{opacity:.5;cursor:default}
.ccp_btn2.primary{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}
.ccp_reason{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.ccp_msg{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ccp_msg.err{color:var(--dsw-alias-state-error-primary)}
.ccp_err{font-size:12px;color:var(--dsw-alias-state-error-primary)}
`

    function fmtContext(n) {
      if (!n) return ''
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
      if (n >= 1000) return `${Math.round(n / 1000)}k`
      return String(n)
    }

    function fmtTime(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString()
    }

    function CredentialEditor({ t }) {
      const [draft, setDraft] = useState({ accessToken: '', apiKey: '' })
      const [info, setInfo] = useState({ accessToken: null, apiKey: null })
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [messageErr, setMessageErr] = useState(false)

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/credentials`, { cache: 'no-store' })
          if (res.ok) setInfo(await res.json())
        } catch {
          /* backend unavailable */
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const applyPatch = useCallback(async (patch) => {
        setBusy(true)
        setMessage(null)
        setMessageErr(false)
        try {
          const res = await fetch(`${API}/credentials`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          setInfo(data)
          setDraft({ accessToken: '', apiKey: '' })
          setMessage(t('saved'))
        } catch (error) {
          setMessage(`${t('saveFailed')}: ${error?.message || error}`)
          setMessageErr(true)
        } finally {
          setBusy(false)
        }
      }, [t])

      const badge = (d) => (d?.configured
        ? h('span', { className: 'ccp_badge ok' }, d.source === 'env' ? t('sourceEnv') : t('sourceCredential'))
        : h('span', { className: 'ccp_badge' }, t('notConfigured')))

      const row = (label, value, patchKey, placeholder, title) => h('div', { className: 'ccp_row' },
        h('span', { className: 'ccp_label' }, label),
        h('input', {
          className: 'ccp_input',
          type: 'password',
          value,
          placeholder,
          title,
          autoComplete: 'off',
          spellCheck: false,
          onChange: (e) => setDraft((s) => ({ ...s, [patchKey]: e.target.value })),
        }),
        h('button', { className: 'ccp_btn2 primary', disabled: busy, onClick: () => applyPatch({ [patchKey]: value }) }, t('save')),
        h('button', { className: 'ccp_btn2', disabled: busy || !info[patchKey]?.configured, onClick: () => applyPatch({ [patchKey]: '' }) }, t('clear')),
        badge(info[patchKey]),
      )

      return h('section', { className: 'ccp_panel' },
        h('div', { className: 'ccp_paneltitle' },
          t('credentials'),
          h('span', { className: 'ccp_reason' }, t('credentialsHint')),
        ),
        row(t('accessToken'), draft.accessToken, 'accessToken', 'eyJ…', 'CURSOR_ACCESS_TOKEN'),
        row(t('apiKey'), draft.apiKey, 'apiKey', 'crsr_…', 'CURSOR_API_KEY'),
        message ? h('div', { className: `ccp_msg ${messageErr ? 'err' : ''}` }, message) : null,
      )
    }

    function StatusPage({ t }) {
      const [state, setState] = useState({ loading: true, busy: false, error: null, data: null })
      const [showAllModels, setShowAllModels] = useState(false)

      const load = useCallback(async () => {
        setState((s) => ({ ...s, loading: true, error: null }))
        try {
          const res = await fetch(`${API}/status`, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          setState({ loading: false, busy: false, error: null, data })
        } catch (error) {
          setState((s) => ({ ...s, loading: false, busy: false, error: error?.message || String(error) }))
        }
      }, [])

      const refresh = useCallback(async () => {
        setState((s) => ({ ...s, busy: true, error: null }))
        try {
          const res = await fetch(`${API}/refresh`, { method: 'POST' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          setState({ loading: false, busy: false, error: null, data })
        } catch (error) {
          setState((s) => ({ ...s, busy: false, error: error?.message || String(error) }))
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const data = state.data
      const credential = data?.credential
      const models = data?.models || []
      const visibleModels = showAllModels ? models : models.slice(0, PREVIEW_COUNT)
      const hasMore = models.length > PREVIEW_COUNT
      const diag = data?.diagnostics || {}

      const statusText = (c) => (c.ok ? t('credential.ok') : t('credential.fail'))

      return h('div', { className: 'ccp_root' },
        // Header: title + refresh + compact status
        h('header', { className: 'ccp_head' },
          h('div', { className: 'ccp_headrow' },
            h('h2', { className: 'ccp_title' }, t('title')),
            h('button', { className: 'ccp_btn', onClick: refresh, disabled: state.busy || state.loading }, state.busy ? t('loading') : t('refresh')),
          ),
          state.loading
            ? h('div', { className: 'ccp_status' }, t('credential.pending'))
            : credential
              ? h('div', { className: 'ccp_status' },
                  h('span', { className: `ccp_dot ${credential.ok ? 'ok' : 'err'}` }),
                  h('span', null, statusText(credential)),
                  credential.ok && credential.source ? h('span', { className: 'ccp_mono' }, credential.source) : null,
                  !credential.ok && credential.reason ? h('span', { className: 'ccp_reason' }, credential.reason) : null,
                )
              : null,
        ),

        // Models
        h('section', { className: 'ccp_panel' },
          h('div', { className: 'ccp_paneltitle' }, `${t('models')} · ${models.length}`),
          models.length === 0 && !state.loading
            ? h('div', { className: 'ccp_reason' }, t('models.empty'))
            : h('div', { className: 'ccp_models' },
                visibleModels.map((m) => h('div', { className: 'ccp_card', key: m.id },
                  h('div', { className: 'ccp_cardhead' },
                    h('span', { className: 'ccp_mname' }, m.name || m.id),
                    m.context ? h('span', { className: 'ccp_ctx' }, fmtContext(m.context)) : null,
                  ),
                  h('span', { className: 'ccp_mono' }, m.id),
                )),
              ),
          hasMore
            ? h('button', { className: 'ccp_btn2', onClick: () => setShowAllModels((v) => !v) }, showAllModels ? t('collapse') : t('expand'))
            : null,
        ),

        h(CredentialEditor, { t }),

        // Diagnostics footer
        h('footer', { className: 'ccp_foot' },
          h('span', { className: 'ccp_mono' }, diag.clientVersion || '—'),
          h('span', { className: 'ccp_sep' }, '·'),
          h('span', { className: 'ccp_mono' }, diag.apiBase || '—'),
          h('span', { className: 'ccp_sep' }, '·'),
          h('span', { className: 'ccp_flag' }, `${t('multiTurn')} ${diag.multiTurn === false ? t('off') : t('on')}`),
          h('span', { className: 'ccp_sep' }, '·'),
          h('span', { className: 'ccp_flag' }, `${t('tools')} ${diag.tools ? t('on') : t('off')}`),
          diag.refreshedAt ? h('span', { className: 'ccp_flag' }, `· ${fmtTime(diag.refreshedAt)}`) : null,
        ),

        state.error ? h('div', { className: 'ccp_err' }, `${t('loadFailed')}: ${state.error}`) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-connect-cursor-pro: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-connect-cursor-pro')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-connect-cursor-pro: styles')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-connect-cursor-pro',
          order: 35,
          label: () => t('nav'),
          locale: NS,
        }, (props) => h(StatusPage, { ...props, t })))
      },
    }
  },
})
