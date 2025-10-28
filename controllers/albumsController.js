const contentDisposition = require('content-disposition')
const EventEmitter = require('events')
const fsPromises = require('fs/promises')
const jetpack = require('fs-jetpack')
const path = require('path')
const randomstring = require('randomstring')
const Zip = require('jszip')
const paths = require('./pathsController')
const perms = require('./permissionController')
const utils = require('./utilsController')
const ServeStatic = require('./handlers/ServeStatic')
const ClientError = require('./utils/ClientError')
const ServerError = require('./utils/ServerError')
const config = require('./utils/ConfigManager')
const logger = require('./../logger')

const self = {
  // Don't forget to update max length of text inputs in
  // home.js & dashboard.js when changing these values
  titleMaxLength: 70,
  descMaxLength: 4000,

  onHold: new Set() // temporarily held random album identifiers
}

/** Preferences */

const homeDomain = config.homeDomain || config.domain

const albumsPerPage = config.dashboard
  ? Math.max(Math.min(config.dashboard.albumsPerPage || 0, 100), 1)
  : 25

const zipMaxTotalSize = parseInt(config.cloudflare.zipMaxTotalSize)
const zipMaxTotalSizeBytes = zipMaxTotalSize * 1e6
const zipOptions = config.uploads.jsZipOptions || {}

// Force 'type' option to 'nodebuffer'
zipOptions.type = 'nodebuffer'

// Apply fallbacks for missing config values
if (zipOptions.streamFiles === undefined) zipOptions.streamFiles = true
if (zipOptions.compression === undefined) zipOptions.compression = 'DEFLATE'
if (zipOptions.compressionOptions === undefined) zipOptions.compressionOptions = { level: 1 }

self.zipEmitters = new Map()

class ZipEmitter extends EventEmitter {
  constructor (identifier) {
    super()
    this.identifier = identifier
    this.once('done', () => self.zipEmitters.delete(this.identifier))
  }
}

// ServeStatic instance to handle downloading of album ZIP archives
const serveAlbumZipInstance = new ServeStatic(paths.zips)

self.getUniqueAlbumIdentifier = async res => {
  for (let i = 0; i < utils.idMaxTries; i++) {
    const identifier = randomstring.generate(config.uploads.albumIdentifierLength)

    if (self.onHold.has(identifier)) {
      logger.debug(`Identifier ${identifier} is currently held by another album (${i + 1}/${utils.idMaxTries}).`)
      continue
    }

    // Put token on-hold (wait for it to be inserted to DB)
    self.onHold.add(identifier)

    const album = await utils.db.table('albums')
      .where('identifier', identifier)
      .select('id')
      .first()
    if (album) {
      self.onHold.delete(identifier)
      logger.debug(`Album with identifier ${identifier} already exists (${i + 1}/${utils.idMaxTries}).`)
      continue
    }

    /*
    if (utils.devmode) {
      logger.debug(`albums.onHold: ${utils.inspect(self.onHold)}`)
    }
    */

    // Unhold identifier once the Response has been sent
    if (res) {
      // Keep in an array for future-proofing
      // if a single Request needs to generate multiple album identifiers
      if (!res.locals.identifiers) {
        res.locals.identifiers = []
        res.once('finish', () => { self.unholdAlbumIdentifiers(res) })
      }
      res.locals.identifiers.push(identifier)
    }

    return identifier
  }

  throw new ServerError('Failed to allocate a unique identifier for the album. Try again?')
}

self.unholdAlbumIdentifiers = res => {
  if (!res.locals.identifiers) return

  for (const identifier of res.locals.identifiers) {
    self.onHold.delete(identifier)

    /*
    if (utils.devmode) {
      logger.debug(`albums.onHold: ${utils.inspect(self.onHold)} -> ${utils.inspect(identifier)}`)
    }
    */
  }

  delete res.locals.identifiers
}

