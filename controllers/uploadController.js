const config = require('./../config')
const crypto = require('crypto')
const db = require('knex')(config.database)
const fs = require('fs')
const multer = require('multer')
const path = require('path')
const pce = require('path-complete-extname')
const randomstring = require('randomstring')
const snekfetch = require('snekfetch')
const utils = require('./utilsController')

const uploadsController = {}

const maxTries = config.uploads.maxTries || 1
const uploadsDir = path.join(__dirname, '..', config.uploads.folder)
const chunkedUploads = Boolean(config.uploads.chunkSize)
const chunksDir = path.join(uploadsDir, 'chunks')
const maxSize = config.uploads.maxSize
const maxSizeBytes = parseInt(maxSize) * 1000000
const urlMaxSizeBytes = parseInt(config.uploads.urlMaxSize) * 1000000

const storage = multer.diskStorage({
  destination (req, file, cb) {
    // If chunked uploads is disabled or the uploaded file is not a chunk
    if (!chunkedUploads || (req.body.uuid === undefined && req.body.chunkindex === undefined)) {
      return cb(null, uploadsDir)
    }

    const uuidDir = path.join(chunksDir, req.body.uuid)
    fs.access(uuidDir, error => {
      if (!error) { return cb(null, uuidDir) }
      fs.mkdir(uuidDir, error => {
        if (!error) { return cb(null, uuidDir) }
        console.error(error)
        // eslint-disable-next-line standard/no-callback-literal
        return cb('Could not process the chunked upload. Try again?')
      })
    })
  },
  filename (req, file, cb) {
    // If chunked uploads is disabled or the uploaded file is not a chunk
    if (!chunkedUploads || (req.body.uuid === undefined && req.body.chunkindex === undefined)) {
      const extension = pce(file.originalname).toLowerCase()
      const length = uploadsController.getFileNameLength(req)
      return uploadsController.getUniqueRandomName(length, extension)
        .then(name => cb(null, name))
        .catch(error => cb(error))
    }

    // index.extension (e.i. 0, 1, ..., n - will prepend zeros depending on the amount of chunks)
    const digits = req.body.totalchunkcount !== undefined ? String(req.body.totalchunkcount - 1).length : 1
    const zeros = new Array(digits + 1).join('0')
    const name = (zeros + req.body.chunkindex).slice(-digits)
    return cb(null, name)
  }
})

const upload = multer({
  storage,
  limits: {
    fileSize: maxSizeBytes
  },
  fileFilter (req, file, cb) {
    const extname = pce(file.originalname).toLowerCase()
    if (uploadsController.isExtensionFiltered(extname)) {
      // eslint-disable-next-line standard/no-callback-literal
      return cb(`${extname.substr(1).toUpperCase()} files are not permitted due to security reasons.`)
    }

    // Re-map Dropzone keys so people can manually use the API without prepending 'dz'
    for (const key in req.body) {
      if (!/^dz/.test(key)) { continue }
      req.body[key.replace(/^dz/, '')] = req.body[key]
      delete req.body[key]
    }

    if (req.body.chunkindex) {
      if (chunkedUploads && parseInt(req.body.totalfilesize) > maxSizeBytes) {
        // This will not be true if "totalfilesize" key does not exist, since "NaN > number" is false.
        // eslint-disable-next-line standard/no-callback-literal
        return cb('Chunk error occurred. Total file size is larger than the maximum file size.')
      } else if (!chunkedUploads) {
        // eslint-disable-next-line standard/no-callback-literal
        return cb('Chunked uploads is disabled at the moment.')
      }
    }

    return cb(null, true)
  }
}).array('files[]')

uploadsController.isExtensionFiltered = extname => {
  // If there are extensions that have to be filtered
  if (config.extensionsFilter && config.extensionsFilter.length) {
    const match = config.extensionsFilter.some(extension => extname === extension.toLowerCase())
    if ((config.filterBlacklist && match) || (!config.filterBlacklist && !match)) {
      return true
    }
  }
  return false
}

uploadsController.getFileNameLength = req => {
  // If the user has a preferred file length, make sure it is within the allowed range
  if (req.headers.filelength) {
    return Math.min(Math.max(req.headers.filelength, config.uploads.fileLength.min), config.uploads.fileLength.max)
  }

  // Let's default it to 32 characters when config key is falsy
  return config.uploads.fileLength.default || 32
}

