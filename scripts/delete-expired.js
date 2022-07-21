const utils = require('./../controllers/utilsController')

;(async () => {
  const location = process.argv[1].replace(process.cwd() + '/', '')
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    return console.log(utils.stripIndents(`
      Bulk delete expired files.

      Usage:
      node ${location} [mode=0|1|2]

      mode:
      0 = Only list names of the expired files.
      1 = Delete expired files (output file names).
      2 = Delete expired files (no output).
    `).trim())
  }

  const mode = parseInt(args[0]) || 0
  const dryrun = mode === 0
  const quiet = mode === 2

  const result = await utils.bulkDeleteExpired(dryrun, true)

  if (quiet) return

  if (result.expired.length) {
    for (const expired of result.expired) {
      console.log(expired)
    }
  }
  console.log(`Expired files: ${result.expired.length}`)

  if (result.failed) {
    console.log('WARNING: Some expired files failed to delete!')
    for (const failed of result.failed) {
      console.log(failed)
    }
    console.log(`Failed to delete: ${result.failed.length}`)
  }
})()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
