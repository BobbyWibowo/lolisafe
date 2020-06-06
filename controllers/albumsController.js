const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const randomstring = require('randomstring')
const Zip = require('jszip')
const paths = require('./pathsController')
const perms = require('./permissionController')
const utils = require('./utilsController')
const config = require('./../config')
const logger = require('./../logger')
const db = require('knex')(config.database)

const self = {
  // Don't forget to update max length of text inputs in
  // home.js & dashboard.js when changing these values
  titleMaxLength: 70,
  descMaxLength: 4000,

  onHold: new Set()
}

const homeDomain = config.homeDomain || config.domain

const zipMaxTotalSize = parseInt(config.cloudflare.zipMaxTotalSize)
const zipMaxTotalSizeBytes = zipMaxTotalSize * 1e6
const zipOptions = config.uploads.jsZipOptions

// Force 'type' option to 'nodebuffer'
zipOptions.type = 'nodebuffer'

// Apply fallbacks for missing config values
if (zipOptions.streamFiles === undefined)
  zipOptions.streamFiles = true
if (zipOptions.compression === undefined)
  zipOptions.compression = 'DEFLATE'
if (zipOptions.compressionOptions === undefined)
  zipOptions.compressionOptions = {}
if (zipOptions.compressionOptions.level === undefined)
  zipOptions.compressionOptions.level = 1

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
    if (self.onHold.has(identifier))
      continue

    // Put token on-hold (wait for it to be inserted to DB)
    self.onHold.add(identifier)

    const album = await db.table('albums')
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

  throw 'Sorry, we could not allocate a unique random identifier. Try again?'
}

self.list = async (req, res, next) => {
  const user = await utils.authorize(req, res)
  if (!user) return

  const all = req.headers.all === '1'
  const sidebar = req.headers.sidebar
  const ismoderator = perms.is(user, 'moderator')
  if (all && !ismoderator)
    return res.status(403).end()

  const filter = function () {
    if (!all)
      this.where({
        enabled: 1,
        userid: user.id
      })
  }

  try {
    // Query albums count for pagination
    const count = await db.table('albums')
      .where(filter)
      .count('id as count')
      .then(rows => rows[0].count)
    if (!count)
      return res.json({ success: true, albums: [], count })

    let fields = ['id', 'name']

    let albums
    if (sidebar) {
      albums = await db.table('albums')
        .where(filter)
        .limit(9)
        .select(fields)

      return res.json({ success: true, albums, count })
    } else {
      let offset = Number(req.params.page)
      if (isNaN(offset)) offset = 0
      else if (offset < 0) offset = Math.max(0, Math.ceil(count / 25) + offset)

      fields = fields.concat(['identifier', 'enabled', 'timestamp', 'editedAt', 'download', 'public', 'description'])
      if (all)
        fields.push('userid')

      albums = await db.table('albums')
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

      // Map by IDs
      albumids[album.id] = album
    }

    const uploads = await db.table('files')
      .whereIn('albumid', Object.keys(albumids))
      .select('albumid')

    for (const upload of uploads)
      if (albumids[upload.albumid])
        albumids[upload.albumid].uploads++

    // If we are not listing all albums, send response
    if (!all)
      return res.json({ success: true, albums, count, homeDomain })

    // Otherwise proceed to querying usernames
    const userids = albums
      .map(album => album.userid)
      .filter((v, i, a) => {
        return v !== null && v !== undefined && v !== '' && a.indexOf(v) === i
      })

    // If there are no albums attached to a registered user, send response
    if (userids.length === 0)
      return res.json({ success: true, albums, count, homeDomain })

    // Query usernames of user IDs from currently selected files
    const usersTable = await db.table('users')
      .whereIn('id', userids)
      .select('id', 'username')

    const users = {}
    for (const user of usersTable)
      users[user.id] = user.username

    return res.json({ success: true, albums, count, users, homeDomain })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ success: false, description: 'An unexpected error occurred. Try again?' })
  }
}

self.create = async (req, res, next) => {
  const user = await utils.authorize(req, res)
  if (!user) return

  const name = typeof req.body.name === 'string'
    ? utils.escape(req.body.name.trim().substring(0, self.titleMaxLength))
    : ''

  if (!name)
    return res.json({ success: false, description: 'No album name specified.' })

  try {
    const album = await db.table('albums')
      .where({
        name,
        enabled: 1,
        userid: user.id
      })
      .first()

    if (album)
      return res.json({ success: false, description: 'There is already an album with that name.' })

    const identifier = await self.getUniqueRandomName()

    const ids = await db.table('albums').insert({
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

    return res.json({ success: true, id: ids[0] })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ success: false, description: 'An unexpected error occurred. Try again?' })
  }
}

self.delete = async (req, res, next) => {
  // Map /delete requests to /disable route
  return self.disable(req, res, next)
}