uploadsController.getUniqueRandomName = (length, extension) => {
  return new Promise((resolve, reject) => {
    const access = i => {
      const name = randomstring.generate(length) + extension
      fs.access(path.join(uploadsDir, name), error => {
        if (error) { return resolve(name) }
        console.log(`A file named ${name} already exists (${++i}/${maxTries}).`)
        if (i < maxTries) { return access(i) }
        // eslint-disable-next-line prefer-promise-reject-errors
        return reject('Sorry, we could not allocate a unique random name. Try again?')
      })
    }
    access(0)
  })
}

uploadsController.upload = async (req, res, next) => {
  let user
  if (config.private === true) {
    user = await utils.authorize(req, res)
    if (!user) { return }
  } else if (req.headers.token) {
    user = await db.table('users').where('token', req.headers.token).first()
  }

  if (user && (user.enabled === false || user.enabled === 0)) {
    return res.json({ success: false, description: 'This account has been disabled.' })
  }

  if (user && user.fileLength && !req.headers.filelength) {
    req.headers.filelength = user.fileLength
  }

  let albumid = parseInt(req.headers.albumid || req.params.albumid)
  if (isNaN(albumid)) { albumid = null }

  if (req.body.urls) {
    return uploadsController.actuallyUploadByUrl(req, res, user, albumid)
  } else {
    return uploadsController.actuallyUpload(req, res, user, albumid)
  }
}

uploadsController.actuallyUpload = async (req, res, user, albumid) => {
  const erred = error => {
    const isError = error instanceof Error
    if (isError) { console.error(error) }
    res.json({
      success: false,
      description: isError ? error.toString() : error
    })
  }

  upload(req, res, async error => {
    if (error) { return erred(error) }

    if (!req.files || !req.files.length) { return erred('No files.') }

    // If chunked uploads is enabled and the uploaded file is a chunk, then just say that it was a success
    if (chunkedUploads && req.body.uuid) { return res.json({ success: true }) }

    const infoMap = req.files.map(file => {
      file.albumid = albumid
      return {
        path: path.join(__dirname, '..', config.uploads.folder, file.filename),
        data: file
      }
    })

    if (config.uploads.scan) {
      const scan = await uploadsController.scanFiles(req, infoMap)
      if (!scan) { return erred('Virus detected.') }
    }

    const result = await uploadsController.formatInfoMap(req, res, user, infoMap)
      .catch(erred)
    if (!result) { return }

    uploadsController.processFilesForDisplay(req, res, result.files, result.existingFiles)
  })
}

