# README

`versions.json` is the file that tells Nunjucks what version strings to append to client-side chibisafe assets (only crucial if you use [Cache-Control](#cache-control)).

To bump the version, it's recommended to use use `yarn bump-versions`.

```none
$ yarn bump-versions
$ node ./scripts/bump-versions.js
Bump version strings for client-side assets.

Usage:
node scripts/bump-versions.js <types>

types:
Space separated list of types (accepts 1 to 5).
1: CSS and JS files (chibisafe core assets + fontello.css).
2: Icons, images and config files (manifest.json, browserconfig.xml, etc).
3: CSS and JS files (libs from /public/libs, such as bulma, lazyload, etc).
4: Renders from /public/render/* directories (to be used with /src/js/misc/render.js).
5: Fontello font files.
a: Shortcut to update all types.
```

By default, running `yarn build` will also run `node ./scripts/bump-versions.js 1`.

## Fontello

`fontello.css` itself will use type 1, but its font files will use type 5.

Gulp will automatically append the version string into the built `fontello.css` in `dist` directory when running `yarn build` (or `dist-dev` when running `yarn develop`).

To bump type 5, you would have to run `yarn bump-versions 5`.

## Cache-Control

Version strings will NOT be used when `cacheControl` in `config.js` is not enabled, since they are only necessary when the assets are being cached indefinitely in browsers.

However, type 5 will still be appended to the built `fontello.css` if it exists in `versions.json` file.
