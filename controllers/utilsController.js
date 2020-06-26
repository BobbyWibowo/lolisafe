const { promisify } = require('util')
const { spawn } = require('child_process')
const fetch = require('node-fetch')
const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const sharp = require('sharp')
const si = require('systeminformation')
const paths = require('./pathsController')
const perms = require('./permissionController')
const config = require('./../config')
const logger = require('./../logger')
const db = require('knex')(config.database)

const self = {
  clamd: {
    scanner: null,
    timeout: config.uploads.scan.timeout || 5000,
    chunkSize: config.uploads.scan.chunkSize || 64 * 1024,
    groupBypass: config.uploads.scan.groupBypass || null,
    whitelistExtensions: (Array.isArray(config.uploads.scan.whitelistExtensions) &&
     config.uploads.scan.whitelistExtensions.length) ? config.uploads.scan.whitelistExtensions : null,
    maxSize: (parseInt(config.uploads.scan.maxSize) * 1e6) || null
  },
  gitHash: null,
  idSet: null,

  idMaxTries: config.uploads.maxTries || 1,

  imageExts: ['.gif', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp'],
  videoExts: ['.3g2', '.3gp', '.asf', '.avchd', '.avi', '.divx', '.evo', '.flv', '.h264', '.h265', '.hevc', '.m2p', '.m2ts', '.m4v', '.mk3d', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.mxf', '.ogg', '.ogv', '.ps', '.qt', '.rmvb', '.ts', '.vob', '.webm', '.wmv'],

  thumbsSize: config.uploads.generateThumbs.size || 200,
  ffprobe: promisify(ffmpeg.ffprobe),

  albumsCache: {},
  timezoneOffset: new Date().getTimezoneOffset()
}

const statsCache = {
  system: {
    cache: null,
    generating: false,
    generatedAt: 0
  },
  disk: {
    cache: null,
    generating: false,
    generatedAt: 0
  },
  albums: {
    cache: null,
    generating: false,
    generatedAt: 0
  },
  users: {
    cache: null,
    generating: false,
    generatedAt: 0
  },
  uploads: {
    cache: null,
    generating: false,
    generatedAt: 0
  }
}

const cloudflareAuth = config.cloudflare && config.cloudflare.apiToken && config.cloudflare.apiKey &&
  config.cloudflare.email && config.cloudflare.zoneId

self.mayGenerateThumb = extname => {
  return (config.uploads.generateThumbs.image && self.imageExts.includes(extname)) ||
    (config.uploads.generateThumbs.video && self.videoExts.includes(extname))
}

// Expand if necessary (must be lower case); for now only preserves some known tarballs
const extPreserves = ['.tar.gz', '.tar.z', '.tar.bz2', '.tar.lzma', '.tar.lzo', '.tar.xz']

self.extname = filename => {
  // Always return blank string if the filename does not seem to have a valid extension
  // Files such as .DS_Store (anything that starts with a dot, without any extension after) will still be accepted
  if (!/\../.test(filename)) return ''

  let lower = filename.toLowerCase() // due to this, the returned extname will always be lower case
  let multi = ''
  let extname = ''

  // check for multi-archive extensions (.001, .002, and so on)
  if (/\.\d{3}$/.test(lower)) {
    multi = lower.slice(lower.lastIndexOf('.') - lower.length)
    lower = lower.slice(0, lower.lastIndexOf('.'))
  }

  // check against extensions that must be preserved
  for (const extPreserve of extPreserves)
    if (lower.endsWith(extPreserve)) {
      extname = extPreserve
      break
    }

  if (!extname)
    extname = lower.slice(lower.lastIndexOf('.') - lower.length) // path.extname(lower)

  return extname + multi
}

self.escape = string => {
  // MIT License
  // Copyright(c) 2012-2013 TJ Holowaychuk
  // Copyright(c) 2015 Andreas Lubbe
  // Copyright(c) 2015 Tiancheng "Timothy" Gu

  if (!string)
    return string

  const str = String(string)
  const match = /["'&<>]/.exec(str)

  if (!match)
    return str

  let escape
  let html = ''
  let index = 0
  let lastIndex = 0

  for (index = match.index; index < str.length; index++) {
    switch (str.charCodeAt(index)) {
      case 34: // "
        escape = '&quot;'
        break
      case 38: // &
        escape = '&amp;'
        break
      case 39: // '
        escape = '&#39;'
        break
      case 60: // <
        escape = '&lt;'
        break
      case 62: // >
        escape = '&gt;'
        break
      default:
        continue
    }

    if (lastIndex !== index)
      html += str.substring(lastIndex, index)

    lastIndex = index + 1
    html += escape
  }

  return lastIndex !== index
    ? html + str.substring(lastIndex, index)
    : html
}

self.stripIndents = string => {
  if (!string) return
  const result = string.replace(/^[^\S\n]+/gm, '')
  const match = result.match(/^[^\S\n]*(?=\S)/gm)
  const indent = match && Math.min(...match.map(el => el.length))
  if (indent) {
    const regexp = new RegExp(`^.{${indent}}`, 'gm')
    return result.replace(regexp, '')
  }
  return result
}

self.authorize = async (req, res) => {
  // TODO: Improve usage of this function by the other APIs
  const token = req.headers.token
  if (token === undefined) {
    res.status(401).json({ success: false, description: 'No token provided.' })
    return
  }

  try {
    const user = await db.table('users')
      .where('token', token)
      .first()
    if (user) {
      if (user.enabled === false || user.enabled === 0) {
        res.json({ success: false, description: 'This account has been disabled.' })
        return
      }
      return user
    }

    res.status(401).json({ success: false, description: 'Invalid token.' })
  } catch (error) {
    logger.error(error)
    res.status(500).json({ success: false, description: 'An unexpected error occurred. Try again?' })
  }
}

self.generateThumbs = async (name, extname, force) => {
  const thumbname = path.join(paths.thumbs, name.slice(0, -extname.length) + '.png')

  try {
    // Check if thumbnail already exists
    try {
      const lstat = await paths.lstat(thumbname)
      if (lstat.isSymbolicLink())
        // Unlink if symlink (should be symlink to the placeholder)
        await paths.unlink(thumbname)
      else if (!force)
        // Continue only if it does not exist, unless forced to
        return true
    } catch (error) {
      // Re-throw error
      if (error.code !== 'ENOENT')
        throw error
    }

    // Full path to input file
    const input = path.join(paths.uploads, name)

    // If image extension
    if (self.imageExts.includes(extname)) {
      const resizeOptions = {
        width: self.thumbsSize,
        height: self.thumbsSize,
        fit: 'contain',
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0
        }
      }
      const image = sharp(input)
      const metadata = await image.metadata()
      if (metadata.width > resizeOptions.width || metadata.height > resizeOptions.height) {
        await image
          .resize(resizeOptions)
          .toFile(thumbname)
      } else if (metadata.width === resizeOptions.width && metadata.height === resizeOptions.height) {
        await image
          .toFile(thumbname)
      } else {
        const x = resizeOptions.width - metadata.width
        const y = resizeOptions.height - metadata.height
        await image
          .extend({
            top: Math.floor(y / 2),
            bottom: Math.ceil(y / 2),
            left: Math.floor(x / 2),
            right: Math.ceil(x / 2),
            background: resizeOptions.background
          })
          .toFile(thumbname)
      }
    } else if (self.videoExts.includes(extname)) {
      const metadata = await self.ffprobe(input)

      const duration = parseInt(metadata.format.duration)
      if (isNaN(duration))
        throw 'Warning: File does not have valid duration metadata'

      const videoStream = metadata.streams && metadata.streams.find(s => s.codec_type === 'video')
      if (!videoStream || !videoStream.width || !videoStream.height)
        throw 'Warning: File does not have valid video stream metadata'

      await new Promise((resolve, reject) => {
        ffmpeg(input)
          .on('error', error => reject(error))
          .on('end', () => resolve())
          .screenshots({
            folder: paths.thumbs,
            filename: name.slice(0, -extname.length) + '.png',
            timestamps: ['20%'],
            size: videoStream.width >= videoStream.height
              ? `${self.thumbsSize}x?`
              : `?x${self.thumbsSize}`
          })
      })
        .catch(error => error) // Error passthrough
        .then(async error => {
          // FFMPEG would just warn instead of exiting with errors when dealing with incomplete files
          // Sometimes FFMPEG would throw errors but actually somehow succeeded in making the thumbnails
          // (this could be a fallback mechanism of fluent-ffmpeg library instead)
          // So instead we check if the thumbnail exists to really make sure
          try {
            await paths.lstat(thumbname)
            return true
          } catch (err) {
            if (err.code === 'ENOENT')
              throw error || 'Warning: FFMPEG exited with empty output file'
            else
              throw error || err
          }
        })
    } else {
      return false
    }
  } catch (error) {
    logger.error(`[${name}]: ${error.toString().trim()}`)
    try {
      await paths.symlink(paths.thumbPlaceholder, thumbname)
      return true
    } catch (err) {
      logger.error(err)
      return false
    }
  }

  return true
}

self.stripTags = async (name, extname) => {
  const fullpath = path.join(paths.uploads, name)

  if (self.imageExts.includes(extname)) {
    const tmpfile = path.join(paths.uploads, `tmp-${name}`)
    await paths.rename(fullpath, tmpfile)

    try {
      await sharp(tmpfile)
        .toFile(fullpath)
      await paths.unlink(tmpfile)
    } catch (error) {
      await paths.unlink(tmpfile)
      // Re-throw error
      throw error
    }
  } else if (config.uploads.stripTags.video && self.videoExts.includes(extname)) {
    const tmpfile = path.join(paths.uploads, `tmp-${name}`)
    await paths.rename(fullpath, tmpfile)

    try {
      await new Promise((resolve, reject) => {
        ffmpeg(tmpfile)
          .output(fullpath)
          .outputOptions([
            // Experimental.
            '-c copy',
            '-map_metadata:g -1:g',
            '-map_metadata:s:v -1:g',
            '-map_metadata:s:a -1:g'
          ])
          .on('error', error => reject(error))
          .on('end', () => resolve(true))
          .run()
      })
      await paths.unlink(tmpfile)
    } catch (error) {
      await paths.unlink(tmpfile)
      // Re-throw error
      throw error
    }
  }

  return true
}

self.unlinkFile = async (filename, predb) => {
  try {
    await paths.unlink(path.join(paths.uploads, filename))
  } catch (error) {
    // Return true if file does not exist
    if (error.code !== 'ENOENT')
      throw error
  }

  const identifier = filename.split('.')[0]

  // Do not remove from identifiers cache on pre-db-deletion
  // eslint-disable-next-line curly
  if (!predb && self.idSet) {
    self.idSet.delete(identifier)
    // logger.log(`Removed ${identifier} from identifiers cache (deleteFile)`)
  }

  const extname = self.extname(filename)
  if (self.imageExts.includes(extname) || self.videoExts.includes(extname))
    try {
      await paths.unlink(path.join(paths.thumbs, `${identifier}.png`))
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw error
    }
}

self.bulkDeleteFromDb = async (field, values, user) => {
  // Always return an empty array on failure
  if (!user || !['id', 'name'].includes(field) || !values.length)
    return []

  // SQLITE_LIMIT_VARIABLE_NUMBER, which defaults to 999
  // Read more: https://www.sqlite.org/limits.html
  const MAX_VARIABLES_CHUNK_SIZE = 999
  const chunks = []
  while (values.length)
    chunks.push(values.splice(0, MAX_VARIABLES_CHUNK_SIZE))

  let failed = []
  const ismoderator = perms.is(user, 'moderator')

  try {
    let unlinkeds = []
    const albumids = []

    await Promise.all(chunks.map(async chunk => {
      const files = await db.table('files')
        .whereIn(field, chunk)
        .where(function () {
          if (!ismoderator)
            this.where('userid', user.id)
        })

      // Push files that could not be found in db
      failed = failed.concat(chunk.filter(value => !files.find(file => file[field] === value)))

      // Unlink all found files
      const unlinked = []

      await Promise.all(files.map(async file => {
        try {
          await self.unlinkFile(file.name, true)
          unlinked.push(file)
        } catch (error) {
          logger.error(error)
          failed.push(file[field])
        }
      }))

      if (!unlinked.length) return

      // Delete all unlinked files from db
      await db.table('files')
        .whereIn('id', unlinked.map(file => file.id))
        .del()
      self.invalidateStatsCache('uploads')

      if (self.idSet)
        unlinked.forEach(file => {
          const identifier = file.name.split('.')[0]
          self.idSet.delete(identifier)
          // logger.log(`Removed ${identifier} from identifiers cache (bulkDeleteFromDb)`)
        })

      // Push album ids
      unlinked.forEach(file => {
        if (file.albumid && !albumids.includes(file.albumid))
          albumids.push(file.albumid)
      })

      // Push unlinked files
      unlinkeds = unlinkeds.concat(unlinked)
    }))

    if (unlinkeds.length) {
      // Update albums if necessary, but do not wait
      if (albumids.length) {
        db.table('albums')
          .whereIn('id', albumids)
          .update('editedAt', Math.floor(Date.now() / 1000))
          .catch(logger.error)
        self.invalidateAlbumsCache(albumids)
      }

      // Purge Cloudflare's cache if necessary, but do not wait
      if (config.cloudflare.purgeCache)
        self.purgeCloudflareCache(unlinkeds.map(file => file.name), true, true)
          .then(results => {
            for (const result of results)
              if (result.errors.length)
                result.errors.forEach(error => logger.error(`[CF]: ${error}`))
          })
    }
  } catch (error) {
    logger.error(error)
  }

  return failed
}

self.purgeCloudflareCache = async (names, uploads, thumbs) => {
  if (!Array.isArray(names) || !names.length || !cloudflareAuth)
    return [{
      success: false,
      files: [],
      errors: ['An unexpected error occured.']
    }]

  let domain = config.domain
  if (!uploads) domain = config.homeDomain

  const thumbNames = []
  names = names.map(name => {
    if (uploads) {
      const url = `${domain}/${name}`
      const extname = self.extname(name)
      if (thumbs && self.mayGenerateThumb(extname))
        thumbNames.push(`${domain}/thumbs/${name.slice(0, -extname.length)}.png`)
      return url
    } else {
      return name === 'home' ? domain : `${domain}/${name}`
    }
  })
  names = names.concat(thumbNames)

  // Split array into multiple arrays with max length of 30 URLs
  // https://api.cloudflare.com/#zone-purge-files-by-url
  // TODO: Handle API rate limits
  const MAX_LENGTH = 30
  const chunks = []
  while (names.length)
    chunks.push(names.splice(0, MAX_LENGTH))

  const url = `https://api.cloudflare.com/client/v4/zones/${config.cloudflare.zoneId}/purge_cache`
  const results = []

  await Promise.all(chunks.map(async chunk => {
    const result = {
      success: false,
      files: chunk,
      errors: []
    }

    try {
      const purge = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ files: chunk }),
        headers: {
          'Authorization: Bearer': config.cloudflare.apiToken,
          'Content-Type': 'application/json',
          'X-Auth-Email': config.cloudflare.email,
          'X-Auth-Key': config.cloudflare.apiKey
        }
      })
      const response = await purge.json()
      result.success = response.success
      if (Array.isArray(response.errors) && response.errors.length)
        result.errors = response.errors.map(error => `${error.code}: ${error.message}`)
    } catch (error) {
      result.errors = [error.toString()]
    }

    results.push(result)
  }))

  return results
}

