/**
 * DeepSeek account credit in the composer dock.
 *
 * The reading is the account Remote's balance query. It re-reads when the
 * session's billed tokens change (so a finished turn shows the new amount
 * without waiting for the timer), every minute while the page is visible, on
 * window focus, and once on load. It is account-wide, not session-wide: every
 * dock entry subscribes to one module-level store, so switching sessions
 * neither re-reads nor remounts the reading.
 */
window.__ModuleLoader__.load({
  id: 'dsh-credit-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'creditMeter'
    /** Balance refresh period; a settled turn also re-reads immediately. */
    const POLL_INTERVAL_MS = 60_000
    /** Bursts of usage changes (one per step) coalesce into one delayed read. */
    const SETTLE_DELAY_MS = 2_000

    const en = {
      title: 'Account credit',
      balance: 'Available',
      recharge: 'Recharge',
      bonus: 'Bonus',
      stale: 'The last read failed, so this value may be out of date',
    }
    const zh = {
      title: '账户额度',
      balance: '可用余额',
      recharge: '充值',
      bonus: '赠送',
      stale: '上次读取失败，该数值可能已过期',
    }

    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }

    /**
     * Format one amount the way Platform's own Web client does: two decimals
     * rounded down, sub-cent amounts as `<symbol>0.01`, grouped digits.
     * @param value - finite amount.
     * @param currency - wallet currency code.
     * @returns display text, or null when the amount is not finite.
     */
    function formatBalance(value, currency) {
      const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `
      if (!Number.isFinite(value)) return null
      const magnitude = Math.abs(value)
      if (magnitude === 0) return `${symbol}0.00`
      if (magnitude < 0.01) return `${value < 0 ? '-' : '<'}${symbol}0.01`
      const [integer, fraction] = (Math.floor(magnitude * 100) / 100).toFixed(2).split('.')
      return `${value < 0 ? '-' : ''}${symbol}${Number(integer).toLocaleString()}.${fraction}`
    }

    /**
     * Format one wallet entry, tolerating a malformed amount.
     * @param wallet - one wallet entry from the balance response.
     * @returns display text, or null.
     */
    function formatWallet(wallet) {
      return formatBalance(Number(wallet.balance), wallet.currency)
    }

    /** An amount worth naming: at least one cent in either direction. */
    const isMeaningful = (value) => Math.abs(value) >= 0.01

    /**
     * Reduce one balance response to the resting reading and its detail lines.
     * Platform reports one wallet per currency and keeps recharge and bonus
     * separate, so the reading is the spendable total of the best-funded
     * currency — a zero wallet of another currency must not win.
     * @param state - store state.
     * @param t - this plugin's translate function.
     * @returns the reading, or null when no wallet carries a number.
     */
    function summarize(state, t) {
      const wallets = [...state.wallets, ...state.bonusWallets]
      const totals = new Map()
      for (const wallet of wallets) {
        const amount = Number(wallet.balance)
        if (!Number.isFinite(amount)) continue
        totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + amount)
      }
      const ranked = [...totals.entries()].sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))
      if (ranked.length === 0) return null
      const [primaryCurrency, primaryTotal] = ranked[0]
      const main = formatBalance(primaryTotal, primaryCurrency)
      if (main === null) return null
      // A second funded currency stays visible instead of hiding behind the first.
      const extras = ranked.slice(1)
        .filter(([, total]) => isMeaningful(total))
        .map(([currency, total]) => formatBalance(total, currency))
        .filter(text => text !== null)
        .map(text => `+${text}`)
      const reading = [main, ...extras].join(' ')
      const lines = [t('title'), `${t('balance')} ${reading}`]
      // Zero wallets stay out of the breakdown while another wallet carries money.
      const funded = wallets.some(wallet => isMeaningful(Number(wallet.balance)))
      for (const [group, key] of [[state.wallets, 'recharge'], [state.bonusWallets, 'bonus']]) {
        for (const wallet of group) {
          if (funded && !isMeaningful(Number(wallet.balance))) continue
          const text = formatWallet(wallet)
          if (text !== null) lines.push(`${t(key)} ${text}`)
        }
      }
      if (state.stale) lines.push(t('stale'))
      return { label: `${t('balance')} ${reading}`, lines }
    }

    /**
     * One account-wide balance store shared by every dock entry. Subscribers wake
     * only when the displayed amounts, the staleness, or the phase change; a
     * failed read keeps the last good reading and marks it stale.
     * @returns the store.
     */
    function createStore() {
      let state = { phase: 'idle', key: '', wallets: [], bonusWallets: [], stale: false }
      const listeners = new Set()
      const keyOf = (value) => [
        value.phase,
        value.stale ? 'stale' : 'fresh',
        value.wallets.map(wallet => `${wallet.currency}=${wallet.balance}`).join(','),
        value.bonusWallets.map(wallet => `${wallet.currency}=${wallet.balance}`).join(','),
      ].join('|')
      const publish = (next) => {
        const resolved = next.phase === 'ready'
          ? next
          : { phase: next.phase, wallets: [], bonusWallets: [], stale: false }
        const key = keyOf(resolved)
        if (key === state.key) return
        state = { ...resolved, key }
        for (const listener of Array.from(listeners)) listener()
      }
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        ready(wallets, bonusWallets) {
          publish({ phase: 'ready', wallets, bonusWallets, stale: false })
        },
        // A cleared grant is definitive; a failed read is not.
        signedOut() {
          publish({ phase: 'signed-out', wallets: [], bonusWallets: [] })
        },
        failed() {
          if (state.phase === 'ready') {
            publish({ phase: 'ready', wallets: state.wallets, bonusWallets: state.bonusWallets, stale: true })
            return
          }
          publish({ phase: 'failed', wallets: [], bonusWallets: [] })
        },
        /** Replaced by the poller; a settled turn calls it to re-read early. */
        requestRefresh() {},
      }
    }

    /**
     * Build the Platform request identity for one account call.
     * @param ctx - client context.
     * @returns the metadata the account Remote expects.
     */
    function readClientMetadata(ctx) {
      const locale = ctx.locale.getSnapshot().active
      const accountUi = ctx.get('accountUi')
      if (accountUi !== undefined && typeof accountUi.clientMetadata === 'function') {
        try { return accountUi.clientMetadata(locale) } catch (_error) { /* use the local identity */ }
      }
      const env = typeof process === 'undefined' ? {} : (process.env ?? {})
      return {
        version: env.DSH_CLIENT_VERSION ?? 'unknown',
        locale,
        // Date.getTimezoneOffset reports minutes west of UTC; Platform wants seconds east.
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
    }

    /**
     * Read the account balance now and keep reading it while the page is visible.
     * @param ctx - client context.
     * @param store - the account-wide balance store.
     * @returns the polling disposer.
     */
    function startPolling(ctx, store) {
      const account = ctx.remote.account
      let stopped = false
      let inFlight = false
      let retries = 0
      let scheduled
      const retryTimers = new Set()
      const refresh = async () => {
        if (stopped || inFlight) return
        inFlight = true
        try {
          const result = await account.getBalance(readClientMetadata(ctx))
          if (stopped) return
          if (result === null || result === undefined || result.ok !== true) {
            store.failed()
            retrySoon()
            return
          }
          const details = result.value
          // A null outcome means no stored grant, so there is nothing to show.
          if (details === null || details === undefined) { store.signedOut(); return }
          if (details.status !== 'ready') { store.failed(); retrySoon(); return }
          retries = 0
          store.ready(details.value ?? [], details.bonusWallets ?? [])
        } catch (_error) {
          if (stopped) return
          store.failed()
          retrySoon()
        } finally {
          inFlight = false
        }
      }
      // The first read can race the account plugin's registration; a few short
      // retries settle it without waiting for the next poll period.
      function retrySoon() {
        if (stopped || retries >= 3 || store.getSnapshot().phase === 'ready') return
        retries += 1
        const handle = setTimeout(() => {
          retryTimers.delete(handle)
          void refresh()
        }, 4_000 * retries)
        retryTimers.add(handle)
      }
      const timer = setInterval(() => {
        if (document.visibilityState !== 'hidden') void refresh()
      }, POLL_INTERVAL_MS)
      const onFocus = () => { void refresh() }
      const onVisibility = () => {
        if (document.visibilityState === 'visible') void refresh()
      }
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisibility)
      store.requestRefresh = () => {
        if (stopped || scheduled !== undefined) return
        scheduled = setTimeout(() => {
          scheduled = undefined
          void refresh()
        }, SETTLE_DELAY_MS)
      }
      void refresh()
      return () => {
        stopped = true
        clearInterval(timer)
        if (scheduled !== undefined) clearTimeout(scheduled)
        for (const handle of retryTimers) clearTimeout(handle)
        retryTimers.clear()
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }

    /** `useSyncExternalStore` with a subscription fallback for older React builds. */
    const useStore = React.useSyncExternalStore ?? function useStoreFallback(subscribe, getSnapshot) {
      const [value, setValue] = React.useState(getSnapshot)
      React.useEffect(() => subscribe(() => { setValue(getSnapshot()) }), [subscribe, getSnapshot])
      return value
    }

    /** Projection read used when the dock does not hand one over. */
    const noProjection = () => undefined

    /** Wallet glyph drawn in the current text color so it follows the theme. */
    const WALLET_GLYPH = h(
      'svg',
      {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true, focusable: 'false', style: { flex: 'none' },
      },
      h('path', {
        d: 'M2.4 4.2c0-.61.49-1.1 1.1-1.1h7.2',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      }),
      h('rect', {
        x: 2.4, y: 4.6, width: 11.2, height: 7.2, rx: 1.6,
        stroke: 'currentColor', strokeWidth: 1.4,
      }),
      h('circle', { cx: 10.4, cy: 8.2, r: 0.9, fill: 'currentColor' }),
    )

    /** Resting reading style: the composer dock's own reading metrics. */
    const READING_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      boxSizing: 'border-box',
      minWidth: 0,
      maxWidth: '100%',
      padding: '1px 8px',
      borderRadius: 'var(--dsw-radius-sm)',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    }

    /**
     * The dock reading: a wallet glyph, the balance word, and the spendable
     * amount. The billed-token projection re-reads the balance when a turn
     * settles; the full wallet breakdown is in the tooltip and the accessible name.
     * @param props - the dock entry's runtime props, locale seat, and this
     * plugin's own translator.
     * @returns the reading, or nothing while signed out or before the first read.
     */
    function CreditPill(props) {
      const state = useStore(store.subscribe, store.getSnapshot)
      const useProjection = props.useProjection ?? noProjection
      const usage = useProjection('tokenUsage')
      const billed = usage === undefined || usage === null
        ? undefined
        : usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
      React.useEffect(() => {
        if (billed === undefined) return
        store.requestRefresh()
      }, [billed])
      const t = typeof props.t === 'function' ? props.t : props.translate
      if (state.phase !== 'ready') return null
      const reading = summarize(state, t)
      if (reading === null) return null
      return h(
        'span',
        {
          className: 'credit-meter',
          title: reading.lines.join('\n'),
          'aria-label': reading.lines.join(' · '),
          'data-credit-meter': reading.label,
          style: READING_STYLE,
        },
        WALLET_GLYPH,
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, reading.label),
      )
    }

    /** One store for the whole page: the balance is account-wide, not session-wide. */
    const store = createStore()

    return {
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'credit-meter: dictionaries')
        const translate = ctx.locale.bind(NS)
        ctx.effect(() => startPolling(ctx, store), 'credit-meter: balance polling')
        const Pill = (props) => h(CreditPill, { ...props, translate })
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'credit-meter',
          order: 2,
          locale: NS,
        }, Pill))
      },
    }
  },
})