self.disable = async (req, res, next) => {
  const user = await utils.authorize(req, res)
  if (!user) return

  const id = req.body.id
  const purge = req.body.purge
  if (!Number.isFinite(id))
    return res.json({ success: false, description: 'No album specified.' })

  try {
    if (purge) {
      const files = await db.table('files')
        .where({
          albumid: id,
          userid: user.id
        })

      if (files.length) {
        const ids = files.map(file => file.id)
        const failed = await utils.bulkDeleteFromDb('id', ids, user)
        if (failed.length)
          return res.json({ success: false, failed })
      }
      utils.invalidateStatsCache('uploads')
    }

    await db.table('albums')
      .where({
        id,
        userid: user.id
      })
      .update('enabled', 0)
    utils.invalidateAlbumsCache([id])
    utils.invalidateStatsCache('albums')

    const identifier = await db.table('albums')
      .select('identifier')
      .where({
        id,
        userid: user.id
      })
      .first()
      .then(row => row.identifier)

    await paths.unlink(path.join(paths.zips, `${identifier}.zip`))
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger.error(error)
      return res.status(500).json({ success: false, description: 'An unexpected error occurred. Try again?' })
    }
  }

  return res.json({ success: true })
}

self.edit = async (req, res, next) => {
  const user = await utils.authorize(req, res)
  if (!user) return

  const ismoderator = perms.is(user, 'moderator')

  const id = parseInt(req.body.id)
  if (isNaN(id))
    return res.json({ success: false, description: 'No album specified.' })

  const name = typeof req.body.name === 'string'
    ? utils.escape(req.body.name.trim().substring(0, self.titleMaxLength))
    : ''

  if (!name)
    return res.json({ success: false, description: 'No name specified.' })

  const filter = function () {
    this.where('id', id)

    if (!ismoderator)
      this.andWhere({
        enabled: 1,
        userid: user.id
      })
  }

  try {
    const album = await db.table('albums')
      .where(filter)
      .first()

    if (!album)
      return res.json({ success: false, description: 'Could not get album with the specified ID.' })
    else if (album.id !== id)
      return res.json({ success: false, description: 'Name already in use.' })
    else if (req._old && (album.id === id))
      // Old rename API
      return res.json({ success: false, description: 'You did not specify a new name.' })

    const update = {
      name,
      download: Boolean(req.body.download),
      public: Boolean(req.body.public),
      description: typeof req.body.description === 'string'
        ? utils.escape(req.body.description.trim().substring(0, self.descMaxLength))
        : ''
    }

    if (ismoderator)
      update.enabled = Boolean(req.body.enabled)

    if (req.body.requestLink)
      update.identifier = await self.getUniqueRandomName()

    await db.table('albums')
      .where(filter)
      .update(update)
    utils.invalidateAlbumsCache([id])
    utils.invalidateStatsCache('albums')

    if (req.body.requestLink) {
      self.onHold.delete(update.identifier)

      // Rename zip archive of the album if it exists
      try {
        const oldZip = path.join(paths.zips, `${album.identifier}.zip`)
        const newZip = path.join(paths.zips, `${update.identifier}.zip`)
        await paths.rename(oldZip, newZip)
      } catch (err) {
        // Re-throw error
        if (err.code !== 'ENOENT')
          throw err
      }

      return res.json({
        success: true,
        identifier: update.identifier
      })
    } else {
      return res.json({ success: true, name })
    }
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ success: false, description: 'An unexpected error occurred. Try again?' })
  }
}

self.rename = async (req, res, next) => {
  req._old = true
  req.body = { name: req.body.name }
  return self.edit(req, res, next)
}

self.get = async (req, res, next) => {
  const identifier = req.params.identifier
  if (identifier === undefined)
    return res.status(401).json({ success: false, description: 'No identifier provided.' })

  try {
    const album = await db.table('albums')
      .where({
        identifier,
        enabled: 1
      })
      .first()

    if (!album)
      return res.json({
        success: false,
        description: 'Album not found.'
      })
    else if (album.public === 0)
      return res.status(403).json({
        success: false,
        description: 'This album is not available for public.'
      })

    const title = album.name
    const files = await db.table('files')
      .select('name')
      .where('albumid', album.id)
      .orderBy('id', 'desc')

    for (const file of files) {
      file.file = `${config.domain}/${file.name}`

      const extname = utils.extname(file.name)
      if (utils.mayGenerateThumb(extname))
        file.thumb = `${config.domain}/thumbs/${file.name.slice(0, -extname.length)}.png`
    }

    return res.json({
      success: true,
      title,
      count: files.length,
      files
    })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ success: false, description: 'An unexpected error occcured. Try again?' })
  }
}

