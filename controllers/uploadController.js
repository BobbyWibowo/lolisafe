const blake3 = require('blake3')
const fetch = require('node-fetch')
const fs = require('fs')
const multer = require('multer')
const path = require('path')
const randomstring = require('randomstring')
const searchQuery = require('search-query-parser')
const paths = require('./pathsController')
const perms = require('./permissionController')
const utils = require('./utilsController')
const ClientError = require('./utils/ClientError')
const multerStorage = require('./utils/multerStorage')
const ServerError = require('./utils/ServerError')
const config = require('./../config')
const logger = require('./../logger')

const self = {
  onHold: new Set(),
  scanHelpers: {}
}

/** Preferences */

const fileIdentifierLengthFallback = 32
const fileIdentifierLengthChangeable = !config.uploads.fileIdentifierLength.force &&
  typeof config.uploads.fileIdentifierLength.min === 'number' &&
  typeof config.uploads.fileIdentifierLength.max === 'number'

const maxSize = parseInt(config.uploads.maxSize)
const maxSizeBytes = maxSize * 1e6
const urlMaxSize = parseInt(config.uploads.urlMaxSize)
const urlMaxSizeBytes = urlMaxSize * 1e6

const maxFilesPerUpload = 20

const chunkedUploads = config.uploads.chunkSize &&
  typeof config.uploads.chunkSize === 'object' &&
  config.uploads.chunkSize.default
const chunkedUploadsTimeout = config.uploads.chunkSize.timeout || 1800000
const chunksData = {}
// Hard-coded min chunk size of 1 MB (e.g. 50 MB = max 50 chunks)
const maxChunksCount = maxSize
// Use fs.copyFile() instead of fs.rename() if chunks dir is NOT inside uploads dir
const chunksCopyFile = !paths.chunks.startsWith(paths.uploads)

const extensionsFilter = Array.isArray(config.extensionsFilter) &&
  config.extensionsFilter.length
const urlExtensionsFilter = Array.isArray(config.uploads.urlExtensionsFilter) &&
  config.uploads.urlExtensionsFilter.length

/** Chunks helper class & function **/

class ChunksData {
  constructor (uuid, root) {
    this.uuid = uuid
    this.root = root
    this.filename = 'tmp'
    this.chunks = 0
    this.stream = null
    this.hasher = null
  }

  onTimeout () {
    self.cleanUpChunks(this.uuid)
  }

  setTimeout (delay) {
    this.clearTimeout()
    this._timeout = setTimeout(this.onTimeout.bind(this), delay)
  }

  clearTimeout () {
    if (this._timeout) {
      clearTimeout(this._timeout)
    }
  }
}

const initChunks = async uuid => {
  if (chunksData[uuid] === undefined) {
    const root = path.join(paths.chunks, uuid)
    try {
      await paths.access(root)
    } catch (err) {
      // Re-throw error
      if (err && err.code !== 'ENOENT') throw err
      await paths.mkdir(root)
    }
    chunksData[uuid] = new ChunksData(uuid, root)
  }
  chunksData[uuid].setTimeout(chunkedUploadsTimeout)
  return chunksData[uuid]
}

/** Multer */

const executeMulter = multer({
  // Guide: https://github.com/expressjs/multer/tree/v1.4.4#limits
  limits: {
    fileSize: maxSizeBytes,
    // Maximum number of non-file fields.
    // Dropzone.js will add 6 extra fields for chunked uploads.
    // We don't use them for anything else.
    fields: 6,
    // Maximum number of file fields.
    // Chunked uploads still need to provide ONLY 1 file field.
    // Otherwise, only one of the files will end up being properly stored,
    // and that will also be as a chunk.
    files: maxFilesPerUpload
  },
  fileFilter (req, file, cb) {
    // BUG: Since multer@1.4.5-lts.1, UTF-8 filenames are not handled properly, so we force it
    file.originalname = file.originalname &&
      Buffer.from(file.originalname, 'latin1').toString('utf8')

    file.extname = utils.extname(file.originalname)
    if (self.isExtensionFiltered(file.extname)) {
      return cb(new ClientError(`${file.extname ? `${file.extname.substr(1).toUpperCase()} files` : 'Files with no extension'} are not permitted.`))
    }

    // Re-map Dropzone chunked uploads keys so people can manually use the API without prepending 'dz'
    for (const key in req.body) {
      if (!/^dz/.test(key)) continue
      req.body[key.replace(/^dz/, '')] = req.body[key]
      delete req.body[key]
    }

    if (req.body.chunkindex !== undefined && !chunkedUploads) {
      return cb(new ClientError('Chunked uploads are disabled at the moment.'))
    } else {
      return cb(null, true)
    }
  },
  storage: multerStorage({
    destination (req, file, cb) {
      // Is file a chunk!?
      file._isChunk = chunkedUploads && req.body.uuid !== undefined && req.body.chunkindex !== undefined

      if (file._isChunk) {
        // Calling this will also reset its timeout
        initChunks(req.body.uuid)
          .then(chunksData => {
            file._chunksData = chunksData
            cb(null, chunksData.root)
          })
          .catch(error => {
            logger.error(error)
            return cb(new ServerError('Could not process the chunked upload. Try again?'))
          })
      } else {
        return cb(null, paths.uploads)
      }
    },

    filename (req, file, cb) {
      if (file._isChunk) {
        return cb(null, chunksData[req.body.uuid].filename)
      } else {
        const length = self.parseFileIdentifierLength(req.headers.filelength)
        return self.getUniqueRandomName(length, file.extname)
          .then(name => cb(null, name))
          .catch(error => cb(error))
      }
    },

    scan: utils.scan,
    scanHelpers: self.scanHelpers
  })
}).array('files[]')

/** Helper functions */

self.isExtensionFiltered = extname => {
  // If empty extension needs to be filtered
  if (!extname && config.filterNoExtension) return true

  // If there are extensions that have to be filtered
  if (extname && extensionsFilter) {
    const match = config.extensionsFilter.includes(extname.toLowerCase())
    const whitelist = config.extensionsFilterMode === 'whitelist'
    if ((!whitelist && match) || (whitelist && !match)) return true
  }

  return false
}

self.parseFileIdentifierLength = fileLength => {
  if (!config.uploads.fileIdentifierLength) return fileIdentifierLengthFallback

  const parsed = parseInt(fileLength)
  if (isNaN(parsed) ||
    !fileIdentifierLengthChangeable ||
    parsed < config.uploads.fileIdentifierLength.min ||
    parsed > config.uploads.fileIdentifierLength.max) {
    return config.uploads.fileIdentifierLength.default || fileIdentifierLengthFallback
  } else {
    return parsed
  }
}

