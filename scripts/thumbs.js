const path = require('path')
const paths = require('./../controllers/pathsController')
const utils = require('./../controllers/utilsController')

const self = {
  mode: null,
  mayGenerateThumb: extname => {
    return ([1, 3].includes(self.mode) && utils.imageExts.includes(extname)) ||
    ([2, 3].includes(self.mode) && utils.videoExts.includes(extname))
  },
  getFiles: async directory => {
    const names = await paths.readdir(directory)
    const files = []
    for (const name of names) {
      const lstat = await paths.lstat(path.join(directory, name))
      if (lstat.isFile() && !name.startsWith('.')) {
        files.push(name)
      }
    }
    return files
  }
}

;(async () => {
  const location = process.argv[1].replace(process.cwd() + '/', '')
  const args = process.argv.slice(2)

  self.mode = parseInt(args[0])
  const force = parseInt(args[1]) || 0
  const verbose = parseInt(args[2]) || 0
  const cfcache = parseInt(args[3]) || 0

  if (![1, 2, 3].includes(self.mode) ||
    ![0, 1].includes(force) ||
    ![0, 1, 2].includes(verbose) ||
    ![0, 1].includes(cfcache) ||
    args.includes('--help') ||
    args.includes('-h')) {
    return console.log(utils.stripIndents(`
      Generate thumbnails.

      Usage:
      node ${location} <mode=1|2|3> [force=0|1] [verbose=0|1] [cfcache=0|1]

      mode    : 1 = images only, 2 = videos only, 3 = both images and videos
      force   : 0 = no force (default), 1 = overwrite existing thumbnails
      verbose : 0 = only print missing thumbs (default), 1 = print all, 2 = print nothing
      cfcache : 0 = do not clear cloudflare cache (default), 1 = clear cloudflare cache
    `).trim())
  }

  console.log('Looking through existing thumbnails\u2026')
  const hrstart = process.hrtime()
  const uploads = await utils.db.table('files')
    .select('id', 'name')
  const thumbs = await self.getFiles(paths.thumbs)
    .then(thumbs => thumbs.map(thumb => {
      const extname = path.extname(thumb)
      return thumb.slice(0, -extname.length)
    }))

  console.log(`Found ${thumbs.length} existing thumbnails (may include placeholder symlinks).`)

  const succeeded = []
  let error = 0
  let exists = 0
  let skipped = 0

  const printProgress = () => {
    const done = succeeded.length + error + exists + skipped
    console.log(`PROGRESS: ${done}/${uploads.length}`)
    if (done >= uploads.length) clearInterval(progressInterval)
  }
  const progressInterval = setInterval(printProgress, 1000)
  printProgress()

  for (const upload of uploads) {
    const extname = utils.extname(upload.name)
    const basename = upload.name.slice(0, -extname.length)

    if (thumbs.includes(basename) && !force) {
      if (verbose === 1) {
        console.log(`${upload.name}: ALREADY EXISTS.`)
      }
      exists++
    } else if (!self.mayGenerateThumb(extname)) {
      if (verbose === 1) {
        console.log(`${upload.name}: EXTENSION SKIPPED.`)
      }
      skipped++
    } else {
      const start = Date.now()
      const generated = await utils.generateThumbs(upload.name, extname, force)
      if (verbose !== 2) {
        console.log(`${upload.name}: ${(Date.now() - start) / 1000}s: ${generated ? 'OK' : 'ERROR'}`)
      }
      generated ? succeeded.push({ upload, extname }) : error++
    }
  }

  clearInterval(progressInterval)
  printProgress()

  const hrend = process.hrtime(hrstart)
  console.log(utils.stripIndents(`
    ---
    Done in: ${(hrend[0] + (hrend[1] / 1e9)).toFixed(4)}s
    Success: ${succeeded.length}
    Error: ${error}
    Already exists: ${exists}
    Extension skipped: ${skipped}
    ---
  `).trim())

  if (cfcache && succeeded.length) {
    console.log('Purging Cloudflare\'s cache...')
    const results = await utils.purgeCloudflareCache(succeeded.map(data =>
      `thumbs/${data.upload.name.slice(0, -data.extname.length)}.png`
    ), true, false)
    for (let i = 0; i < results.length; i++) {
      if (results[i].errors.length) {
        results[i].errors.forEach(error => console.error(`CF: ${error}`))
      }
      console.log(`Status [${i}]: ${results[i].success ? 'OK' : 'ERROR'}`)
    }
  }
})()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