uploadsController.actuallyUploadByUrl = async (req, res, user, albumid) => {
  const erred = error => {
    const isError = error instanceof Error
    if (isError) { console.error(error) }
    res.json({
      success: false,
      description: isError ? error.toString() : error
    })
  }

  if (!config.uploads.urlMaxSize) { return erred('Upload by URLs is disabled at the moment.') }

  let urls = req.body.urls
  if (!urls || !(urls instanceof Array)) { return erred('Missing "urls" property (Array).') }

  // DuckDuckGo's proxy
  if (config.uploads.urlDuckDuckGoProxy) {
    urls = urls.map(url => `https://proxy.duckduckgo.com/iur/?f=1&image_host=${encodeURIComponent(url)}&u=${url}`)
  }

  let iteration = 0
  const infoMap = []
  for (const url of urls) {
    const original = path.basename(url).split(/[?#]/)[0]
    const extension = pce(original).toLowerCase()
    if (uploadsController.isExtensionFiltered(extension)) {
      return erred(`${extension.substr(1).toUpperCase()} files are not permitted due to security reasons.`)
    }

    const head = await snekfetch.head(url)
      .catch(error => error)
    if (head.status !== 200) { return erred(head.toString()) }
    if (!head) { return }

    const size = parseInt(head.headers['content-length'])
    if (isNaN(size)) {
      return erred('URLs with missing Content-Length HTTP header are not supported.')
    }
    if (size > urlMaxSizeBytes) {
      return erred('File too large.')
    }

    const download = await snekfetch.get(url)
      .catch(error => error)
    if (download.status !== 200) { return erred(download.toString()) }
    if (!download) { return }

    const length = uploadsController.getFileNameLength(req)
    const name = await uploadsController.getUniqueRandomName(length, extension)
      .catch(erred)
    if (!name) { return }

    const destination = path.join(uploadsDir, name)
    fs.writeFile(destination, download.body, async error => {
      if (error) { return erred(error) }

      const data = {
        filename: name,
        originalname: original,
        mimetype: download.headers['content-type'].split(';')[0] || '',
        size,
        albumid
      }

      infoMap.push({
        path: destination,
        data
      })

      iteration++
      if (iteration === urls.length) {
        if (config.uploads.scan) {
          const scan = await uploadsController.scanFiles(req, infoMap)
          if (!scan) { return erred('Virus detected.') }
        }

        const result = await uploadsController.formatInfoMap(req, res, user, infoMap)
          .catch(erred)
        if (!result) { return }

        uploadsController.processFilesForDisplay(req, res, result.files, result.existingFiles)
      }
    })
  }
}

uploadsController.finishChunks = async (req, res, next) => {
  if (!chunkedUploads) {
    return res.json({ success: false, description: 'Chunked upload is disabled at the moment.' })
  }

  let user
  if (config.private === true) {
    user = await utils.authorize(req, res)
    if (!user) { return }
  } else if (req.headers.token) {
    user = await db.table('users').where('token', req.headers.token).first()
  }

  if (user && (user.enabled === false || user.enabled === 0)) {
    return res.json({ success: false, description: 'This account has been disabled.' })
  }

  if (user && user.fileLength && !req.headers.filelength) {
    req.headers.filelength = user.fileLength
  }

  let albumid = parseInt(req.headers.albumid || req.params.albumid)
  if (isNaN(albumid)) { albumid = null }

  return uploadsController.actuallyFinishChunks(req, res, user, albumid)
}

uploadsController.actuallyFinishChunks = async (req, res, user, albumid) => {
  const erred = error => {
    const isError = error instanceof Error
    if (isError) { console.error(error) }
    res.json({
      success: false,
      description: isError ? error.toString() : error
    })
  }

  const files = req.body.files
  if (!files || !(files instanceof Array)) { return erred('Missing "files" property (Array).') }
  if (!files.length) { return erred('"files" property can not be empty.') }

  let iteration = 0
  const infoMap = []
  for (const file of files) {
    if (!file.uuid || typeof file.uuid !== 'string') { return erred('Missing or empty "uuid" property (string).') }
    if (typeof file.count !== 'number') { return erred('Missing "count" property (number).') }
    if (file.count < 1) { return erred('"count" property can not be less than 1.') }

    const uuidDir = path.join(chunksDir, file.uuid)
    fs.readdir(uuidDir, async (error, chunkNames) => {
      if (error) { return erred(error) }
      if (file.count < chunkNames.length) { return erred('Chunks count mismatch.') }

      const extension = typeof file.original === 'string' ? pce(file.original).toLowerCase() : ''
      if (uploadsController.isExtensionFiltered(extension)) {
        return erred(`${extension.substr(1).toUpperCase()} files are not permitted due to security reasons.`)
      }

      const length = uploadsController.getFileNameLength(req)
      const name = await uploadsController.getUniqueRandomName(length, extension)
        .catch(erred)
      if (!name) { return }

      const destination = path.join(uploadsDir, name)

      // Sort chunk names
      chunkNames.sort()

      // Get total chunks size
      const chunksTotalSize = await uploadsController.getTotalSize(uuidDir, chunkNames)
        .catch(erred)
      if (typeof chunksTotalSize !== 'number') { return }
      if (chunksTotalSize > maxSizeBytes) {
        // Delete all chunks and remove chunks dir
        const chunksCleaned = await uploadsController.cleanUpChunks(uuidDir, chunkNames)
          .catch(erred)
        if (!chunksCleaned) { return }
        return erred(`Total chunks size is bigger than ${maxSize}.`)
      }

      // Append all chunks
      const destFileStream = fs.createWriteStream(destination, { flags: 'a' })
      const chunksAppended = await uploadsController.appendToStream(destFileStream, uuidDir, chunkNames)
        .catch(erred)
      if (!chunksAppended) { return }

      // Delete all chunks and remove chunks dir
      const chunksCleaned = await uploadsController.cleanUpChunks(uuidDir, chunkNames)
        .catch(erred)
      if (!chunksCleaned) { return }

      const data = {
        filename: name,
        originalname: file.original || '',
        mimetype: file.type || '',
        size: file.size || 0
      }

      data.albumid = parseInt(file.albumid)
      if (isNaN(data.albumid)) { data.albumid = albumid }

      infoMap.push({
        path: destination,
        data
      })

      iteration++
      if (iteration === files.length) {
        if (config.uploads.scan) {
          const scan = await uploadsController.scanFiles(req, infoMap)
          if (!scan) { return erred('Virus detected.') }
        }

        const result = await uploadsController.formatInfoMap(req, res, user, infoMap)
          .catch(erred)
        if (!result) { return }

        uploadsController.processFilesForDisplay(req, res, result.files, result.existingFiles)
      }
    })
  }
}

uploadsController.getTotalSize = (uuidDir, chunkNames) => {
  return new Promise((resolve, reject) => {
    let size = 0
    const stat = i => {
      if (i === chunkNames.length) { return resolve(size) }
      fs.stat(path.join(uuidDir, chunkNames[i]), (error, stats) => {
        if (error) { return reject(error) }
        size += stats.size
        stat(i + 1)
      })
    }
    stat(0)
  })
}

uploadsController.appendToStream = (destFileStream, uuidDr, chunkNames) => {
  return new Promise((resolve, reject) => {
    const append = i => {
      if (i === chunkNames.length) {
        destFileStream.end()
        return resolve(true)
      }
      fs.createReadStream(path.join(uuidDr, chunkNames[i]))
        .on('end', () => {
          append(i + 1)
        })
        .on('error', error => {
          console.error(error)
          destFileStream.end()
          return reject(error)
        })
        .pipe(destFileStream, { end: false })
    }
    append(0)
  })
}

uploadsController.cleanUpChunks = (uuidDir, chunkNames) => {
  return new Promise(async (resolve, reject) => {
    await Promise.all(chunkNames.map(chunkName => {
      return new Promise((resolve, reject) => {
        const chunkPath = path.join(uuidDir, chunkName)
        fs.unlink(chunkPath, error => {
          if (error && error.code !== 'ENOENT') {
            console.error(error)
            return reject(error)
          }
          resolve()
        })
      })
    })).catch(reject)
    fs.rmdir(uuidDir, error => {
      if (error) { return reject(error) }
      resolve(true)
    })
  })
}

uploadsController.formatInfoMap = (req, res, user, infoMap) => {
  return new Promise(async resolve => {
    let iteration = 0
    const files = []
    const existingFiles = []
    const albumsAuthorized = {}

    for (const info of infoMap) {
      // Check if the file exists by checking hash and size
      const hash = crypto.createHash('md5')
      const stream = fs.createReadStream(info.path)

      stream.on('data', data => {
        hash.update(data, 'utf8')
      })

      stream.on('end', async () => {
        const fileHash = hash.digest('hex')
        const dbFile = await db.table('files')
          .where(function () {
            if (user === undefined) {
              this.whereNull('userid')
            } else {
              this.where('userid', user.id)
            }
          })
          .where({
            hash: fileHash,
            size: info.data.size
          })
          .first()

        if (!dbFile) {
          if (info.data.albumid && albumsAuthorized[info.data.albumid] === undefined) {
            const authorized = await db.table('albums')
              .where({
                id: info.data.albumid,
                userid: user.id
              })
              .first()
            albumsAuthorized[info.data.albumid] = Boolean(authorized)
          }

          files.push({
            name: info.data.filename,
            original: info.data.originalname,
            type: info.data.mimetype,
            size: info.data.size,
            hash: fileHash,
            ip: req.ip,
            albumid: albumsAuthorized[info.data.albumid] ? info.data.albumid : null,
            userid: user !== undefined ? user.id : null,
            timestamp: Math.floor(Date.now() / 1000)
          })
        } else {
          utils.deleteFile(info.data.filename).catch(console.error)
          existingFiles.push(dbFile)
        }

        iteration++
        if (iteration === infoMap.length) {
          resolve({ files, existingFiles })
        }
      })
    }
  })
}

uploadsController.scanFiles = async (req, infoMap) => {
  const dirty = await new Promise(async resolve => {
    let iteration = 0
    const engine = req.app.get('clam-engine')
    const dirty = []

    for (const info of infoMap) {
      const log = message => {
        console.log(`ClamAV: ${info.data.filename}: ${message}.`)
      }

      engine.scanFile(info.path, (error, virus) => {
        if (error || virus) {
          if (error) { log(error.toString()) }
          if (virus) { log(`${virus} detected`) }
          dirty.push(info)
        } else {
          // log('OK')
        }

        iteration++
        if (iteration === infoMap.length) {
          resolve(dirty)
        }
      })
    }
  })

  if (!dirty.length) { return true }

  // If there is at least one dirty file, delete all files
  infoMap.forEach(info => utils.deleteFile(info.data.filename).catch(console.error))
}

uploadsController.processFilesForDisplay = async (req, res, files, existingFiles) => {
  const responseFiles = []

  if (files.length) {
    // Insert new files to DB
    await db.table('files').insert(files)

    for (const file of files) {
      responseFiles.push(file)
    }
  }

  if (existingFiles.length) {
    for (const file of existingFiles) {
      responseFiles.push(file)
    }
  }

  // We send response first before generating thumbnails and updating album timestamps
  res.json({
    success: true,
    files: responseFiles.map(file => {
      return {
        name: file.name,
        size: file.size,
        url: `${config.domain}/${file.name}`
      }
    })
  })

  const albumids = []
  for (const file of files) {
    if (file.albumid && !albumids.includes(file.albumid)) {
      albumids.push(file.albumid)
    }
    if (utils.mayGenerateThumb(pce(file.name).toLowerCase())) {
      utils.generateThumbs(file.name)
    }
  }

  if (albumids.length) {
    await db.table('albums')
      .whereIn('id', albumids)
      .update('editedAt', Math.floor(Date.now() / 1000))
      .catch(console.error)
  }
}

uploadsController.delete = async (req, res) => {
  const id = parseInt(req.body.id)
  req.body.field = 'id'
  req.body.values = isNaN(id) ? undefined : [id]
  delete req.body.id
  return uploadsController.bulkDelete(req, res)
}

uploadsController.bulkDelete = async (req, res) => {
  const user = await utils.authorize(req, res)
  if (!user) { return }

  const field = req.body.field || 'id'
  const values = req.body.values

  if (!values || values.constructor.name !== 'Array' || !values.length) {
    return res.json({ success: false, description: 'No array of files specified.' })
  }

  const failed = await utils.bulkDeleteFiles(field, values, user)
  if (failed.length < values.length) {
    return res.json({ success: true, failed })
  }

  return res.json({ success: false, description: 'Could not delete any files.' })
}

uploadsController.list = async (req, res) => {
  const user = await utils.authorize(req, res)
  if (!user) { return }

  let offset = req.params.page
  if (offset === undefined) { offset = 0 }

  const files = await db.table('files')
    .where(function () {
      if (req.params.id === undefined) {
        this.where('id', '<>', '')
      } else {
        this.where('albumid', req.params.id)
      }
    })
    .where(function () {
      if (user.username !== 'root') { this.where('userid', user.id) }
    })
    .orderBy('id', 'DESC')
    .limit(25)
    .offset(25 * offset)
    .select('id', 'albumid', 'timestamp', 'name', 'userid', 'size')

  const albums = await db.table('albums')
    .where(function () {
      this.where('enabled', 1)
      if (user.username !== 'root') {
        this.where('userid', user.id)
      }
    })

  const basedomain = config.domain
  const userids = []

  for (const file of files) {
    file.file = `${basedomain}/${file.name}`
    file.date = utils.getPrettyDate(new Date(file.timestamp * 1000))
    file.size = utils.getPrettyBytes(parseInt(file.size))

    file.album = ''
    if (file.albumid !== undefined) {
      for (const album of albums) {
        if (file.albumid === album.id) {
          file.album = album.name
        }
      }
    }

    // Only push usernames if we are root
    if (user.username === 'root') {
      if (file.userid !== undefined && file.userid !== null && file.userid !== '') {
        userids.push(file.userid)
      }
    }

    file.extname = pce(file.name).toLowerCase()
    if (utils.mayGenerateThumb(file.extname)) {
      file.thumb = `${basedomain}/thumbs/${file.name.slice(0, -file.extname.length)}.png`
    }
  }

  // If we are a normal user, send response
  if (user.username !== 'root') { return res.json({ success: true, files }) }

  // If we are root but there are no uploads attached to a user, send response
  if (userids.length === 0) { return res.json({ success: true, files }) }

  const users = await db.table('users')
    .whereIn('id', userids)
  for (const dbUser of users) {
    for (const file of files) {
      if (file.userid === dbUser.id) {
        file.username = dbUser.username
      }
    }
  }

  return res.json({ success: true, files })
}

module.exports = uploadsController
