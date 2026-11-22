# Publishing

The package is named `dsh-credit-meter` (unscoped, and free on npm when this
was prepared) and is publishable once the publisher identity and repository
URL are filled in.

## Before the first release

1. Set the publisher identity. `package.json` `author` and the `LICENSE`
   copyright line currently read `dsh-credit-meter contributors`; replace them
   with the organisation or person that owns the release.
2. Keep the `repository`, `homepage`, and `bugs` fields pointing at the GitHub
   repository; npm links the package page from them.
3. Keep README images on absolute URLs (the `raw.githubusercontent.com`
   addresses already there). npm renders the README from the published tarball
   with no repository context, so a relative path resolves to a 404 there even
   though GitHub shows it.
4. Check that `cordis.patch.yml` names the same package as `package.json`
   (`dsh-credit-meter`). A mismatch installs but never loads.
5. Choose the push identity (see below) and re-check the name on npm:
   `npm view dsh-credit-meter version` should still report 404.

Publishing under a scoped name instead (`@scope/dsh-credit-meter`) needs the
scope, `--access public`, and the same rename in `package.json` and
`cordis.patch.yml`.

## Identity and what stays public

Anyone can read this repository, and some identity cannot be removed by editing
files:

- **Commit author and committer** are part of every commit object, including
  the email address. Use an address owned by the project, not a personal one.
- **Who pushed** is recorded by GitHub in the public push event and the
  repository activity of a public repository. Pushing with a personal account
  shows that account even when the commit itself is authored by the project.
- **Pull requests, issues, and releases** belong to the account that opens them.
- **The npm publisher** appears in `maintainers` / "published by" permanently;
  the `author` field in `package.json` is a separate, editable value.

To keep a personal account out of all of these, push with a token or SSH key
that belongs to an organisation-owned machine account, and publish from that
account. Private membership of an organisation does not hide the items above.

## Release

```sh
npm login
npm whoami

npm pack --dry-run    # inspect what ships before publishing

npm publish           # add --access public only for a scoped name
npm view dsh-credit-meter version
```

The tarball should contain only `package.json`, `cordis.patch.yml`, `index.js`,
`client.js`, `icon.svg`, `docs/`, `locale/*.json`, `README.md`,
`README.zh.md`, and `LICENSE`. Anything else means the `files` list in
`package.json` needs attention.

## GitHub

```sh
git remote add origin https://github.com/ORG/dsh-credit-meter.git
git push -u origin main
git tag v1.0.0
git push --tags
```

Then create a release from the tag.

## Verify the published install

In DSH, use **Plugins → Add plugin** with `dsh-credit-meter@1.0.0`. Confirm the
plugin row appears with its icon and description, refresh the page, and check
that the reading appears in a session. Installing from the registry is the real
proof that the tarball is complete and self-contained.

## Later releases

```sh
npm version patch      # or minor / major
git push --follow-tags
npm publish
```

Users update the bundle from **Plugins**.

## Renaming later

Changing `name` in `package.json` also changes the row name in
`cordis.patch.yml`, and the installed profile still resolves the old name:
remove the old bundle, install this directory again, and refresh the page.
Restart DSH if it reports `restart-required`.

## What must never be published

`node_modules/`, `pnpm-lock.yaml`, `.npmrc`, `.env*`, logs, `dist/`, and packed
tarballs are ignored by `.gitignore`. Credentials belong in your environment,
never in this repository.