self.list = async (req, res) => {
  const all = req.headers.all === '1'
  const simple = req.headers.simple
  const ismoderator = perms.is(req.locals.user, 'moderator')
  if (all && !ismoderator) {
    return res.status(403).end()
  }

  const filter = function () {
    if (!all) {
      this.where({
        enabled: 1,
        userid: req.locals.user.id
      })
    }
  }

  // Base result object
  const result = { success: true, albums: [], albumsPerPage, count: 0, homeDomain }

  // If simple listing (for dashboard sidebar)
  if (simple) {
    result.albums = await utils.db.table('albums')
      .where(filter)
      .select('id', 'name')
    result.count = result.albums.length

    return res.json(result)
  }

  // Query albums count for pagination
  result.count = await utils.db.table('albums')
    .where(filter)
    .count('id as count')
    .then(rows => rows[0].count)
  if (!result.count) {
    return res.json(result)
  }

  let offset = req.path_parameters && Number(req.path_parameters.page)
  if (isNaN(offset)) {
    offset = 0
  } else if (offset < 0) {
    offset = Math.max(0, Math.ceil(result.count / albumsPerPage) + offset)
  }

  const fields = ['id', 'name', 'identifier', 'enabled', 'timestamp', 'editedAt', 'zipGeneratedAt', 'download', 'public', 'description']
  if (all) {
    fields.push('userid')
  }

  result.albums = await utils.db.table('albums')
    .where(filter)
    .limit(albumsPerPage)
    .offset(albumsPerPage * offset)
    .select(fields)

  const albumids = {}
  for (const album of result.albums) {
    album.download = album.download !== 0
    album.public = album.public !== 0
    album.uploads = 0
    album.size = 0
    album.zipSize = null
    album.descriptionHtml = album.description
      ? utils.md.instance.render(album.description)
      : ''

    // Map by IDs
    albumids[album.id] = album

    // Get ZIP size
    if (album.zipGeneratedAt) {
      const filePath = path.join(paths.zips, `${album.identifier}.zip`)
      const stats = await jetpack.inspectAsync(filePath)
      if (stats) {
        album.zipSize = stats.size
      }
    }
  }

  const uploads = await utils.db.table('files')
    .whereIn('albumid', Object.keys(albumids))
    .select('albumid', 'size')

  for (const upload of uploads) {
    if (albumids[upload.albumid]) {
      albumids[upload.albumid].uploads++
      albumids[upload.albumid].size += parseInt(upload.size)
    }
  }

  // If we are not listing all albums, send response
  if (!all) {
    return res.json(result)
  }

  // Otherwise proceed to querying usernames
  const userids = result.albums
    .map(album => album.userid)
    .filter(utils.filterUniquifySqlArray)

  // If there are no albums attached to a registered user, send response
  if (!userids.length) {
    return res.json(result)
  }

  // Query usernames of user IDs from currently selected files
  const usersTable = await utils.db.table('users')
    .whereIn('id', userids)
    .select('id', 'username')

  result.users = {}

  for (const user of usersTable) {
    result.users[user.id] = user.username
  }

  return res.json(result)
}

self.create = async (req, res) => {
  const name = typeof req.body.name === 'string'
    ? utils.escape(req.body.name.trim().substring(0, self.titleMaxLength))
    : ''

  if (!name) {
    throw new ClientError('No album name specified.')
  }

  const album = await utils.db.table('albums')
    .where({
      name,
      enabled: 1,
      userid: req.locals.user.id
    })
    .first()

  if (album) {
    throw new ClientError('Album name already in use.', { statusCode: 403 })
  }

  const identifier = await self.getUniqueAlbumIdentifier(res)

  const ids = await utils.db.table('albums')
    .insert({
      name,
      enabled: 1,
      userid: req.locals.user.id,
      identifier,
      timestamp: Math.floor(Date.now() / 1000),
      editedAt: 0,
      zipGeneratedAt: 0,
      download: (req.body.download === false || req.body.download === 0) ? 0 : 1,
      public: (req.body.public === false || req.body.public === 0) ? 0 : 1,
      description: typeof req.body.description === 'string'
        ? utils.escape(req.body.description.trim().substring(0, self.descMaxLength))
        : ''
    })

  utils.invalidateStatsCache('albums')

  return res.json({ success: true, id: ids[0] })
}

self.delete = async (req, res) => {
  // Re-map Request.body for .disable()
  req.body.del = true

  return self.disable(req, res)
}