self.generateZip = async (req, res, next) => {
  const versionString = parseInt(req.query.v)

  const identifier = req.params.identifier
  if (identifier === undefined)
    return res.status(401).json({
      success: false,
      description: 'No identifier provided.'
    })

  if (!config.uploads.generateZips)
    return res.status(401).json({
      success: false,
      description: 'Zip generation disabled.'
    })

  try {
    const album = await db.table('albums')
      .where({
        identifier,
        enabled: 1
      })
      .first()

    if (!album)
      return res.json({ success: false, description: 'Album not found.' })
    else if (album.download === 0)
      return res.json({ success: false, description: 'Download for this album is disabled.' })

    if ((isNaN(versionString) || versionString <= 0) && album.editedAt)
      return res.redirect(`${album.identifier}?v=${album.editedAt}`)

    if (album.zipGeneratedAt > album.editedAt)
      try {
        const filePath = path.join(paths.zips, `${identifier}.zip`)
        await paths.access(filePath)
        return res.download(filePath, `${album.name}.zip`)
      } catch (error) {
        // Re-throw error
        if (error.code !== 'ENOENT')
          throw error
      }

    if (self.zipEmitters.has(identifier)) {
      logger.log(`Waiting previous zip task for album: ${identifier}.`)
      return self.zipEmitters.get(identifier).once('done', (filePath, fileName, json) => {
        if (filePath && fileName)
          res.download(filePath, fileName)
        else if (json)
          res.json(json)
      })
    }

    self.zipEmitters.set(identifier, new ZipEmitter(identifier))

    logger.log(`Starting zip task for album: ${identifier}.`)

    const files = await db.table('files')
      .select('name', 'size')
      .where('albumid', album.id)
    if (files.length === 0) {
      logger.log(`Finished zip task for album: ${identifier} (no files).`)
      const json = {
        success: false,
        description: 'There are no files in the album.'
      }
      self.zipEmitters.get(identifier).emit('done', null, null, json)
      return res.json(json)
    }

    if (zipMaxTotalSize) {
      const totalSizeBytes = files.reduce((accumulator, file) => accumulator + parseInt(file.size), 0)
      if (totalSizeBytes > zipMaxTotalSizeBytes) {
        logger.log(`Finished zip task for album: ${identifier} (size exceeds).`)
        const json = {
          success: false,
          description: `Total size of all files in the album exceeds the configured limit (${zipMaxTotalSize} MB).`
        }
        self.zipEmitters.get(identifier).emit('done', null, null, json)
        return res.json(json)
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
      return res.status(500).json({
        success: 'false',
        description: error.toString()
      })
    }

    logger.log(`Finished zip task for album: ${identifier} (success).`)

    await db.table('albums')
      .where('id', album.id)
      .update('zipGeneratedAt', Math.floor(Date.now() / 1000))
    utils.invalidateStatsCache('albums')

    const filePath = path.join(paths.zips, `${identifier}.zip`)
    const fileName = `${album.name}.zip`

    self.zipEmitters.get(identifier).emit('done', filePath, fileName)
    return res.download(filePath, fileName)
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ success: false, description: 'An unexpected error occurred. Try again?' })
  }
}

self.addFiles = async (req, res, next) => {
  const user = await utils.authorize(req, res)
  if (!user) return

  const ids = req.body.ids
  if (!Array.isArray(ids) || !ids.length)
    return res.json({ success: false, description: 'No files specified.' })

  let albumid = parseInt(req.body.albumid)
  if (isNaN(albumid) || albumid < 0) albumid = null

  let failed = []
  const albumids = []
  try {
    if (albumid !== null) {
      const album = await db.table('albums')
        .where('id', albumid)
        .where(function () {
          if (user.username !== 'root')
            this.where('userid', user.id)
        })
        .first()

      if (!album)
        return res.json({
          success: false,
          description: 'Album does not exist or it does not belong to the user.'
        })

      albumids.push(albumid)
    }

    const files = await db.table('files')
      .whereIn('id', ids)
      .where('userid', user.id)

    failed = ids.filter(id => !files.find(file => file.id === id))

    await db.table('files')
      .whereIn('id', files.map(file => file.id))
      .update('albumid', albumid)

    files.forEach(file => {
      if (file.albumid && !albumids.includes(file.albumid))
        albumids.push(file.albumid)
    })

    await db.table('albums')
      .whereIn('id', albumids)
      .update('editedAt', Math.floor(Date.now() / 1000))
    utils.invalidateAlbumsCache(albumids)

    return res.json({ success: true, failed })
  } catch (error) {
    logger.error(error)
    if (failed.length === ids.length)
      return res.json({
        success: false,
        description: `Could not ${albumid === null ? 'add' : 'remove'} any files ${albumid === null ? 'to' : 'from'} the album.`
      })
    else
      return res.status(500).json({ success: false, description: 'An unexpected error occurred. Try again?' })
  }
}

module.exports = self
