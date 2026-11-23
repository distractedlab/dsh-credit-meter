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
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'creditMeter'
    /** Balance refresh period; a settled turn also re-reads immediately. */
    const POLL_INTERVAL_MS = 60_000
    /** Bursts of usage changes (one per step) coalesce into one delayed read. */
    const SETTLE_DELAY_MS = 2_000

    const en = {
      balance: 'Balance',
      total: 'Available Balance',
      recharge: 'Top-up Balance',
      bonus: 'Bonus Balance',
      stale: 'The last read failed, so this value may be out of date',
    }
    const zh = {
      balance: '可用余额',
      total: '可用余额',
      recharge: '充值余额',
      bonus: '赠送余额',
      stale: '上次读取失败，该数值可能已过期',
    }

    const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }
    /** Display order is fixed: CNY first, then USD; unknown codes follow them. */
    const CURRENCY_ORDER = ['CNY', 'USD']
    const ZERO = { negative: false, digits: 0n, exponent: 0 }
    /**
     * Guard rails for parsing. Real balances carry at most 16 fraction digits
     * and small integer parts, so these limits reject only absurd input while
     * keeping every plausible amount accepted.
     */
    const MAX_DECIMAL_DIGITS = 40
    const MAX_DECIMAL_EXPONENT = 40

    /**
     * Parse a Platform balance string into an exact decimal, where
     * `digits * 10^exponent` is the magnitude. Platform sends these values as
     * strings and keeps their original decimal text, so working from the text
     * avoids binary-float drift in sums entirely.
     * @param text - decimal string, optionally with an exponent (`0E-16`, `1e+3`).
     * @returns the exact decimal, or null when the text is not a decimal number.
     */
    function parseDecimal(text) {
      const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(text).trim())
      if (match === null) return null
      const [, sign, integerPart, fractionPart = '', exponentPart = '0'] = match
      if (integerPart === '' && fractionPart === '') return null
      if (integerPart.length + fractionPart.length > MAX_DECIMAL_DIGITS) return null
      const exponent = Number(exponentPart) - fractionPart.length
      if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT) return null
      return { negative: sign === '-', digits: BigInt(`${integerPart}${fractionPart}`), exponent }
    }

    /**
     * Add two exact decimals after aligning their exponents.
     * @param left - first decimal.
     * @param right - second decimal.
     * @returns the exact sum.
     */
    function addDecimal(left, right) {
      const exponent = Math.min(left.exponent, right.exponent)
      const leftDigits = left.digits * 10n ** BigInt(left.exponent - exponent)
      const rightDigits = right.digits * 10n ** BigInt(right.exponent - exponent)
      const sum = (left.negative ? -leftDigits : leftDigits) + (right.negative ? -rightDigits : rightDigits)
      return { negative: sum < 0n, digits: sum < 0n ? -sum : sum, exponent }
    }

    /** Whether an exact decimal is zero. */
    function isZeroDecimal(value) {
      return value.digits === 0n
    }

    /**
     * Format one exact decimal the way Platform's own Web client does: two
     * decimals truncated, sub-cent amounts as `<symbol>0.01`, grouped digits.
     * The sign comes from the exact value, so a negative balance keeps it.
     * @param value - exact decimal.
     * @param currency - wallet currency code.
     * @returns display text.
     */
    function formatDecimal(value, currency) {
      const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `
      const shift = value.exponent + 2
      const cents = shift >= 0
        ? value.digits * 10n ** BigInt(shift)
        : value.digits / 10n ** BigInt(-shift)
      if (cents === 0n) {
        if (value.digits === 0n) return `${symbol}0.00`
        return `${value.negative ? '-<' : '<'}${symbol}0.01`
      }
      const integer = (cents / 100n).toLocaleString()
      const fraction = String(cents % 100n).padStart(2, '0')
      return `${value.negative ? '-' : ''}${symbol}${integer}.${fraction}`
    }

    /** Fixed display rank: CNY, then USD, then any other code. */
    function currencyRank(currency) {
      const index = CURRENCY_ORDER.indexOf(currency)
      return index === -1 ? CURRENCY_ORDER.length : index
    }

    /**
     * Reduce one balance response to the resting reading and its detail lines.
     * Recharge and bonus balances of one currency are added as exact decimals;
     * each currency is listed separately, in a fixed order, with no conversion.
     * @param state - store state.
     * @param t - this plugin's translate function.
     * @returns the reading, or null when the response carries no wallet.
     */
    function summarize(state, t) {
      const recharge = new Map()
      const bonus = new Map()
      for (const [group, target] of [[state.wallets, recharge], [state.bonusWallets, bonus]]) {
        for (const wallet of group) {
          const amount = parseDecimal(wallet.balance)
          // The store rejects an unparseable response before publishing it, so
          // this is a guard against a partial reading rather than a fallback.
          if (amount === null) return null
          const current = target.get(wallet.currency)
          target.set(wallet.currency, current === undefined ? amount : addDecimal(current, amount))
        }
      }
      const currencies = [...new Set([...recharge.keys(), ...bonus.keys()])]
        .sort((left, right) => currencyRank(left) - currencyRank(right))
      if (currencies.length === 0) {
        // A successful read that returned no wallet is a zero balance, not a
        // missing one: signed-out and failed reads never reach this function.
        const reading = formatDecimal(ZERO, 'CNY')
        const lines = [`${t('total')} ${reading}`]
        if (state.stale) lines.push(t('stale'))
        return { label: `${t('balance')} ${reading}`, lines }
      }
      const totals = new Map(currencies.map(currency => {
        const parts = [recharge.get(currency), bonus.get(currency)].filter(part => part !== undefined)
        return [currency, parts.reduce(addDecimal, ZERO)]
      }))
      // Only an exact zero drops out; a real sub-cent amount stays visible.
      const funded = currencies.filter(currency => !isZeroDecimal(totals.get(currency)))
      const shown = funded.length > 0 ? funded : [currencies[0]]
      const reading = shown
        .map(currency => formatDecimal(funded.length > 0 ? totals.get(currency) : ZERO, currency))
        .join(' · ')
      const lines = [`${t('total')} ${reading}`]
      for (const currency of currencies) {
        for (const [group, key] of [[recharge, 'recharge'], [bonus, 'bonus']]) {
          const amount = group.get(currency)
          if (amount === undefined || isZeroDecimal(amount)) continue
          lines.push(`${t(key)} ${formatDecimal(amount, currency)}`)
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
      // A failed or unparseable read keeps the last good reading and marks it
      // stale; without one there is no reading to show.
      const fail = () => {
        if (state.phase === 'ready') {
          publish({ phase: 'ready', wallets: state.wallets, bonusWallets: state.bonusWallets, stale: true })
          return
        }
        publish({ phase: 'failed', wallets: [], bonusWallets: [] })
      }
      const readable = (wallets) => wallets.every(wallet => parseDecimal(wallet.balance) !== null)
      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        ready(wallets, bonusWallets) {
          // The response parsed as a balance query, but an amount that cannot
          // be parsed is a failed read, not a zero or partial balance.
          if (!readable(wallets) || !readable(bonusWallets)) { fail(); return }
          publish({ phase: 'ready', wallets, bonusWallets, stale: false })
        },
        // A cleared grant is definitive; a failed read is not.
        signedOut() {
          publish({ phase: 'signed-out', wallets: [], bonusWallets: [] })
        },
        failed() {
          fail()
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

    /** Delay before a hover opens the breakdown, matching the host tooltips. */
    const TOOLTIP_DELAY_MS = 150
    /** Gap above or below the reading and the inset kept from the window edges. */
    const TOOLTIP_GAP = 8
    const TOOLTIP_INSET = 8

    /**
     * Render the surface through React's portal so composer clipping, transforms
     * and layout measurements cannot affect its viewport-based position. React
     * owns the portal's lifetime; no separate DOM root is created or retained.
     * @param props - the breakdown lines and the reading they describe.
     * @returns the reading with its tooltip.
     */
    function CreditTooltip(props) {
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const anchor = React.useRef(null)
      const panel = React.useRef(null)
      const timer = React.useRef(undefined)
      const tooltipId = React.useId?.() ?? 'credit-meter-tooltip'

      const cancel = () => {
        if (timer.current !== undefined) {
          clearTimeout(timer.current)
          timer.current = undefined
        }
      }
      const hide = () => {
        cancel()
        setOpen(false)
        setPosition(null)
      }
      const schedule = () => {
        cancel()
        timer.current = setTimeout(() => { setOpen(true) }, TOOLTIP_DELAY_MS)
      }
      React.useEffect(() => cancel, [])

      React.useLayoutEffect(() => {
        if (!open) return
        const target = anchor.current
        const surface = panel.current
        if (target === null || surface === null) return
        const box = target.getBoundingClientRect()
        const size = surface.getBoundingClientRect()
        const above = box.top - size.height - TOOLTIP_GAP >= TOOLTIP_INSET
        const preferredTop = above ? box.top - size.height - TOOLTIP_GAP : box.bottom + TOOLTIP_GAP
        const top = Math.max(TOOLTIP_INSET, Math.min(preferredTop, window.innerHeight - size.height - TOOLTIP_INSET))
        const centered = box.left + (box.width - size.width) / 2
        const left = Math.min(
          Math.max(centered, TOOLTIP_INSET),
          Math.max(TOOLTIP_INSET, window.innerWidth - size.width - TOOLTIP_INSET),
        )
        setPosition({ top, left })
      }, [open, props.lines])

      React.useEffect(() => {
        if (!open) return
        const onKeyDown = (event) => { if (event.key === 'Escape') hide() }
        const onScroll = () => hide()
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', hide)
        document.addEventListener('scroll', onScroll, true)
        return () => {
          window.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('resize', hide)
          document.removeEventListener('scroll', onScroll, true)
        }
      }, [open])

      return h(
        'span',
        {
          ref: anchor,
          style: { display: 'inline-flex', minWidth: 0, maxWidth: '100%' },
          onMouseEnter: schedule,
          onMouseLeave: hide,
        },
        props.children,
        open ? createPortal(h(
          'span',
          {
            ref: panel,
            id: tooltipId,
            role: 'tooltip',
            style: {
              position: 'fixed',
              zIndex: 1100,
              margin: 0,
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              padding: '4px 8px',
              borderRadius: '8px',
              background: '#292929',
              color: '#fff',
              fontSize: '13px',
              lineHeight: '18px',
              width: 'max-content',
              maxWidth: 'calc(100vw - 16px)',
              maxHeight: 'calc(100vh - 16px)',
              overflow: 'hidden',
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
              pointerEvents: 'none',
              top: position === null ? 0 : position.top,
              left: position === null ? 0 : position.left,
              visibility: position === null ? 'hidden' : 'visible',
            },
          },
          props.lines.map((line, index) => h('span', { key: index }, line)),
        ), anchor.current.ownerDocument.body) : null,
      )
    }

    /**
     * The dock reading: a wallet glyph, the balance word, and the spendable
     * amount. The billed-token projection re-reads the balance when a turn
     * settles; the full wallet breakdown is rendered by CreditTooltip and
     * repeated in the accessible name.
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
        CreditTooltip,
        { lines: reading.lines },
        h(
          'span',
          {
            className: 'credit-meter',
            'aria-label': reading.lines.join('. '),
            'data-credit-meter': reading.label,
            style: READING_STYLE,
          },
          WALLET_GLYPH,
          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, reading.label),
        ),
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