self.disable = async (req, res) => {
  const ismoderator = perms.is(req.locals.user, 'moderator')

  const id = parseInt(req.body.id)
  if (isNaN(id)) {
    throw new ClientError('No album specified.')
  }

  const purge = req.body.purge

  // Only allow moderators to delete other users' albums
  const del = ismoderator ? req.body.del : false

  const filter = function () {
    this.where('id', id)

    // Only allow moderators to disable other users' albums
    if (!ismoderator) {
      this.andWhere({
        enabled: 1,
        userid: req.locals.user.id
      })
    }
  }

  const album = await utils.db.table('albums')
    .where(filter)
    .first()

  if (!album) {
    throw new ClientError('Could not get album with the specified ID.')
  }

  if (purge) {
    const files = await utils.db.table('files')
      .where({
        albumid: id,
        userid: album.userid
      })

    if (files.length) {
      const ids = files.map(file => file.id)
      const failed = await utils.bulkDeleteFromDb('id', ids, req.locals.user)
      if (failed.length) {
        return res.json({ success: false, failed })
      }
    }
    utils.invalidateStatsCache('uploads')
  }

  if (del) {
    await utils.db.table('albums')
      .where(filter)
      .first()
      .del()
  } else {
    await utils.db.table('albums')
      .where(filter)
      .first()
      .update('enabled', 0)
  }
  utils.deleteStoredAlbumRenders([id])
  utils.invalidateStatsCache('albums')

  await jetpack.removeAsync(path.join(paths.zips, `${album.identifier}.zip`))

  return res.json({ success: true })
}

self.edit = async (req, res) => {
  const ismoderator = perms.is(req.locals.user, 'moderator')

  const id = parseInt(req.body.id)
  if (isNaN(id)) {
    throw new ClientError('No album specified.')
  }

  const name = typeof req.body.name === 'string'
    ? utils.escape(req.body.name.trim().substring(0, self.titleMaxLength))
    : ''

  if (!name) {
    throw new ClientError('No album name specified.')
  }

  const filter = function () {
    this.where('id', id)

    // Only allow moderators to edit other users' albums
    if (!ismoderator) {
      this.andWhere({
        enabled: 1,
        userid: req.locals.user.id
      })
    }
  }

  const album = await utils.db.table('albums')
    .where(filter)
    .first()

  if (!album) {
    throw new ClientError('Could not get album with the specified ID.')
  }

  const albumNewState = (ismoderator && req.body.enabled !== undefined)
    ? Boolean(req.body.enabled)
    : null

  const nameInUse = await utils.db.table('albums')
    .where({
      name,
      enabled: 1,
      userid: req.locals.user.id
    })
    .whereNot('id', id)
    .first()

  if ((album.enabled || (albumNewState === true)) && nameInUse) {
    if (req._legacy) {
      // Legacy rename API (stick with 200 status code for this)
      throw new ClientError('You did not specify a new name.', { statusCode: 200 })
    } else {
      throw new ClientError('Album name already in use.', { statusCode: 403 })
    }
  }

  const update = {
    name,
    download: Boolean(req.body.download),
    public: Boolean(req.body.public),
    description: typeof req.body.description === 'string'
      ? utils.escape(req.body.description.trim().substring(0, self.descMaxLength))
      : ''
  }

  if (albumNewState !== null) {
    update.enabled = albumNewState
  }

  if (req.body.requestLink) {
    update.identifier = await self.getUniqueAlbumIdentifier(res)
  }

  await utils.db.table('albums')
    .where(filter)
    .update(update)

  utils.deleteStoredAlbumRenders([id])
  utils.invalidateStatsCache('albums')

  if (req.body.requestLink) {
    // Rename album ZIP if it exists
    const zipFullPath = path.join(paths.zips, `${album.identifier}.zip`)
    if (await jetpack.existsAsync(zipFullPath) === 'file') {
      await jetpack.renameAsync(zipFullPath, `${update.identifier}.zip`)
    }

    return res.json({
      success: true,
      identifier: update.identifier
    })
  } else {
    return res.json({ success: true, name: utils.unescape(name) })
  }
}

self.rename = async (req, res) => {
  // Re-map Request.body for .edit()
  req.body = {
    _legacy: true,
    name: req.body.name
  }

  return self.edit(req, res)
}

self.get = async (req, res) => {
  const identifier = req.path_parameters && req.path_parameters.identifier
  if (identifier === undefined) {
    throw new ClientError('No identifier provided.')
  }

  const album = await utils.db.table('albums')
    .where({
      identifier,
      enabled: 1
    })
    .first()

  if (!album || album.public === 0) {
    throw new ClientError('Album not found.', { statusCode: 404 })
  }

  const title = album.name
  const files = await utils.db.table('files')
    .select('name')
    .where('albumid', album.id)
    .orderBy('id', 'desc')

  for (const file of files) {
    if (req.locals.upstreamCompat) {
      file.url = `${config.domain}/${file.name}`
    } else {
      file.file = `${config.domain}/${file.name}`
    }

    const extname = utils.extname(file.name)
    if (utils.mayGenerateThumb(extname)) {
      let thumbext = '.png'
      if (utils.isAnimatedThumb(extname)) thumbext = '.gif'
      file.thumb = `${config.domain}/thumbs/${file.name.slice(0, -extname.length)}${thumbext}`
      /* // TODO: Upstream's API response is no longer identical to this.
      if (req.locals.upstreamCompat) {
        file.thumbSquare = file.thumb
      }
      */
    }
  }

  return res.json({
    success: true,
    description: 'Successfully retrieved files.',
    title,
    download: Boolean(album.download),
    count: files.length,
    files
  })
}

