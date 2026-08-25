# Dependency notes

Why the non-obvious entries in `package.json` exist, and what has to be true before
they can be removed. `package.json` is JSON and cannot hold comments, so this file
is the comment block.

## `overrides`

Two of these are load-bearing and two are inert. Do not delete any of them without
re-running the sweep at the bottom of this file.

| Override | Status | Why it exists | Exit condition |
| --- | --- | --- | --- |
| `postcss: ^8.5.18` | **Load-bearing** | Without it `next` resolves its own nested `postcss@8.4.31`, which carries 4 high advisories (GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q, GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849). The override collapses `next/node_modules/postcss` away so only the clean top-level copy is installed. | `next` ships a release depending on `postcss >= 8.5.23`. Re-check on every `next` bump. |
| `sharp: ^0.35.3` | **Load-bearing** | Without it, `next` pins `sharp@0.34.5`, which inherits libvips CVE-2026-33327 / -33328 / -35590 / -35591 (GHSA-f88m-g3jw-g9cj). | `next >= 16.3` stable, which pins a patched `sharp`. Drop it then. |
| `brace-expansion@^5.0.0: ^5.0.9` | Inert today | Natural resolution already lands on exactly `5.0.9`; the override currently changes nothing. Kept as a documented floor because this advisory has had its range **widened after the fact** before, silently un-fixing a pinned override. | Safe to remove, but there is no benefit in doing so. Leave it. |
| `js-yaml@^4.0.0: ^4.3.1` | Inert today | Same as above — resolution already lands on `4.3.1`. Scoped to `^4.0.0` deliberately so 3.x consumers are not force-upgraded. | Same as above. |

Both live overrides exist for the same reason: `next` pinning transitive dependencies
it has not yet updated. Removing all four reintroduces 3 high-severity advisories.

**Never run `npm audit fix --force`** — it "fixes" the tree by downgrading `next` to 14.
Plain `npm audit fix` is fine; it stays inside declared semver ranges.

An **override** is not the same thing as an **in-range lockfile bump**. An override asserts
compatibility the parent package never declared, and needs an exit condition. An in-range
bump just moves to a version the parent already allows and needs no justification — e.g.
`nanoid 3.3.16 -> 3.3.18` for GHSA-2v37-7h3g-55p8 satisfied postcss's existing `^3.3.16`
and required no override at all.

## `xlsx` is pinned to a URL, not a version range

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz"
```

This is deliberate and must not be "tidied" back into `^0.20.2`.

SheetJS stopped publishing to the npm registry. The newest `xlsx` on the registry is
**0.18.5** — abandoned, and carrying unpatched prototype-pollution and ReDoS advisories.
Versions 0.20.x exist only on `cdn.sheetjs.com`.

A `^0.20.2` range is therefore **unsatisfiable from the registry**. It previously appeared
to work only because the resolved CDN URL happened to be recorded in `package-lock.json`;
regenerating or losing the lock broke installs with `ETARGET`. Pinning the URL in
`package.json` makes resolution self-contained.

Note that `npm audit` cannot see this package at all — it is not registry-hosted, so it has
no advisory coverage. Check SheetJS release notes manually. 0.20.3 is available; treat any
version bump as a real change and test the EP LINC and AVC4 export paths, which depend on it.

## Checking whether an override still does anything

```sh
# from a scratch directory — never in the repo
cp package.json package-lock.json /some/scratch/ && cd /some/scratch
# KEEP the lockfile: without it, resolution fails on the xlsx CDN URL if that
# pin is ever reverted to a range
node -e "const p=require('./package.json'); delete p.overrides; \
  require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"
npm install --package-lock-only --ignore-scripts
npm audit
```

Diff the resolved versions against the real lockfile. Anything that resolves identically
with the override removed is inert. Re-run this whenever the override block is touched or
`next` is upgraded, so dead entries get retired instead of accumulating.

Capture `npm audit --json` as a baseline *before* any dependency change, so a new advisory
can be told apart from one the change introduced.
