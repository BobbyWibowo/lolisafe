const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const randomstring = require('randomstring')
const Zip = require('jszip')
const paths = require('./pathsController')
const perms = require('./permissionController')
const uploadController = require('./uploadController')
const utils = require('./utilsController')
const ClientError = require('./utils/ClientError')
const ServerError = require('./utils/ServerError')
const config = require('./../config')
const logger = require('./../logger')

const self = {
  // Don't forget to update max length of text inputs in
  // home.js & dashboard.js when changing these values
  titleMaxLength: 70,
  descMaxLength: 4000,

  onHold: new Set()
}

const homeDomain = utils.conf.homeDomain || utils.conf.domain

const zipMaxTotalSize = parseInt(config.cloudflare.zipMaxTotalSize)
const zipMaxTotalSizeBytes = zipMaxTotalSize * 1e6
const zipOptions = config.uploads.jsZipOptions

// Force 'type' option to 'nodebuffer'
zipOptions.type = 'nodebuffer'

// Apply fallbacks for missing config values
if (zipOptions.streamFiles === undefined) zipOptions.streamFiles = true
if (zipOptions.compression === undefined) zipOptions.compression = 'DEFLATE'
if (zipOptions.compressionOptions === undefined) zipOptions.compressionOptions = {}
if (zipOptions.compressionOptions.level === undefined) zipOptions.compressionOptions.level = 1

self.zipEmitters = new Map()

class ZipEmitter extends EventEmitter {
  constructor (identifier) {
    super()
    this.identifier = identifier
    this.once('done', () => self.zipEmitters.delete(this.identifier))
  }
}

self.getUniqueRandomName = async () => {
  for (let i = 0; i < utils.idMaxTries; i++) {
    const identifier = randomstring.generate(config.uploads.albumIdentifierLength)
    if (self.onHold.has(identifier)) continue

    // Put token on-hold (wait for it to be inserted to DB)
    self.onHold.add(identifier)

    const album = await utils.db.table('albums')
      .where('identifier', identifier)
      .select('id')
      .first()
    if (album) {
      self.onHold.delete(identifier)
      logger.log(`Album with identifier ${identifier} already exists (${i + 1}/${utils.idMaxTries}).`)
      continue
    }

    return identifier
  }

  throw new ServerError('Failed to allocate a unique identifier for the album. Try again?')
}

self.list = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const all = req.headers.all === '1'
    const simple = req.headers.simple
    const ismoderator = perms.is(user, 'moderator')
    if (all && !ismoderator) return res.status(403).end()

    const filter = function () {
      if (!all) {
        this.where({
          enabled: 1,
          userid: user.id
        })
      }
    }

    // Query albums count for pagination
    const count = await utils.db.table('albums')
      .where(filter)
      .count('id as count')
      .then(rows => rows[0].count)
    if (!count) return res.json({ success: true, albums: [], count })

    const fields = ['id', 'name']

    let albums
    if (simple) {
      albums = await utils.db.table('albums')
        .where(filter)
        .select(fields)

      return res.json({ success: true, albums, count })
    } else {
      let offset = Number(req.params.page)
      if (isNaN(offset)) offset = 0
      else if (offset < 0) offset = Math.max(0, Math.ceil(count / 25) + offset)

      fields.push('identifier', 'enabled', 'timestamp', 'editedAt', 'zipGeneratedAt', 'download', 'public', 'description')
      if (all) fields.push('userid')

      albums = await utils.db.table('albums')
        .where(filter)
        .limit(25)
        .offset(25 * offset)
        .select(fields)
    }

    const albumids = {}
    for (const album of albums) {
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
    }

    const getAlbumZipSize = async album => {
      if (!album.zipGeneratedAt) return
      try {
        const filePath = path.join(paths.zips, `${album.identifier}.zip`)
        const stats = await paths.stat(filePath)
        albumids[album.id].zipSize = stats.size
      } catch (error) {
        if (error.code !== 'ENOENT') logger.error(error)
      }
    }

    await Promise.all(albums.map(album => getAlbumZipSize(album)))

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
    if (!all) return res.json({ success: true, albums, count, homeDomain })

    // Otherwise proceed to querying usernames
    const userids = albums
      .map(album => album.userid)
      .filter((v, i, a) => {
        return v !== null && v !== undefined && v !== '' && a.indexOf(v) === i
      })

    // If there are no albums attached to a registered user, send response
    if (!userids.length) return res.json({ success: true, albums, count, homeDomain })

    // Query usernames of user IDs from currently selected files
    const usersTable = await utils.db.table('users')
      .whereIn('id', userids)
      .select('id', 'username')

    const users = {}
    for (const user of usersTable) {
      users[user.id] = user.username
    }

    await res.json({ success: true, albums, count, users, homeDomain })
  }).catch(next)
}