self.getUpstreamCompat = async (req, res) => {
  // If requested via /api/album/:identifier,
  // map to .get() with chibisafe/upstream compatibility
  // This API is known to be used in Pitu/Magane
  // TODO: Upstream's API response is no longer identical to this, please fix.
  req.locals.upstreamCompat = true

  res._json = res.json
  res.json = (body = {}) => {
    // Rebuild JSON payload to match chibisafe upstream
    const rebuild = {}
    const maps = {
      success: null,
      description: 'message',
      title: 'name',
      download: 'downloadEnabled',
      count: null
    }

    Object.keys(body).forEach(key => {
      if (maps[key] !== undefined) {
        if (maps[key]) rebuild[maps[key]] = body[key]
      } else {
        rebuild[key] = body[key]
      }
    })

    if (rebuild.message) {
      rebuild.message = rebuild.message.replace(/\.$/, '')
    }

    return res._json(rebuild)
  }

  return self.get(req, res)
}

self.generateZip = async (req, res) => {
  const versionString = parseInt(req.query_parameters.v)

  const identifier = req.path_parameters && req.path_parameters.identifier
  if (identifier === undefined) {
    throw new ClientError('No identifier provided.')
  }

  if (!config.uploads.generateZips) {
    throw new ClientError('ZIP generation disabled.', { statusCode: 403 })
  }

  const album = await utils.db.table('albums')
    .where({
      identifier,
      enabled: 1
    })
    .first()

  if (!album) {
    throw new ClientError('Album not found.', { statusCode: 404 })
  } else if (album.download === 0) {
    throw new ClientError('Download for this album is disabled.', { statusCode: 403 })
  }

  if ((isNaN(versionString) || versionString <= 0) && album.editedAt) {
    return res.redirect(`${album.identifier}?v=${album.editedAt}`)
  }

  // Downloading existing album ZIP archive if still valid
  if (album.zipGeneratedAt > album.editedAt) {
    try {
      const filePath = path.join(paths.zips, `${identifier}.zip`)
      const stat = await fsPromises.stat(filePath)
      return serveAlbumZipInstance.handle(req, res, filePath, stat, (req, res) => {
        res.header('Content-Disposition', contentDisposition(`${album.name}.zip`, { type: 'inline' }))
      })
    } catch (error) {
      // Re-throw non-ENOENT error
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  // If EventEmitter already exists for this album ZIP generation, wait for it
  if (self.zipEmitters.has(identifier)) {
    return new Promise((resolve, reject) => {
      logger.log(`Waiting previous zip task for album: ${identifier}.`)
      self.zipEmitters.get(identifier).once('done', (result, clientErr) => {
        if (clientErr || !result) {
          return reject(clientErr || new ServerError())
        }
        return resolve(result)
      })
    }).then(async result =>
      serveAlbumZipInstance.handle(req, res, result.path, result.stat, (req, res) => {
        res.header('Content-Disposition', contentDisposition(result.name, { type: 'inline' }))
      })
    )
  }

  // Create EventEmitter for this album ZIP generation
  self.zipEmitters.set(identifier, new ZipEmitter(identifier))

  logger.log(`Starting zip task for album: ${identifier}.`)

  const files = await utils.db.table('files')
    .select('name', 'size', 'timestamp')
    .where('albumid', album.id)
  if (files.length === 0) {
    logger.log(`Finished zip task for album: ${identifier} (no files).`)
    // Remove album ZIP if it exists
    await jetpack.removeAsync(path.join(paths.zips, `${identifier}.zip`))
    const clientErr = new ClientError('There are no files in the album.', { statusCode: 200 })
    self.zipEmitters.get(identifier).emit('done', null, null, clientErr)
    throw clientErr
  }

  if (zipMaxTotalSize) {
    const totalSizeBytes = files.reduce((accumulator, file) => accumulator + parseInt(file.size), 0)
    if (totalSizeBytes > zipMaxTotalSizeBytes) {
      logger.log(`Finished zip task for album: ${identifier} (size exceeds).`)
      const clientErr = new ClientError(`Total size of all files in the album exceeds ${zipMaxTotalSize} MB limit.`, { statusCode: 403 })
      self.zipEmitters.get(identifier).emit('done', null, null, clientErr)
      throw clientErr
    }
  }

  const zipPath = path.join(paths.zips, `${album.identifier}.zip`)
  const archive = new Zip()

  try {
    for (const file of files) {
      const fullPath = path.join(paths.uploads, file.name)
      archive.file(file.name, jetpack.createReadStream(fullPath), {
        // Use file's upload timestamp as file's modified time in the ZIP archive.
        // Timezone information does not seem to persist,
        // so the displayed modified time will likely always be in UTC+0.
        date: new Date(file.timestamp * 1000)
      })
    }
    await new Promise((resolve, reject) => {
      archive.generateNodeStream(zipOptions)
        .pipe(jetpack.createWriteStream(zipPath))
        .on('error', error => reject(error))
        .on('finish', () => resolve())
    })
  } catch (error) {
    logger.error(error)
    throw new ServerError(error.message)
  }

  logger.log(`Finished zip task for album: ${identifier} (success).`)

  await utils.db.table('albums')
    .where('id', album.id)
    .update('zipGeneratedAt', Math.floor(Date.now() / 1000))
  utils.invalidateStatsCache('albums')

  const result = {
    path: path.join(paths.zips, `${identifier}.zip`),
    name: `${album.name}.zip`
  }
  result.stat = await fsPromises.stat(result.path)

  // Notify all other awaiting Requests, if any
  self.zipEmitters.get(identifier).emit('done', result)

  // Conclude this Request by streaming the album ZIP archive
  return serveAlbumZipInstance.handle(req, res, result.path, result.stat, (req, res) => {
    res.header('Content-Disposition', contentDisposition(result.name, { type: 'inline' }))
  })
}

self.addFiles = async (req, res) => {
  const ids = req.body.ids
  if (!Array.isArray(ids) || !ids.length) {
    throw new ClientError('No files specified.')
  }

  const issuperadmin = perms.is(req.locals.user, 'superadmin')

  let albumid = parseInt(req.body.albumid)
  if (isNaN(albumid) || albumid < 0) {
    albumid = null
  }

  const failed = []
  const albumids = []

  // Wrap within a Promise then-async block for custom error handling
  return Promise.resolve().then(async () => {
    if (albumid !== null) {
      const album = await utils.db.table('albums')
        .where('id', albumid)
        .where(function () {
          // Only allow superadmins to arbitrarily add/remove files to/from any albums
          // NOTE: Dashboard does not facilitate this, intended for manual API calls
          if (!issuperadmin) {
            this.where('userid', req.locals.user.id)
          }
        })
        .first()

      if (!album) {
        throw new ClientError('Album does not exist or it does not belong to the user.', { statusCode: 404 })
      }

      // Insert this album's ID into "albumids" array to be updated later
      albumids.push(albumid)
    }

    // Query all owned files matching submitted IDs
    const files = await utils.db.table('files')
      .whereIn('id', ids)
      .where('userid', req.locals.user.id)

    // Push IDs not found in database into "failed" array
    failed.push(...ids.filter(id => !files.find(file => file.id === id)))

    await utils.db.transaction(async trx => {
      // Update files' associated album IDs
      await trx('files')
        .whereIn('id', files.map(file => file.id))
        .update('albumid', albumid)
      utils.invalidateStatsCache('albums')

      // Insert all previous albums' IDs into "albumids" array to be updated later
      files.forEach(file => {
        if (file.albumid && !albumids.includes(file.albumid)) {
          albumids.push(file.albumid)
        }
      })

      // Update all relevant albums' "editedAt" timestamp
      await trx('albums')
        .whereIn('id', albumids)
        .update('editedAt', Math.floor(Date.now() / 1000))
      utils.deleteStoredAlbumRenders(albumids)
    })

    return res.json({ success: true, failed })
  }).catch(error => {
    if (Array.isArray(failed) && (failed.length === ids.length)) {
      throw new ServerError(`Could not ${albumid === null ? 'add' : 'remove'} any files ${albumid === null ? 'to' : 'from'} the album.`)
    }
    throw error
  })
}

module.exports = self