self.getUniqueRandomName = async (length, extension) => {
  for (let i = 0; i < utils.idMaxTries; i++) {
    const identifier = randomstring.generate(length)
    const name = identifier + extension
    if (config.uploads.cacheFileIdentifiers) {
      if (utils.idSet.has(identifier)) {
        logger.log(`Identifier ${identifier} is already in use (${i + 1}/${utils.idMaxTries}).`)
        continue
      }
      utils.idSet.add(identifier)
      logger.debug(`Added ${identifier} to identifiers cache`)
    } else if (config.uploads.queryDbForFileCollisions) {
      if (self.onHold.has(identifier)) continue

      // Put token on-hold (wait for it to be inserted to DB)
      self.onHold.add(identifier)

      const file = await utils.db.table('files')
        .whereRaw('?? like ?', ['name', `${identifier}.%`])
        .select('id')
        .first()
      if (file) {
        self.onHold.delete(identifier)
        logger.log(`Identifier ${identifier} is already in use (${i + 1}/${utils.idMaxTries}).`)
        continue
      }
    } else {
      try {
        await paths.access(path.join(paths.uploads, name))
        logger.log(`${name} is already in use (${i + 1}/${utils.idMaxTries}).`)
        continue
      } catch (error) {
        // Re-throw non-ENOENT error
        if (error & error.code !== 'ENOENT') throw error
      }
    }
    return name
  }

  throw new ServerError('Failed to allocate a unique name for the upload. Try again?')
}

self.assertRetentionPeriod = (user, age) => {
  if (!utils.retentions.enabled) return null

  const group = user ? perms.group(user) : '_'
  if (!group || !utils.retentions.periods[group]) {
    throw new ClientError('You are not eligible for any file retention periods.', { statusCode: 403 })
  }

  let parsed = parseFloat(age)
  if (Number.isNaN(parsed) || age < 0) {
    parsed = utils.retentions.default[group]
  } else if (!utils.retentions.periods[group].includes(parsed)) {
    throw new ClientError('You are not eligible for the specified file retention period.', { statusCode: 403 })
  }

  if (!parsed && !utils.retentions.periods[group].includes(0)) {
    throw new ClientError('Permanent uploads are not permitted.', { statusCode: 403 })
  }

  return parsed
}

self.parseStripTags = stripTags => {
  if (!config.uploads.stripTags) return false

  if (config.uploads.stripTags.force || stripTags === undefined) {
    return config.uploads.stripTags.default
  }

  return Boolean(parseInt(stripTags))
}

/** Uploads */

self.upload = (req, res, next) => {
  Promise.resolve().then(async () => {
    let user
    if (config.private === true) {
      user = await utils.authorize(req)
    } else if (req.headers.token) {
      user = await utils.assertUser(req.headers.token)
    }

    if (config.privateUploadGroup) {
      if (!user || !perms.is(user, config.privateUploadGroup)) {
        throw new ClientError(config.privateUploadCustomResponse || 'Your usergroup is not permitted to upload new files.', { statusCode: 403 })
      }
    }

    let albumid = parseInt(req.headers.albumid || req.params.albumid)
    if (isNaN(albumid)) albumid = null

    const age = self.assertRetentionPeriod(user, req.headers.age)

    const func = req.body.urls ? self.actuallyUploadUrls : self.actuallyUploadFiles
    await func(req, res, user, albumid, age)
  }).catch(next)
}

self.actuallyUploadFiles = async (req, res, user, albumid, age) => {
  const error = await new Promise(resolve => {
    req._user = user
    return executeMulter(req, res, err => resolve(err))
  }).finally(() => delete req._user)

  if (error) {
    const suppress = [
      'LIMIT_FILE_SIZE',
      'LIMIT_UNEXPECTED_FILE'
    ]
    if (suppress.includes(error.code)) {
      throw new ClientError(error.toString())
    } else {
      throw error
    }
  }

  if (!req.files || !req.files.length) {
    throw new ClientError('No files.')
  }

  // If chunked uploads is enabled and the uploaded file is a chunk, then just say that it was a success
  const uuid = req.body.uuid
  if (chunkedUploads && chunksData[uuid] !== undefined) {
    req.files.forEach(file => {
      chunksData[uuid].chunks++
    })
    return res.json({ success: true })
  }

  const infoMap = req.files.map(file => {
    file.albumid = albumid
    file.age = age
    return {
      path: path.join(paths.uploads, file.filename),
      data: file
    }
  })

  if (config.filterEmptyFile && infoMap.some(file => file.data.size === 0)) {
    // Unlink all files when at least one file is an empty file
    // Should continue even when encountering errors
    await Promise.all(infoMap.map(info =>
      utils.unlinkFile(info.data.filename).catch(logger.error)
    ))

    throw new ClientError('Empty files are not allowed.')
  }

  if (utils.scan.instance) {
    let scanResult
    if (utils.scan.passthrough) {
      scanResult = await self.assertPassthroughScans(req, user, infoMap)
    } else {
      scanResult = await self.scanFiles(req, user, infoMap)
    }
    if (scanResult) {
      throw new ClientError(scanResult)
    }
  }

  await self.stripTags(req, infoMap)

  const result = await self.storeFilesToDb(req, res, user, infoMap)
  return self.sendUploadResponse(req, res, user, result)
}

/** URL uploads */