self.create = (req, res, next) => {
  Promise.resolve().then(async resolve => {
    const user = await utils.authorize(req)

    const name = typeof req.body.name === 'string'
      ? utils.escape(req.body.name.trim().substring(0, self.titleMaxLength))
      : ''

    if (!name) throw new ClientError('No album name specified.')

    const album = await utils.db.table('albums')
      .where({
        name,
        enabled: 1,
        userid: user.id
      })
      .first()

    if (album) throw new ClientError('Album name already in use.', { statusCode: 403 })

    const identifier = await self.getUniqueRandomName()

    const ids = await utils.db.table('albums').insert({
      name,
      enabled: 1,
      userid: user.id,
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
    self.onHold.delete(identifier)

    await res.json({ success: true, id: ids[0] })
  }).catch(next)
}

self.delete = (req, res, next) => {
  // Map /delete requests to /disable route
  req.body.del = true
  return self.disable(req, res, next)
}

self.disable = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const ismoderator = perms.is(user, 'moderator')

    const id = parseInt(req.body.id)
    if (isNaN(id)) throw new ClientError('No album specified.')

    const purge = req.body.purge
    const del = ismoderator ? req.body.del : false

    const filter = function () {
      this.where('id', id)

      if (!ismoderator) {
        this.andWhere({
          enabled: 1,
          userid: user.id
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
        const failed = await utils.bulkDeleteFromDb('id', ids, user)
        if (failed.length) return res.json({ success: false, failed })
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

    try {
      await paths.unlink(path.join(paths.zips, `${album.identifier}.zip`))
    } catch (error) {
      // Re-throw non-ENOENT error
      if (error.code !== 'ENOENT') throw error
    }
    await res.json({ success: true })
  }).catch(next)
}

self.edit = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const ismoderator = perms.is(user, 'moderator')

    const id = parseInt(req.body.id)
    if (isNaN(id)) throw new ClientError('No album specified.')

    const name = typeof req.body.name === 'string'
      ? utils.escape(req.body.name.trim().substring(0, self.titleMaxLength))
      : ''

    if (!name) throw new ClientError('No album name specified.')

    const filter = function () {
      this.where('id', id)

      if (!ismoderator) {
        this.andWhere({
          enabled: 1,
          userid: user.id
        })
      }
    }

    const album = await utils.db.table('albums')
      .where(filter)
      .first()

    if (!album) {
      throw new ClientError('Could not get album with the specified ID.')
    }

    const albumNewState = (ismoderator && typeof req.body.enabled !== 'undefined')
      ? Boolean(req.body.enabled)
      : null

    const nameInUse = await utils.db.table('albums')
      .where({
        name,
        enabled: 1,
        userid: user.id
      })
      .whereNot('id', id)
      .first()

    if ((album.enabled || (albumNewState === true)) && nameInUse) {
      if (req._old) {
        // Old rename API (stick with 200 status code for this)
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
      update.identifier = await self.getUniqueRandomName()
    }

    await utils.db.table('albums')
      .where(filter)
      .update(update)
    utils.deleteStoredAlbumRenders([id])
    utils.invalidateStatsCache('albums')

    if (req.body.requestLink) {
      self.onHold.delete(update.identifier)

      // Rename zip archive of the album if it exists
      try {
        const oldZip = path.join(paths.zips, `${album.identifier}.zip`)
        const newZip = path.join(paths.zips, `${update.identifier}.zip`)
        await paths.rename(oldZip, newZip)
      } catch (error) {
        // Re-throw non-ENOENT error
        if (error.code !== 'ENOENT') throw error
      }

      await res.json({
        success: true,
        identifier: update.identifier
      })
    } else {
      await res.json({ success: true, name })
    }
  }).catch(next)
}

self.rename = (req, res, next) => {
  req._old = true
  req.body = { name: req.body.name }
  return self.edit(req, res, next)
}

self.get = (req, res, next) => {
  Promise.resolve().then(async () => {
    const identifier = req.params.identifier
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
      if (req._upstreamCompat) {
        file.url = `${utils.conf.domain}/${file.name}`
      } else {
        file.file = `${utils.conf.domain}/${file.name}`
      }

      const extname = utils.extname(file.name)
      if (utils.mayGenerateThumb(extname)) {
        file.thumb = `${utils.conf.domain}/thumbs/${file.name.slice(0, -extname.length)}.png`
        if (req._upstreamCompat) file.thumbSquare = file.thumb
      }
    }

    await res.json({
      success: true,
      description: 'Successfully retrieved files.',
      title,
      download: Boolean(album.download),
      count: files.length,
      files
    })
  }).catch(next)
}

