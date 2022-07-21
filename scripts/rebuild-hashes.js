const blake3 = require('blake3')
const fs = require('fs')
const path = require('path')
const paths = require('./../controllers/pathsController')
const utils = require('./../controllers/utilsController')

;(async () => {
  const location = process.argv[1].replace(process.cwd() + '/', '')
  const args = process.argv.slice(2)

  const mode = parseInt(args[0])

  if (![0, 1, 2].includes(mode) ||
    args.includes('--help') ||
    args.includes('-h')) {
    return console.log(utils.stripIndents(`
      Rebuild file hashes.

      Usage:
      node ${location} <mode=0|1|2>

      mode:
      0 = Dry run (recalculate hashes, print them, but do NOT store to DB).
      1 = Recalculate hashes and store to DB.
      2 = Verbose (recalculate hashes, print them, and store to DB).
    `).trim())
  }

  const dryrun = mode === 0
  const verbose = [0, 2].includes(mode)

  console.log('Querying uploads\u2026')
  const hrstart = process.hrtime()
  const uploads = await utils.db.table('files')
    .select('id', 'name', 'hash')
  console.log(`Uploads : ${uploads.length}`)

  let done = 0

  const printProgress = () => {
    console.log(`PROGRESS: ${done}/${uploads.length}`)
    if (done >= uploads.length) clearInterval(progressInterval)
  }
  const progressInterval = setInterval(printProgress, 1000)
  printProgress()

  for (const upload of uploads) {
    await new Promise((resolve, reject) => {
      fs.createReadStream(path.join(paths.uploads, upload.name))
        .on('error', reject)
        .pipe(blake3.createHash())
        .on('error', reject)
        .on('data', async source => {
          const hash = source.toString('hex')
          if (verbose) console.log(`${upload.name}: ${hash}`)
          if (!dryrun && upload.hash !== hash) {
            await utils.db.table('files')
              .update('hash', hash)
              .where('id', upload.id)
          }
          done++
          resolve()
        })
    }).catch(error => {
      console.log(`${upload.name}: ${error.toString()}`)
    })
  }

  clearInterval(progressInterval)
  printProgress()

  const hrend = process.hrtime(hrstart)
  console.log(`Done in : ${(hrend[0] + (hrend[1] / 1e9)).toFixed(4)}s`)
  if (dryrun) {
    console.log('INFO: This was a dry run. DB had not been modified.')
  }
})()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