self.actuallyUploadUrls = async (req, res, user, albumid, age) => {
  if (!config.uploads.urlMaxSize) {
    throw new ClientError('Upload by URLs is disabled at the moment.', { statusCode: 403 })
  }

  const urls = req.body.urls
  if (!urls || !(urls instanceof Array)) {
    throw new ClientError('Missing "urls" property (array).')
  }

  if (urls.length > maxFilesPerUpload) {
    throw new ClientError(`Maximum ${maxFilesPerUpload} URLs at a time.`)
  }

  const assertSize = (size, isContentLength = false) => {
    if (config.filterEmptyFile && size === 0) {
      throw new ClientError('Empty files are not allowed.')
    } else if (size > urlMaxSizeBytes) {
      if (isContentLength) {
        throw new ClientError(`File too large. Content-Length header reports file is bigger than ${urlMaxSize} MB.`)
      } else {
        throw new ClientError(`File too large. File is bigger than ${urlMaxSize} MB.`)
      }
    }
  }

  const downloaded = []
  const infoMap = []
  try {
    await Promise.all(urls.map(async url => {
      let outStream
      let hasher
      try {
        const original = path.basename(url).split(/[?#]/)[0]
        const extname = utils.extname(original)

        // Extensions filter
        let filtered = false
        if (urlExtensionsFilter && ['blacklist', 'whitelist'].includes(config.uploads.urlExtensionsFilterMode)) {
          const match = config.uploads.urlExtensionsFilter.includes(extname.toLowerCase())
          const whitelist = config.uploads.urlExtensionsFilterMode === 'whitelist'
          filtered = ((!whitelist && match) || (whitelist && !match))
        } else {
          filtered = self.isExtensionFiltered(extname)
        }

        if (filtered) {
          throw new ClientError(`${extname ? `${extname.substr(1).toUpperCase()} files` : 'Files with no extension'} are not permitted.`)
        }

        if (config.uploads.urlProxy) {
          url = config.uploads.urlProxy
            .replace(/{url}/g, encodeURIComponent(url))
            .replace(/{url-noprot}/g, encodeURIComponent(url.replace(/^https?:\/\//, '')))
        }

        // Try to determine size early via Content-Length header,
        // but continue anyway if it isn't a valid number
        try {
          const head = await fetch(url, { method: 'HEAD', size: urlMaxSizeBytes })
          if (head.status === 200) {
            const contentLength = parseInt(head.headers.get('content-length'))
            if (!Number.isNaN(contentLength)) {
              assertSize(contentLength, true)
            }
          }
        } catch (ex) {
          // Re-throw only if ClientError, otherwise ignore
          if (ex instanceof ClientError) {
            throw ex
          }
        }

        const length = self.parseFileIdentifierLength(req.headers.filelength)
        const name = await self.getUniqueRandomName(length, extname)

        const destination = path.join(paths.uploads, name)
        outStream = fs.createWriteStream(destination)
        hasher = blake3.createHash()

        // Push to array early, so regardless of its progress it will be deleted on errors
        downloaded.push(destination)

        // Limit max response body size with maximum allowed size
        const fetchFile = await fetch(url, { method: 'GET', size: urlMaxSizeBytes })
          .then(res => new Promise((resolve, reject) => {
            if (res.status === 200) {
              outStream.on('error', reject)
              res.body.on('error', reject)
              res.body.on('data', d => hasher.update(d))

              res.body.pipe(outStream)
              outStream.on('finish', () => resolve(res))
            } else {
              resolve(res)
            }
          }))

        if (fetchFile.status !== 200) {
          throw new ServerError(`${fetchFile.status} ${fetchFile.statusText}`)
        }

        const contentType = fetchFile.headers.get('content-type')
        // Re-test size via actual bytes written to physical file
        assertSize(outStream.bytesWritten)

        infoMap.push({
          path: destination,
          data: {
            filename: name,
            originalname: original,
            extname,
            mimetype: contentType ? contentType.split(';')[0] : '',
            size: outStream.bytesWritten,
            hash: hasher.digest('hex'),
            albumid,
            age
          }
        })
      } catch (err) {
        // Dispose of unfinished write & hasher streams
        if (outStream && !outStream.destroyed) {
          outStream.destroy()
        }
        try {
          if (hasher) {
            hasher.dispose()
          }
        } catch (_) {}

        // Re-throw errors
        throw err
      }
    }))

    // If no errors encountered, clear cache of downloaded files
    downloaded.length = 0

    if (utils.scan.instance) {
      const scanResult = await self.scanFiles(req, user, infoMap)
      if (scanResult) throw new ClientError(scanResult)
    }

    const result = await self.storeFilesToDb(req, res, user, infoMap)
    await self.sendUploadResponse(req, res, user, result)
  } catch (error) {
    // Unlink all downloaded files when at least one file threw an error from the for-loop
    // Should continue even when encountering errors
    if (downloaded.length) {
      await Promise.all(downloaded.map(file =>
        utils.unlinkFile(file).catch(logger.error)
      ))
    }

    const errorString = error.toString()
    const suppress = [
      / over limit:/
    ]
    if (suppress.some(t => t.test(errorString))) {
      throw new ClientError(errorString)
    } else {
      throw error
    }
  }
}

/** Chunk uploads */

self.finishChunks = (req, res, next) => {
  Promise.resolve().then(async () => {
    if (!chunkedUploads) {
      throw new ClientError('Chunked upload is disabled.', { statusCode: 403 })
    }

    let user
    if (config.private === true) {
      user = await utils.authorize(req)
      if (!user) return
    } else if (req.headers.token) {
      user = await utils.assertUser(req.headers.token)
    }

    await self.actuallyFinishChunks(req, res, user)
  }).catch(next)
}

self.actuallyFinishChunks = async (req, res, user) => {
  const files = req.body.files
  if (!Array.isArray(files) || !files.length) {
    throw new ClientError('Bad request.')
  }

  const infoMap = []
  try {
    await Promise.all(files.map(async file => {
      if (!file.uuid || typeof chunksData[file.uuid] === 'undefined') {
        throw new ClientError('Invalid file UUID, or chunks data had already timed out. Try again?')
      }

      // Suspend timeout
      // If the chunk errors out there, it will be immediately cleaned up anyway
      chunksData[file.uuid].clearTimeout()

      // Conclude write and hasher streams
      chunksData[file.uuid].stream.end()
      const hash = chunksData[file.uuid].hasher.digest('hex')

      if (chunksData[file.uuid].chunks < 2 || chunksData[file.uuid].chunks > maxChunksCount) {
        throw new ClientError('Invalid chunks count.')
      }

      file.extname = typeof file.original === 'string' ? utils.extname(file.original) : ''
      if (self.isExtensionFiltered(file.extname)) {
        throw new ClientError(`${file.extname ? `${file.extname.substr(1).toUpperCase()} files` : 'Files with no extension'} are not permitted.`)
      }

      file.age = self.assertRetentionPeriod(user, file.age)

      file.size = chunksData[file.uuid].stream.bytesWritten
      if (config.filterEmptyFile && file.size === 0) {
        throw new ClientError('Empty files are not allowed.')
      } else if (file.size > maxSizeBytes) {
        throw new ClientError(`File too large. Chunks are bigger than ${maxSize} MB.`)
      }

      // Double-check file size
      const tmpfile = path.join(chunksData[file.uuid].root, chunksData[file.uuid].filename)
      const lstat = await paths.lstat(tmpfile)
      if (lstat.size !== file.size) {
        throw new ClientError(`File size mismatched (${lstat.size} vs. ${file.size}).`)
      }

      // Generate name
      const length = self.parseFileIdentifierLength(file.filelength)
      const name = await self.getUniqueRandomName(length, file.extname)

      // Move tmp file to final destination
      // For fs.copyFile(), tmpfile will eventually be unlinked by self.cleanUpChunks()
      const destination = path.join(paths.uploads, name)
      if (chunksCopyFile) {
        await paths.copyFile(tmpfile, destination)
      } else {
        await paths.rename(tmpfile, destination)
      }

      // Continue even when encountering errors
      await self.cleanUpChunks(file.uuid).catch(logger.error)

      let albumid = parseInt(file.albumid)
      if (isNaN(albumid)) albumid = null

      const data = {
        filename: name,
        originalname: file.original || '',
        extname: file.extname,
        mimetype: file.type || '',
        size: file.size,
        hash,
        albumid,
        age: file.age
      }

      infoMap.push({ path: destination, data })
    }))

    if (utils.scan.instance) {
      const scanResult = await self.scanFiles(req, user, infoMap)
      if (scanResult) throw new ClientError(scanResult)
    }

    await self.stripTags(req, infoMap)

    const result = await self.storeFilesToDb(req, res, user, infoMap)
    await self.sendUploadResponse(req, res, user, result)
  } catch (error) {
    // Should continue even when encountering errors
    files.forEach(file => {
      if (file.uuid && chunksData[file.uuid]) {
        self.cleanUpChunks(file.uuid).catch(logger.error)
      }
    })

    // Re-throw error
    throw error
  }
}

self.cleanUpChunks = async uuid => {
  // Dispose of unfinished write & hasher streams
  if (chunksData[uuid].stream && !chunksData[uuid].stream.destroyed) {
    chunksData[uuid].stream.destroy()
  }
  try {
    if (chunksData[uuid].hasher) {
      chunksData[uuid].hasher.dispose()
    }
  } catch (_) {}

  // Remove tmp file
  await paths.unlink(path.join(chunksData[uuid].root, chunksData[uuid].filename))
    .catch(error => {
      // Re-throw non-ENOENT error
      if (error.code !== 'ENOENT') logger.error(error)
    })

  // Remove UUID dir
  await paths.rmdir(chunksData[uuid].root)

  // Delete cached chunks data
  delete chunksData[uuid]
}

/** Virus scanning (ClamAV) */

self.scanHelpers.assertUserBypass = (user, filenames) => {
  if (!user || !utils.scan.groupBypass) return false
  if (!Array.isArray(filenames)) filenames = [filenames]
  logger.debug(`[ClamAV]: ${filenames.join(', ')}: Skipped, uploaded by ${user.username} (${utils.scan.groupBypass})`)
  return perms.is(user, utils.scan.groupBypass)
}

self.scanHelpers.assertFileBypass = data => {
  if (typeof data !== 'object' || !data.filename) return false

  const extname = data.extname || utils.extname(data.filename)
  if (utils.scan.whitelistExtensions && utils.scan.whitelistExtensions.includes(extname)) {
    logger.debug(`[ClamAV]: ${data.filename}: Skipped, extension whitelisted`)
    return true
  }

  if (utils.scan.maxSize && Number.isFinite(data.size) && data.size > utils.scan.maxSize) {
    logger.debug(`[ClamAV]: ${data.filename}: Skipped, size ${data.size} > ${utils.scan.maxSize}`)
    return true
  }

  return false
}

self.assertPassthroughScans = async (req, user, infoMap) => {
  const foundThreats = []
  const unableToScan = []

  for (const info of infoMap) {
    if (info.data.scan) {
      if (info.data.scan.isInfected) {
        logger.log(`[ClamAV]: ${info.data.filename}: ${info.data.scan.viruses.join(', ')}`)
        foundThreats.push(...info.data.scan.viruses)
      } else if (info.data.scan.isInfected === null) {
        logger.log(`[ClamAV]: ${info.data.filename}: Unable to scan`)
        unableToScan.push(info.data.filename)
      } else {
        logger.debug(`[ClamAV]: ${info.data.filename}: File is clean`)
      }
    }
  }

  let result = ''
  if (foundThreats.length) {
    const more = foundThreats.length > 1
    result = `Threat${more ? 's' : ''} detected: ${foundThreats[0]}${more ? ', and more' : ''}.`
  } else if (unableToScan.length) {
    const more = unableToScan.length > 1
    result = `Unable to scan: ${unableToScan[0]}${more ? ', and more' : ''}.`
  }

  if (result) {
    // Unlink all files when at least one threat is found
    // Should continue even when encountering errors
    await Promise.all(infoMap.map(info =>
      utils.unlinkFile(info.data.filename).catch(logger.error)
    ))
  }

  return result
}

self.scanFiles = async (req, user, infoMap) => {
  const filenames = infoMap.map(info => info.data.filename)
  if (self.scanHelpers.assertUserBypass(user, filenames)) {
    return false
  }

  const foundThreats = []
  const unableToScan = []
  const result = await Promise.all(infoMap.map(async info => {
    if (self.scanHelpers.assertFileBypass({
      filename: info.data.filename,
      extname: info.data.extname,
      size: info.data.size
    })) return

    logger.debug(`[ClamAV]: ${info.data.filename}: Scanning\u2026`)
    const response = await utils.scan.instance.isInfected(info.path)
    if (response.isInfected) {
      logger.log(`[ClamAV]: ${info.data.filename}: ${response.viruses.join(', ')}`)
      foundThreats.push(...response.viruses)
    } else if (response.isInfected === null) {
      logger.log(`[ClamAV]: ${info.data.filename}: Unable to scan`)
      unableToScan.push(info.data.filename)
    } else {
      logger.debug(`[ClamAV]: ${info.data.filename}: File is clean`)
    }
  })).then(() => {
    if (foundThreats.length) {
      const more = foundThreats.length > 1
      return `Threat${more ? 's' : ''} detected: ${foundThreats[0]}${more ? ', and more' : ''}.`
    } else if (unableToScan.length) {
      const more = unableToScan.length > 1
      return `Unable to scan: ${unableToScan[0]}${more ? ', and more' : ''}.`
    }
  }).catch(error => {
    logger.error(`[ClamAV]: ${filenames.join(', ')}: ${error.toString()}`)
    return 'An unexpected error occurred with ClamAV, please contact the site owner.'
  })

  if (result) {
    // Unlink all files when at least one threat is found OR any errors occurred
    // Should continue even when encountering errors
    await Promise.all(infoMap.map(info =>
      utils.unlinkFile(info.data.filename).catch(logger.error)
    ))
  }

  return result
}

/** Strip tags (EXIF, etc.) */

self.stripTags = async (req, infoMap) => {
  if (!self.parseStripTags(req.headers.striptags)) return

  try {
    await Promise.all(infoMap.map(info =>
      utils.stripTags(info.data.filename, info.data.extname)
    ))
  } catch (error) {
    // Unlink all files when at least one threat is found OR any errors occurred
    // Should continue even when encountering errors
    await Promise.all(infoMap.map(info =>
      utils.unlinkFile(info.data.filename).catch(logger.error)
    ))

    // Re-throw error
    throw error
  }
}

/** Database functions */

self.storeFilesToDb = async (req, res, user, infoMap) => {
  const files = []
  const exists = []
  const albumids = []

  await Promise.all(infoMap.map(async info => {
    // Check if the file exists by checking its hash and size
    const dbFile = await utils.db.table('files')
      .where(function () {
        if (user === undefined) {
          this.whereNull('userid')
        } else {
          this.where('userid', user.id)
        }
      })
      .where({
        hash: info.data.hash,
        size: String(info.data.size)
      })
      // Select expirydate to display expiration date of existing files as well
      .select('name', 'expirydate')
      .first()

    if (dbFile) {
      // Continue even when encountering errors
      await utils.unlinkFile(info.data.filename).catch(logger.error)
      logger.debug(`Unlinked ${info.data.filename} since a duplicate named ${dbFile.name} exists`)

      // If on /nojs route, append original file name reported by client
      if (req.path === '/nojs') {
        dbFile.original = info.data.originalname
      }

      exists.push(dbFile)
      return
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const data = {
      name: info.data.filename,
      original: info.data.originalname,
      type: info.data.mimetype,
      size: String(info.data.size),
      hash: info.data.hash,
      // Only disable if explicitly set to false in config
      ip: config.uploads.storeIP !== false ? req.ip : null,
      timestamp
    }

    if (user) {
      data.userid = user.id
      data.albumid = info.data.albumid
      if (data.albumid !== null && !albumids.includes(data.albumid)) {
        albumids.push(data.albumid)
      }
    }

    if (info.data.age) {
      data.expirydate = data.timestamp + (info.data.age * 3600) // Hours to seconds
    }

    files.push(data)

    // Generate thumbs, but do not wait
    if (utils.mayGenerateThumb(info.data.extname)) {
      utils.generateThumbs(info.data.filename, info.data.extname, true).catch(logger.error)
    }
  }))

  if (files.length) {
    let authorizedIds = []
    if (albumids.length) {
      authorizedIds = await utils.db.table('albums')
        .where({ userid: user.id })
        .whereIn('id', albumids)
        .select('id')
        .then(rows => rows.map(row => row.id))

      // Remove albumid if user do not own the album
      for (const file of files) {
        if (file.albumid !== null && !authorizedIds.includes(file.albumid)) {
          file.albumid = null
        }
      }
    }

    // Insert new files to DB
    await utils.db.table('files').insert(files)
    utils.invalidateStatsCache('uploads')

    if (config.uploads.queryDbForFileCollisions) {
      for (const file of files) {
        const extname = utils.extname(file.name)
        const identifier = file.name.slice(0, -(extname.length))
        self.onHold.delete(identifier)
      }
    }

    // Update albums' timestamp
    if (authorizedIds.length) {
      await utils.db.table('albums')
        .whereIn('id', authorizedIds)
        .update('editedAt', Math.floor(Date.now() / 1000))
      utils.deleteStoredAlbumRenders(authorizedIds)
    }
  }

  return [...files, ...exists]
}

/** Final response */

self.sendUploadResponse = async (req, res, user, result) => {
  // Send response
  return res.json({
    success: true,
    files: result.map(file => {
      const map = {
        name: file.name,
        url: `${utils.conf.domain ? `${utils.conf.domain}/` : ''}${file.name}`
      }

      // If a temporary upload, add expiry date
      if (file.expirydate) {
        map.expirydate = file.expirydate
      }

      // If on /nojs route, add original name
      if (req.path === '/nojs') {
        map.original = file.original
      }

      // If uploaded by user, add delete URL (intended for ShareX and its derivatives)
      // Homepage uploader will not use this (use dashboard instead)
      if (user) {
        map.deleteUrl = `${utils.conf.homeDomain}/file/${file.name}?delete`
      }

      return map
    })
  })
}

/** Delete uploads */

self.delete = async (req, res, next) => {
  // Map /api/delete requests to /api/bulkdelete
  let body
  if (req.method === 'POST') {
    // Original lolisafe API (this fork uses /api/bulkdelete immediately)
    const id = parseInt(req.body.id)
    body = {
      field: 'id',
      values: isNaN(id) ? undefined : [id]
    }
  }

  req.body = body
  return self.bulkDelete(req, res, next)
}

self.bulkDelete = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const field = req.body.field || 'id'
    const values = req.body.values

    if (!Array.isArray(values) || !values.length) {
      throw new ClientError('No array of files specified.')
    }

    const failed = await utils.bulkDeleteFromDb(field, values, user)
    await res.json({ success: true, failed })
  }).catch(next)
}

/** List uploads */

self.list = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const all = req.headers.all === '1'
    const filters = req.headers.filters
    const minoffset = Number(req.headers.minoffset) || 0
    const ismoderator = perms.is(user, 'moderator')
    if (all && !ismoderator) return res.status(403).end()

    const basedomain = utils.conf.domain

    // Thresholds for regular users
    const MAX_WILDCARDS_IN_KEY = 2
    const MAX_TEXT_QUERIES = 3 // non-keyed keywords
    const MAX_SORT_KEYS = 1
    const MAX_IS_KEYS = 1

    const filterObj = {
      uploaders: [],
      excludeUploaders: [],
      queries: {
        exclude: {}
      },
      typeIs: [
        'image',
        'video',
        'audio'
      ],
      flags: {}
    }

    const sortObj = {
      // Cast columns to specific type if they are stored differently
      casts: {
        size: 'integer'
      },
      // Columns mapping
      maps: {
        date: 'timestamp',
        expiry: 'expirydate',
        originalname: 'original'
      },
      // Columns with which to use SQLite's NULLS LAST option
      nullsLast: [
        'userid',
        'expirydate',
        'ip'
      ],
      parsed: []
    }

    // Parse glob wildcards into SQL wildcards
    function sqlLikeParser (pattern) {
      // Escape SQL operators
      const escaped = pattern
        .replace(/(?<!\\)%/g, '\\%')
        .replace(/(?<!\\)_/g, '\\_')

      // Look for any glob operators
      const match = pattern.match(/(?<!\\)(\*|\?)/g)
      if (match && match.length) {
        return {
          count: match.length,
          // Replace glob operators with their SQL equivalents
          escaped: escaped
            .replace(/(?<!\\)\*/g, '%')
            .replace(/(?<!\\)\?/g, '_')
        }
      } else {
        return {
          count: 0,
          // Assume partial match
          escaped: `%${escaped}%`
        }
      }
    }

    if (filters) {
      const keywords = []

      if (req.params.id === undefined) keywords.push('albumid')

      // Only allow filtering by 'ip' and 'user' keys when listing all uploads
      if (all) keywords.push('ip', 'user')

      const ranges = [
        'date',
        'expiry'
      ]

      keywords.push('is', 'sort', 'orderby')
      filterObj.queries = searchQuery.parse(filters, {
        keywords,
        ranges,
        tokenize: true,
        alwaysArray: true,
        offsets: false
      })

      // Accept orderby as alternative for sort
      if (filterObj.queries.orderby) {
        if (!filterObj.queries.sort) filterObj.queries.sort = []
        filterObj.queries.sort.push(...filterObj.queries.orderby)
        delete filterObj.queries.orderby
      }

      // For some reason, single value won't be in Array even with 'alwaysArray' option
      if (typeof filterObj.queries.exclude.text === 'string') {
        filterObj.queries.exclude.text = [filterObj.queries.exclude.text]
      }

      // Text (non-keyed keywords) queries
      let textQueries = 0
      if (filterObj.queries.text) textQueries += filterObj.queries.text.length
      if (filterObj.queries.exclude.text) textQueries += filterObj.queries.exclude.text.length

      // Regular user threshold check
      if (!ismoderator && textQueries > MAX_TEXT_QUERIES) {
        throw new ClientError(`Users are only allowed to use ${MAX_TEXT_QUERIES} non-keyed keyword${MAX_TEXT_QUERIES === 1 ? '' : 's'} at a time.`)
      }

      if (filterObj.queries.text) {
        for (let i = 0; i < filterObj.queries.text.length; i++) {
          const result = sqlLikeParser(filterObj.queries.text[i])
          if (!ismoderator && result.count > MAX_WILDCARDS_IN_KEY) {
            throw new ClientError(`Users are only allowed to use ${MAX_WILDCARDS_IN_KEY} wildcard${MAX_WILDCARDS_IN_KEY === 1 ? '' : 's'} per key.`)
          }
          filterObj.queries.text[i] = result.escaped
        }
      }

      if (filterObj.queries.exclude.text) {
        for (let i = 0; i < filterObj.queries.exclude.text.length; i++) {
          const result = sqlLikeParser(filterObj.queries.exclude.text[i])
          if (!ismoderator && result.count > MAX_WILDCARDS_IN_KEY) {
            throw new ClientError(`Users are only allowed to use ${MAX_WILDCARDS_IN_KEY} wildcard${MAX_WILDCARDS_IN_KEY === 1 ? '' : 's'} per key.`)
          }
          filterObj.queries.exclude.text[i] = result.escaped
        }
      }

      for (const key of keywords) {
        let queryIndex = -1
        let excludeIndex = -1

        // Make sure keyword arrays only contain unique values
        if (filterObj.queries[key]) {
          filterObj.queries[key] = filterObj.queries[key].filter((v, i, a) => a.indexOf(v) === i)
          queryIndex = filterObj.queries[key].indexOf('-')
        }
        if (filterObj.queries.exclude[key]) {
          filterObj.queries.exclude[key] = filterObj.queries.exclude[key].filter((v, i, a) => a.indexOf(v) === i)
          excludeIndex = filterObj.queries.exclude[key].indexOf('-')
        }

        // Flag to match NULL values
        const inQuery = queryIndex !== -1
        const inExclude = excludeIndex !== -1
        if (inQuery || inExclude) {
          // Prioritize exclude keys when both types found
          filterObj.flags[`${key}Null`] = inExclude ? false : inQuery
          if (inQuery) {
            if (filterObj.queries[key].length === 1) {
              // Delete key to avoid unexpected behavior
              delete filterObj.queries[key]
            } else {
              filterObj.queries[key].splice(queryIndex, 1)
            }
          }
          if (inExclude) {
            if (filterObj.queries.exclude[key].length === 1) {
              // Delete key to avoid unexpected behavior
              delete filterObj.queries.exclude[key]
            } else {
              filterObj.queries.exclude[key].splice(excludeIndex, 1)
            }
          }
        }
      }

      const parseDate = (date, minoffset, resetMs) => {
        // [YYYY][/MM][/DD] [HH][:MM][:SS]
        // e.g. 2020/01/01 00:00:00, 2018/01/01 06, 2019/11, 12:34:00
        const match = date.match(/^(\d{4})?(\/\d{2})?(\/\d{2})?\s?(\d{2})?(:\d{2})?(:\d{2})?$/)

        if (match) {
          let offset = 0
          if (minoffset !== undefined) {
            offset = 60000 * (utils.timezoneOffset - minoffset)
          }

          const dateObj = new Date(Date.now() + offset)

          if (match[1] !== undefined) {
            dateObj.setFullYear(Number(match[1]), // full year
              match[2] !== undefined ? (Number(match[2].slice(1)) - 1) : 0, // month, zero-based
              match[3] !== undefined ? Number(match[3].slice(1)) : 1) // date
          }

          if (match[4] !== undefined) {
            dateObj.setHours(Number(match[4]), // hours
              match[5] !== undefined ? Number(match[5].slice(1)) : 0, // minutes
              match[6] !== undefined ? Number(match[6].slice(1)) : 0) // seconds
          }

          if (resetMs) {
            dateObj.setMilliseconds(0)
          }

          // Calculate timezone differences
          return new Date(dateObj.getTime() - offset)
        } else {
          return null
        }
      }

      // Parse dates to timestamps
      for (const range of ranges) {
        if (filterObj.queries[range]) {
          if (filterObj.queries[range].from) {
            const parsed = parseDate(filterObj.queries[range].from, minoffset, true)
            filterObj.queries[range].from = parsed ? Math.floor(parsed / 1000) : null
          }
          if (filterObj.queries[range].to) {
            const parsed = parseDate(filterObj.queries[range].to, minoffset, true)
            filterObj.queries[range].to = parsed ? Math.ceil(parsed / 1000) : null
          }
        }
      }

      // Query users table for user IDs
      if (filterObj.queries.user || filterObj.queries.exclude.user) {
        const usernames = []
        if (filterObj.queries.user) {
          usernames.push(...filterObj.queries.user)
        }
        if (filterObj.queries.exclude.user) {
          usernames.push(...filterObj.queries.exclude.user)
        }

        const uploaders = await utils.db.table('users')
          .whereIn('username', usernames)
          .select('id', 'username')

        // If no matches, or mismatched results
        if (!uploaders || (uploaders.length !== usernames.length)) {
          const notFound = usernames.filter(username => {
            return !uploaders.find(uploader => uploader.username === username)
          })
          if (notFound) {
            throw new ClientError(`User${notFound.length === 1 ? '' : 's'} not found: ${notFound.join(', ')}.`)
          }
        }

        for (const uploader of uploaders) {
          if (filterObj.queries.user && filterObj.queries.user.includes(uploader.username)) {
            filterObj.uploaders.push(uploader)
          } else {
            filterObj.excludeUploaders.push(uploader)
          }
        }

        // Delete keys to avoid unexpected behavior
        delete filterObj.queries.user
        delete filterObj.queries.exclude.user
      }

      // Parse sort keys
      if (filterObj.queries.sort) {
        const allowed = [
          'expirydate',
          'id',
          'name',
          'original',
          'size',
          'timestamp'
        ]

        // Only allow sorting by 'albumid' when not listing album's uploads
        if (req.params.id === undefined) allowed.push('albumid')

        // Only allow sorting by 'ip' and 'userid' columns when listing all uploads
        if (all) allowed.push('ip', 'userid')

        for (const obQuery of filterObj.queries.sort) {
          const tmp = obQuery.toLowerCase().split(':')
          const column = sortObj.maps[tmp[0]] || tmp[0]

          if (!allowed.includes(column)) {
            // Alert users if using disallowed/missing columns
            throw new ClientError(`Column "${column}" cannot be used for sorting.\n\nTry the following instead:\n${allowed.join(', ')}`)
          }

          sortObj.parsed.push({
            column,
            order: (tmp[1] && /^d/.test(tmp[1])) ? 'desc' : 'asc',
            clause: sortObj.nullsLast.includes(column) ? 'nulls last' : '',
            cast: sortObj.casts[column] || null
          })
        }

        // Regular user threshold check
        if (!ismoderator && sortObj.parsed.length > MAX_SORT_KEYS) {
          throw new ClientError(`Users are only allowed to use ${MAX_SORT_KEYS} sort key${MAX_SORT_KEYS === 1 ? '' : 's'} at a time.`)
        }

        // Delete key to avoid unexpected behavior
        delete filterObj.queries.sort
      }

      // Parse is keys
      let isKeys = 0
      let isLast
      if (filterObj.queries.is || filterObj.queries.exclude.is) {
        for (const type of filterObj.typeIs) {
          const inQuery = filterObj.queries.is && filterObj.queries.is.includes(type)
          const inExclude = filterObj.queries.exclude.is && filterObj.queries.exclude.is.includes(type)

          // Prioritize exclude keys when both types found
          if (inQuery || inExclude) {
            filterObj.flags[`is${type}`] = inExclude ? false : inQuery
            if (isLast !== undefined && isLast !== filterObj.flags[`is${type}`]) {
              throw new ClientError('Cannot mix inclusion and exclusion type-is keys.')
            }
            isKeys++
            isLast = filterObj.flags[`is${type}`]
          }
        }

        // Delete keys to avoid unexpected behavior
        delete filterObj.queries.is
        delete filterObj.queries.exclude.is
      }

      // Regular user threshold check
      if (!ismoderator && isKeys > MAX_IS_KEYS) {
        throw new ClientError(`Users are only allowed to use ${MAX_IS_KEYS} type-is key${MAX_IS_KEYS === 1 ? '' : 's'} at a time.`)
      }
    }

    function filter () {
      // If listing all uploads
      if (all) {
        this.where(function () {
          // Filter uploads matching any of the supplied 'user' keys and/or NULL flag
          // Prioritze exclude keys when both types found
          this.orWhere(function () {
            if (filterObj.excludeUploaders.length) {
              this.whereNotIn('userid', filterObj.excludeUploaders.map(v => v.id))
            } else if (filterObj.uploaders.length) {
              this.orWhereIn('userid', filterObj.uploaders.map(v => v.id))
            }
            // Such overbearing logic for NULL values, smh...
            if ((filterObj.excludeUploaders.length && filterObj.flags.userNull !== false) ||
            (filterObj.uploaders.length && filterObj.flags.userNull) ||
            (!filterObj.excludeUploaders.length && !filterObj.uploaders.length && filterObj.flags.userNull)) {
              this.orWhereNull('userid')
            } else if (filterObj.flags.userNull === false) {
              this.whereNotNull('userid')
            }
          })

          // Filter uploads matching any of the supplied 'ip' keys and/or NULL flag
          // Same prioritization logic as above
          this.orWhere(function () {
            if (filterObj.queries.exclude.ip) {
              this.whereNotIn('ip', filterObj.queries.exclude.ip)
            } else if (filterObj.queries.ip) {
              this.orWhereIn('ip', filterObj.queries.ip)
            }
            // ...
            if ((filterObj.queries.exclude.ip && filterObj.flags.ipNull !== false) ||
            (filterObj.queries.ip && filterObj.flags.ipNull) ||
            (!filterObj.queries.exclude.ip && !filterObj.queries.ip && filterObj.flags.ipNull)) {
              this.orWhereNull('ip')
            } else if (filterObj.flags.ipNull === false) {
              this.whereNotNull('ip')
            }
          })
        })
      } else {
        // If not listing all uploads, list user's uploads
        this.where('userid', user.id)
      }

      // Then, refine using any of the supplied 'albumid' keys and/or NULL flag
      // Same prioritization logic as 'userid' and 'ip' above
      if (req.params.id === undefined) {
        this.andWhere(function () {
          if (filterObj.queries.exclude.albumid) {
            this.whereNotIn('albumid', filterObj.queries.exclude.albumid)
          } else if (filterObj.queries.albumid) {
            this.orWhereIn('albumid', filterObj.queries.albumid)
          }
          // ...
          if ((filterObj.queries.exclude.albumid && filterObj.flags.albumidNull !== false) ||
          (filterObj.queries.albumid && filterObj.flags.albumidNull) ||
          (!filterObj.queries.exclude.albumid && !filterObj.queries.albumid && filterObj.flags.albumidNull)) {
            this.orWhereNull('albumid')
          } else if (filterObj.flags.albumidNull === false) {
            this.whereNotNull('albumid')
          }
        })
      } else if (!all) {
        // If not listing all uploads, list uploads from user's album
        this.andWhere('albumid', req.params.id)
      }

      // Then, refine using the supplied 'date' ranges
      this.andWhere(function () {
        if (!filterObj.queries.date || (!filterObj.queries.date.from && !filterObj.queries.date.to)) return
        if (typeof filterObj.queries.date.from === 'number') {
          if (typeof filterObj.queries.date.to === 'number') {
            this.andWhereBetween('timestamp', [filterObj.queries.date.from, filterObj.queries.date.to])
          } else {
            this.andWhere('timestamp', '>=', filterObj.queries.date.from)
          }
        } else {
          this.andWhere('timestamp', '<=', filterObj.queries.date.to)
        }
      })

      // Then, refine using the supplied 'expiry' ranges
      this.andWhere(function () {
        if (!filterObj.queries.expiry || (!filterObj.queries.expiry.from && !filterObj.queries.expiry.to)) return
        if (typeof filterObj.queries.expiry.from === 'number') {
          if (typeof filterObj.queries.expiry.to === 'number') {
            this.andWhereBetween('expirydate', [filterObj.queries.expiry.from, filterObj.queries.expiry.to])
          } else {
            this.andWhere('expirydate', '>=', filterObj.queries.expiry.from)
          }
        } else {
          this.andWhere('expirydate', '<=', filterObj.queries.expiry.to)
        }
      })

      // Then, refine using type-is flags
      this.andWhere(function () {
        for (const type of filterObj.typeIs) {
          let func
          let operator
          if (filterObj.flags[`is${type}`] === true) {
            func = 'orWhere'
            operator = 'like'
          } else if (filterObj.flags[`is${type}`] === false) {
            func = 'andWhere'
            operator = 'not like'
          }

          if (func) {
            for (const pattern of utils[`${type}Exts`].map(ext => `%${ext}`)) {
              this[func]('name', operator, pattern)
            }
          }
        }
      })

      // Then, refine using the supplied keywords against their file names
      this.andWhere(function () {
        if (!filterObj.queries.text) return
        for (const pattern of filterObj.queries.text) {
          this.orWhereRaw('?? like ? escape ?', ['name', pattern, '\\'])
          this.orWhereRaw('?? like ? escape ?', ['original', pattern, '\\'])
        }
      })

      // Finally, refine using the supplied exclusions against their file names
      this.andWhere(function () {
        if (!filterObj.queries.exclude.text) return
        for (const pattern of filterObj.queries.exclude.text) {
          this.andWhereRaw('?? not like ? escape ?', ['name', pattern, '\\'])
          this.andWhereRaw('?? not like ? escape ?', ['original', pattern, '\\'])
        }
      })
    }

    // Query uploads count for pagination
    const count = await utils.db.table('files')
      .where(filter)
      .count('id as count')
      .then(rows => rows[0].count)
    if (!count) return res.json({ success: true, files: [], count })

    let offset = Number(req.params.page)
    if (isNaN(offset)) offset = 0
    else if (offset < 0) offset = Math.max(0, Math.ceil(count / 25) + offset)

    const columns = ['id', 'name', 'original', 'userid', 'size', 'timestamp']
    if (utils.retentions.enabled) columns.push('expirydate')
    if (!all ||
      filterObj.queries.albumid ||
      filterObj.queries.exclude.albumid ||
      filterObj.flags.albumidNull !== undefined) columns.push('albumid')

    // Only select IPs if we are listing all uploads
    if (all) columns.push('ip')

    // Build raw query for order by (sorting) operation
    let orderByRaw
    if (sortObj.parsed.length) {
      orderByRaw = sortObj.parsed.map(sort => {
        // Use Knex.raw() to sanitize user inputs
        if (sort.cast) {
          return utils.db.raw(`cast (?? as ${sort.cast}) ${sort.order} ${sort.clause}`.trim(), sort.column)
        } else {
          return utils.db.raw(`?? ${sort.order} ${sort.clause}`.trim(), sort.column)
        }
      }).join(', ')
    } else {
      orderByRaw = '`id` desc'
    }

    const files = await utils.db.table('files')
      .where(filter)
      .orderByRaw(orderByRaw)
      .limit(25)
      .offset(25 * offset)
      .select(columns)

    if (!files.length) return res.json({ success: true, files, count, basedomain })

    for (const file of files) {
      file.extname = utils.extname(file.name)
      if (utils.mayGenerateThumb(file.extname)) {
        file.thumb = `thumbs/${file.name.slice(0, -file.extname.length)}.png`
      }
    }

    // If we queried albumid, query album names
    let albums = {}
    if (columns.includes('albumid')) {
      const albumids = files
        .map(file => file.albumid)
        .filter((v, i, a) => {
          return v !== null && v !== undefined && v !== '' && a.indexOf(v) === i
        })
      albums = await utils.db.table('albums')
        .whereIn('id', albumids)
        .where('enabled', 1)
        .select('id', 'name')
        .then(rows => {
          // Build Object indexed by their IDs
          const obj = {}
          for (const row of rows) {
            obj[row.id] = row.name
          }
          return obj
        })
    }

    // If we are not listing all uploads, send response
    if (!all) return res.json({ success: true, files, count, albums, basedomain })

    // Otherwise proceed to querying usernames
    let usersTable = filterObj.uploaders
    if (!usersTable.length) {
      const userids = files
        .map(file => file.userid)
        .filter((v, i, a) => {
          return v !== null && v !== undefined && v !== '' && a.indexOf(v) === i
        })

      // If there are no uploads attached to a registered user, send response
      if (!userids.length) return res.json({ success: true, files, count, albums, basedomain })

      // Query usernames of user IDs from currently selected files
      usersTable = await utils.db.table('users')
        .whereIn('id', userids)
        .select('id', 'username')
    }

    const users = {}
    for (const user of usersTable) {
      users[user.id] = user.username
    }

    await res.json({ success: true, files, count, users, albums, basedomain })
  }).catch(next)
}

/** Get file info */

self.get = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)
    const ismoderator = perms.is(user, 'moderator')

    const identifier = req.params.identifier
    if (identifier === undefined) {
      throw new ClientError('No identifier provided.')
    }

    const file = await utils.db.table('files')
      .where('name', identifier)
      .where(function () {
        if (!ismoderator) {
          this.where('userid', user.id)
        }
      })
      .first()

    if (!file) {
      throw new ClientError('File not found.', { statusCode: 404 })
    }

    await res.json({ success: true, file })
  }).catch(next)
}

module.exports = self