self.generateZip = (req, res, next) => {
  Promise.resolve().then(async () => {
    const versionString = parseInt(req.query.v)

    const identifier = req.params.identifier
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

    if (album.zipGeneratedAt > album.editedAt) {
      try {
        const filePath = path.join(paths.zips, `${identifier}.zip`)
        await paths.access(filePath)
        await res.download(filePath, `${album.name}.zip`)
        return
      } catch (error) {
        // Re-throw non-ENOENT error
        if (error.code !== 'ENOENT') throw error
      }
    }

    if (self.zipEmitters.has(identifier)) {
      return new Promise((resolve, reject) => {
        logger.log(`Waiting previous zip task for album: ${identifier}.`)
        self.zipEmitters.get(identifier).once('done', (filePath, fileName, clientErr) => {
          if (filePath && fileName) {
            resolve({ filePath, fileName })
          } else if (clientErr) {
            reject(clientErr)
          }
        })
      }).then(obj => {
        return res.download(obj.filePath, obj.fileName)
      })
    }

    self.zipEmitters.set(identifier, new ZipEmitter(identifier))

    logger.log(`Starting zip task for album: ${identifier}.`)

    const files = await utils.db.table('files')
      .select('name', 'size')
      .where('albumid', album.id)
    if (files.length === 0) {
      logger.log(`Finished zip task for album: ${identifier} (no files).`)
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
      // Since we are adding all files concurrently,
      // their order in the ZIP file may not be in alphabetical order.
      // However, ZIP viewers in general should sort the files themselves.
      await Promise.all(files.map(async file => {
        const data = await paths.readFile(path.join(paths.uploads, file.name))
        archive.file(file.name, data)
      }))
      await new Promise((resolve, reject) => {
        archive.generateNodeStream(zipOptions)
          .pipe(fs.createWriteStream(zipPath))
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

    const filePath = path.join(paths.zips, `${identifier}.zip`)
    const fileName = `${album.name}.zip`

    self.zipEmitters.get(identifier).emit('done', filePath, fileName)
    await res.download(filePath, fileName)
  }).catch(next)
}

self.listFiles = (req, res, next) => {
  if (req.params.page === undefined) {
    // Map to /api/album/get, but with lolisafe upstream compatibility, when accessed with this API route
    req.params.identifier = req.params.id
    delete req.params.id

    req._upstreamCompat = true
    res._json = res.json
    res.json = (body = {}) => {
      // Rebuild JSON payload to match lolisafe upstream
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

      if (rebuild.message) rebuild.message = rebuild.message.replace(/\.$/, '')
      return res._json(rebuild)
    }
    return self.get(req, res, next)
  } else {
    return uploadController.list(req, res, next)
  }
}

self.addFiles = (req, res, next) => {
  let ids, albumid, failed, albumids
  return Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    ids = req.body.ids
    if (!Array.isArray(ids) || !ids.length) {
      throw new ClientError('No files specified.')
    }

    albumid = parseInt(req.body.albumid)
    if (isNaN(albumid) || albumid < 0) albumid = null

    failed = []
    albumids = []
    if (albumid !== null) {
      const album = await utils.db.table('albums')
        .where('id', albumid)
        .where(function () {
          if (user.username !== 'root') {
            this.where('userid', user.id)
          }
        })
        .first()

      if (!album) {
        throw new ClientError('Album does not exist or it does not belong to the user.', { statusCode: 404 })
      }

      albumids.push(albumid)
    }

    const files = await utils.db.table('files')
      .whereIn('id', ids)
      .where('userid', user.id)

    failed = ids.filter(id => !files.find(file => file.id === id))

    await utils.db.table('files')
      .whereIn('id', files.map(file => file.id))
      .update('albumid', albumid)
    utils.invalidateStatsCache('albums')

    files.forEach(file => {
      if (file.albumid && !albumids.includes(file.albumid)) {
        albumids.push(file.albumid)
      }
    })

    await utils.db.table('albums')
      .whereIn('id', albumids)
      .update('editedAt', Math.floor(Date.now() / 1000))
    utils.deleteStoredAlbumRenders(albumids)

    await res.json({ success: true, failed })
  }).catch(error => {
    if (Array.isArray(failed) && (failed.length === ids.length)) {
      return next(new ServerError(`Could not ${albumid === null ? 'add' : 'remove'} any files ${albumid === null ? 'to' : 'from'} the album.`))
    } else {
      return next(error)
    }
  })
}

module.exports = self