self.bulkDeleteExpired = async (dryrun, verbose) => {
  const timestamp = Date.now() / 1000
  const fields = ['id']
  if (verbose) fields.push('name')
  const sudo = { username: 'root' }

  const result = {}
  result.expired = await db.table('files')
    .where('expirydate', '<=', timestamp)
    .select(fields)

  if (!dryrun) {
    // Make a shallow copy
    const field = fields[0]
    const values = result.expired.slice().map(row => row[field])
    result.failed = await self.bulkDeleteFromDb(field, values, sudo)
  }

  return result
}

self.invalidateAlbumsCache = albumids => {
  for (const albumid of albumids) {
    delete self.albumsCache[albumid]
    delete self.albumsCache[`${albumid}-nojs`]
  }
}

self.invalidateStatsCache = type => {
  if (!['albums', 'users', 'uploads'].includes(type)) return
  statsCache[type].cache = null
}

self.stats = async (req, res, next) => {
  const user = await self.authorize(req, res)
  if (!user) return

  const isadmin = perms.is(user, 'admin')
  if (!isadmin) return res.status(403).end()

  try {
    const stats = {}
    const os = await si.osInfo()

    // System info
    if (!statsCache.system.cache && statsCache.system.generating) {
      stats.system = false
    } else if (((Date.now() - statsCache.system.generatedAt) <= 1000) || statsCache.system.generating) {
      // Use cache for 1000 ms (1 second)
      stats.system = statsCache.system.cache
    } else {
      statsCache.system.generating = true
      statsCache.system.generatedAt = Date.now()

      const currentLoad = await si.currentLoad()
      const mem = await si.mem()

      stats.system = {
        _types: {
          byte: ['memoryUsage'],
          byteUsage: ['systemMemory']
        },
        platform: `${os.platform} ${os.arch}`,
        distro: `${os.distro} ${os.release}`,
        kernel: os.kernel,
        cpuLoad: `${currentLoad.currentload.toFixed(1)}%`,
        cpusLoad: currentLoad.cpus.map(cpu => `${cpu.load.toFixed(1)}%`).join(', '),
        systemMemory: {
          used: mem.active,
          total: mem.total
        },
        memoryUsage: process.memoryUsage().rss,
        nodeVersion: `${process.versions.node}`
      }

      // Update cache
      statsCache.system.cache = stats.system
      statsCache.system.generating = false
    }

    // Disk usage, only for Linux platform
    if (os.platform === 'linux')
      if (!statsCache.disk.cache && statsCache.disk.generating) {
        stats.disk = false
      } else if (((Date.now() - statsCache.disk.generatedAt) <= 60000) || statsCache.disk.generating) {
        // Use cache for 60000 ms (60 seconds)
        stats.disk = statsCache.disk.cache
      } else {
        statsCache.disk.generating = true
        statsCache.disk.generatedAt = Date.now()

        stats.disk = {
          _types: {
            byteUsage: ['drive']
          },
          drive: null
        }

        // Linux-only extended disk stats
        if (config.linuxDiskStats) {
          // We pre-assign the keys below to fix their order
          stats.disk._types.byte = ['uploads', 'thumbs', 'zips', 'chunks']
          stats.disk.uploads = 0
          stats.disk.thumbs = 0
          stats.disk.zips = 0
          stats.disk.chunks = 0

          const subdirs = []

          // Get size of uploads path (excluding sub-directories)
          await new Promise((resolve, reject) => {
            const proc = spawn('du', [
              '--apparent-size',
              '--block-size=1',
              '--dereference',
              '--max-depth=1',
              '--separate-dirs',
              paths.uploads
            ])

            proc.stdout.on('data', data => {
              const formatted = String(data)
                .trim()
                .split(/\s+/)
              for (let i = 0; i < formatted.length; i += 2) {
                const path = formatted[i + 1]
                if (!path) return

                if (path !== paths.uploads) {
                  subdirs.push(path)
                  continue
                }

                stats.disk.uploads = parseInt(formatted[i])
              }
            })

            const stderr = []
            proc.stderr.on('data', data => stderr.push(String(data)))

            proc.on('exit', code => {
              if (code !== 0) return reject(stderr)
              resolve()
            })
          })

          await Promise.all(subdirs.map(subdir => {
            return new Promise((resolve, reject) => {
              const proc = spawn('du', [
                '--apparent-size',
                '--block-size=1',
                '--dereference',
                '--summarize',
                subdir
              ])

              proc.stdout.on('data', data => {
                const formatted = String(data)
                  .trim()
                  .split(/\s+/)
                if (formatted.length !== 2) return

                const basename = path.basename(formatted[1])
                stats.disk[basename] = parseInt(formatted[0])

                // Add to types if necessary
                if (!stats.disk._types.byte.includes(basename))
                  stats.disk._types.byte.push(basename)
              })

              const stderr = []
              proc.stderr.on('data', data => stderr.push(String(data)))

              proc.on('exit', code => {
                if (code !== 0) return reject(stderr)
                resolve()
              })
            })
          }))
        }

        // Get disk usage of whichever disk uploads path resides on
        await new Promise((resolve, reject) => {
          const proc = spawn('df', [
            '--block-size=1',
            '--output=used,size',
            paths.uploads
          ])

          proc.stdout.on('data', data => {
            // Only use the first valid line
            if (stats.disk.drive !== null) return

            const lines = String(data)
              .trim()
              .split('\n')
            if (lines.length !== 2) return

            for (const line of lines) {
              const columns = line.split(/\s+/)
              // Skip lines that have non-number chars
              if (columns.some(w => !/^\d+$/.test(w))) continue

              stats.disk.drive = {
                used: parseInt(columns[0]),
                total: parseInt(columns[1])
              }
            }
          })

          const stderr = []
          proc.stderr.on('data', data => stderr.push(String(data)))

          proc.on('exit', code => {
            if (code !== 0) return reject(stderr)
            resolve()
          })
        })

        // Update cache
        statsCache.disk.cache = stats.disk
        statsCache.disk.generating = false
      }

    // Uploads
    if (!statsCache.uploads.cache && statsCache.uploads.generating) {
      stats.uploads = false
    } else if (statsCache.uploads.cache) {
      stats.uploads = statsCache.uploads.cache
    } else {
      statsCache.uploads.generating = true
      statsCache.uploads.generatedAt = Date.now()

      stats.uploads = {
        _types: {
          number: ['total', 'images', 'videos', 'others']
        },
        total: 0,
        images: 0,
        videos: 0,
        others: 0
      }

      if (!config.linuxDiskStats || os.platform !== 'linux') {
        const uploads = await db.table('files')
          .select('size')
        stats.uploads.total = uploads.length
        stats.uploads.sizeInDb = uploads.reduce((acc, upload) => acc + parseInt(upload.size), 0)
        // Add type information for the new column
        if (!Array.isArray(stats.uploads._types.byte))
          stats.uploads._types.byte = []
        stats.uploads._types.byte.push('sizeInDb')
      } else {
        stats.uploads.total = await db.table('files')
          .count('id as count')
          .then(rows => rows[0].count)
      }

      stats.uploads.images = await db.table('files')
        .where(function () {
          for (const ext of self.imageExts)
            this.orWhere('name', 'like', `%${ext}`)
        })
        .count('id as count')
        .then(rows => rows[0].count)

      stats.uploads.videos = await db.table('files')
        .where(function () {
          for (const ext of self.videoExts)
            this.orWhere('name', 'like', `%${ext}`)
        })
        .count('id as count')
        .then(rows => rows[0].count)

      stats.uploads.others = stats.uploads.total - stats.uploads.images - stats.uploads.videos

      // Update cache
      statsCache.uploads.cache = stats.uploads
      statsCache.uploads.generating = false
    }

    // Users
    if (!statsCache.users.cache && statsCache.users.generating) {
      stats.users = false
    } else if (statsCache.users.cache) {
      stats.users = statsCache.users.cache
    } else {
      statsCache.users.generating = true
      statsCache.users.generatedAt = Date.now()

      stats.users = {
        _types: {
          number: ['total', 'disabled']
        },
        total: 0,
        disabled: 0
      }

      const permissionKeys = Object.keys(perms.permissions).reverse()
      permissionKeys.forEach(p => {
        stats.users[p] = 0
        stats.users._types.number.push(p)
      })

      const users = await db.table('users')
      stats.users.total = users.length
      for (const user of users) {
        if (user.enabled === false || user.enabled === 0)
          stats.users.disabled++

        // This may be inaccurate on installations with customized permissions
        user.permission = user.permission || 0
        for (const p of permissionKeys)
          if (user.permission === perms.permissions[p]) {
            stats.users[p]++
            break
          }
      }

      // Update cache
      statsCache.users.cache = stats.users
      statsCache.users.generating = false
    }

    // Albums
    if (!statsCache.albums.cache && statsCache.albums.generating) {
      stats.albums = false
    } else if (statsCache.albums.cache) {
      stats.albums = statsCache.albums.cache
    } else {
      statsCache.albums.generating = true
      statsCache.albums.generatedAt = Date.now()

      stats.albums = {
        _types: {
          number: ['total', 'active', 'downloadable', 'public', 'generatedZip']
        },
        total: 0,
        disabled: 0,
        public: 0,
        downloadable: 0,
        zipGenerated: 0
      }

      const albums = await db.table('albums')
      stats.albums.total = albums.length
      const identifiers = []
      for (const album of albums) {
        if (!album.enabled) {
          stats.albums.disabled++
          continue
        }
        if (album.download) stats.albums.downloadable++
        if (album.public) stats.albums.public++
        if (album.zipGeneratedAt) identifiers.push(album.identifier)
      }

      await Promise.all(identifiers.map(async identifier => {
        try {
          await paths.access(path.join(paths.zips, `${identifier}.zip`))
          stats.albums.zipGenerated++
        } catch (error) {
          // Re-throw error
          if (error.code !== 'ENOENT')
            throw error
        }
      }))

      // Update cache
      statsCache.albums.cache = stats.albums
      statsCache.albums.generating = false
    }

    return res.json({ success: true, stats })
  } catch (error) {
    logger.error(error)
    // Reset generating state when encountering any errors
    Object.keys(statsCache).forEach(key => {
      statsCache[key].generating = false
    })
    return res.status(500).json({ success: false, description: 'An unexpected error occurred. Try again?' })
  }
}

module.exports = self
