const jetpack = require('fs-jetpack')
const perms = require('./../controllers/permissionController')
const config = require('./../controllers/utils/ConfigManager')

const map = {
  files: {
    expirydate: 'integer'
  },
  albums: {
    editedAt: 'integer',
    zipGeneratedAt: 'integer',
    download: 'integer',
    public: 'integer',
    description: 'string'
  },
  users: {
    enabled: 'integer',
    permission: 'integer',
    registration: 'integer'
  }
}

;(async () => {
  if (['better-sqlite3', 'sqlite3'].includes(config.database.client)) {
    if (!await jetpack.existsAsync(config.database.connection.filename)) {
      console.log('Sqlite3 database file missing. Assumes first install, migration skipped.')
      process.exit(0)
    }
  }

  const db = require('knex')(config.database)
  let done = 0

  const tableNames = Object.keys(map)
  for (const tableName of tableNames) {
    const columnNames = Object.keys(map[tableName])
    for (const columnName of columnNames) {
      if (await db.schema.hasColumn(tableName, columnName)) continue

      const columnType = map[tableName][columnName]
      await db.schema.table(tableName, table => {
        table[columnType](columnName)
      })
      console.log(`OK: ${tableName} <- ${columnName} (${columnType})`)
      done++
    }
  }

  if (config.superadminForcePromote) {
    if (!config.superadminAccount) {
      console.log('Attempting to promote superadmin user, but "superadminAccount" field is missing from config.')
      process.exit(0)
    }

    const superadminAccount = await db.table('users')
      .where('username', config.superadminAccount)
      .select('permission')
      .first()

    if (!superadminAccount) {
      console.log(`Superadmin account "${config.superadminAccount}" is not found in database.`)
      process.exit(0)
    }

    if (superadminAccount.permission !== perms.permissions.superadmin) {
      await db.table('users')
        .where('username', config.superadminAccount)
        .first()
        .update({
          permission: perms.permissions.superadmin
        })
        .then(result => {
          console.log(`Updated "${config.superadminAccount}"'s permission to ${perms.permissions.superadmin} (superadmin).`)
          done++
        })
    }
  }

  const filesOutdatedSize = await db.table('files')
    .where('size', 'like', '%.0')
  if (filesOutdatedSize.length) {
    console.log(`Found ${filesOutdatedSize.length} files with outdated "size" field, converting\u2026`)
    for (const file of filesOutdatedSize) {
      const size = file.size.replace(/\.0$/, '')
      await db.table('files')
        .update('size', size)
        .where('id', file.id)
      done++
    }
  }

  const filesMissingType = await db.table('files')
    .where('type', '')
    .orWhereNull('type')
  if (filesMissingType.length) {
    console.log(`Found ${filesMissingType.length} files with invalid "type" field, converting\u2026`)
    for (const file of filesMissingType) {
      await db.table('files')
        .update('type', 'application/octet-stream')
        .where('id', file.id)
      done++
    }
  }

  let status = 'Database migration was not required.'
  if (done) {
    status = `Completed ${done} database migration task(s).`
  }
  console.log(`${status} You may now start chibisafe normally.`)
})()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
