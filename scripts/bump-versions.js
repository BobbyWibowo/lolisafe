const jetpack = require('fs-jetpack')
const path = require('path')

const self = {
  // This is a parallel of utilsController.js->stripIndents().
  // Added here so that this script won't have to import the said controller.
  stripIndents: string => {
    if (!string) return
    const result = string.replace(/^[^\S\n]+/gm, '')
    const match = result.match(/^[^\S\n]*(?=\S)/gm)
    const indent = match && Math.min(...match.map(el => el.length))
    if (indent) {
      const regexp = new RegExp(`^.{${indent}}`, 'gm')
      return result.replace(regexp, '')
    }
    return result
  },
  types: null
}

;(async () => {
  const location = process.argv[1].replace(process.cwd() + '/', '')
  const args = process.argv.slice(2)

  const min = 1
  const max = 5

  self.types = {}
  for (const arg of args) {
    const lower = arg.toLowerCase()
    if (lower === 'a') {
      self.types = {}
      for (let i = min; i <= max; i++) {
        self.types[i] = ''
      }
      break
    }
    const parsed = parseInt(lower)
    // Only accept 1 to 4
    if (!isNaN(parsed) && parsed >= min && parsed <= max) {
      self.types[parsed] = ''
    }
  }

  if (args.includes('--help') || args.includes('-h') || !Object.keys(self.types).length) {
    return console.log(self.stripIndents(`
      Bump version strings for client-side assets.

      Usage:
      node ${location} <types>

      types:
      Space separated list of types (accepts ${min} to ${max}).
      1: CSS and JS files (chibisafe core assets + fontello.css).
      2: Icons, images and config files (manifest.json, browserconfig.xml, etc).
      3: CSS and JS files (libs from /public/libs, such as bulma, lazyload, etc).
      4: Renders from /public/render/* directories (to be used with /src/js/misc/render.js).
      5: Fontello font files.
      a: Shortcut to update all types.
    `).trim())
  }

  const file = path.resolve('./src/versions.json')

  // Create an empty file if it does not exist
  const exists = await jetpack.existsAsync(file)
  if (exists !== 'file') {
    await jetpack.writeAsync(file, '{}\n')
  }

  // Read & parse existing versions
  const old = await jetpack.readAsync(file, 'json')

  // Bump version of selected types
  // We use current timestamp cause it will always increase
  const types = Object.keys(self.types)
  const bumped = String(Math.floor(Date.now() / 1000)) // 1s precision
  for (const type of types) {
    self.types[type] = bumped
  }

  // Overwrite existing versions with new versions
  const data = Object.assign(old, self.types)

  // Stringify new versions
  const stringified = JSON.stringify(data, null, 2) + '\n'

  // Write to file
  await jetpack.writeAsync(file, stringified)
  console.log(`Successfully bumped version string of type ${types.join(', ')} to "${bumped}".`)
})()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
