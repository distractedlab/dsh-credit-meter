# Credit meter

English | [Chinese](README.zh.md)

A DeepSeek Harness plugin that shows the remaining DeepSeek account credit as
one more reading in the composer dock — the row under the message input that
already carries activity, token usage, and the context meter.

![Recording of the credit reading in the composer dock](https://raw.githubusercontent.com/distractedlab/dsh-credit-meter/main/docs/preview.gif)

## What it shows

`Balance ¥1.91` next to a small wallet glyph; when both currencies hold money
it reads `Balance ¥1.91 · $5.00`. Hovering the reading, or reading it with a
screen reader, repeats the amount under its full label and lists the balances
behind it:

```
Available Balance ¥1.91 · $5.00
Top-up Balance ¥1.91
Top-up Balance $5.00
```

The labels are localized, so the reading follows the language of the UI.
The compact tooltip uses white text on a dark background. It opens above the
reading when space permits, otherwise below it.

## Where it appears

One entry in the session's composer dock, after the token-usage reading and
before the context meter. The value is account-wide, so switching sessions does
not change it.

DSH does not render the dock on a blank home screen, so the reading starts with
the first message of a session.

## When it refreshes

- When the session's billed tokens change — about two seconds after a step settles.
- Once a minute while the page is visible.
- Immediately when the window regains focus, and once on page load.

DeepSeek Platform can take a while to book a request into the balance it
reports, so a just-finished turn may still show the previous amount for up to
about a minute.

## What the number means

Platform reports one wallet per currency and keeps top-up and bonus balances
separate. The reading adds the top-up and bonus balances of the same currency,
then lists each funded currency on its own — CNY first, then USD — with no
currency conversion and no cross-currency sum:

- `Balance ¥1.91` when one currency holds money;
- `Balance ¥1.91 · $5.00` when both do;
- `<¥0.01` / `<$0.01` for a funded amount below one cent; a negative sub-cent
  amount reads `-<¥0.01`;
- one zero reading when every returned wallet is zero, or when a successful
  read returns no wallet: `Balance ¥0.00` when CNY was returned (or none),
  `Balance $0.00` when only USD was.

Amounts are truncated to two decimals in the same way the Platform Web client
shows them, with grouped digits. The tooltip shows the same amount under its
full label (`Available Balance`) and then lists each non-zero top-up and bonus
balance in the same CNY-then-USD order, so a bonus-only account reads
`Bonus Balance ¥2.00` there.

## Requirements

- DeepSeek Harness `0.2.2-rc.2` or a compatible release (`engines.dsh`).
- Signed in to a DeepSeek account in DSH.
- The Web GUI or the Desktop app.

## Install

From npm:

1. **Plugins → Add plugin**, then enter `dsh-credit-meter` to install the latest release.

From a local checkout (when developing the plugin):

1. Keep this directory where it is; DSH links it instead of copying it.
2. In DSH, open **Plugins → Add plugin** and choose this directory. The agent
   equivalent is `plugin_manager` with `install_bundle` and the absolute path.
3. Refresh the page once if it was already open, then send a message.

## Privacy

The reading comes from the same account query Settings → Account uses
(`ctx.remote.account.getBalance`). The plugin:

- never reads, copies, or stores the account token;
- sends no data anywhere else and adds no telemetry;
- keeps the last value in memory only, and drops it when the plugin is disabled.

Disabling the plugin in **Plugins** removes the reading and stops the queries.

## Limitations

- Display only: the reading has no click target and no top-up link.
- Refreshes on the cadence above, not continuously.
- Account-wide by design; it is not a per-session cost meter.
- A failed read keeps the last value and marks it stale in the tooltip.
- Nothing is shown before the first read completes, or while signed out.

## Development

There is no build step. `client.js` is the browser bundle DSH loads as-is: it
registers a lazy factory through `window.__ModuleLoader__.load` and resolves
React from the shell's module table.

```
.
├── package.json        package identity, bundle patch, client declaration
├── cordis.patch.yml    inserts the plugin row into the runtime
├── index.js            Host half (intentionally empty)
├── client.js           browser half: querying, formatting, dock entry
├── docs/               feature preview and detail document
├── locale/             plugin-page title and description
├── icon.svg            plugin-page icon
├── README.md           this file
├── README.zh.md        Chinese README
├── PUBLISHING.md       release checklist
└── LICENSE             MIT
```

After editing `client.js`, check it with `node --check client.js`. If the change
does not appear in DSH, reload the page.

## License

[MIT](LICENSE)
