const { promisify } = require('util')
const AbortController = require('abort-controller')
const fastq = require('fastq')
const fetch = require('node-fetch')
const ffmpeg = require('fluent-ffmpeg')
const jetpack = require('fs-jetpack')
const knex = require('knex')
const MarkdownIt = require('markdown-it')
const path = require('path')
const sharp = require('sharp')
const paths = require('./pathsController')
const perms = require('./permissionController')
const ClientError = require('./utils/ClientError')
const Constants = require('./utils/Constants')
const ServerError = require('./utils/ServerError')
const SimpleDataStore = require('./utils/SimpleDataStore')
const StatsManager = require('./utils/StatsManager')
const config = require('./utils/ConfigManager')
const logger = require('./../logger')

const devmode = process.env.NODE_ENV === 'development'

const self = {
  devmode,
  inspect: devmode && require('util').inspect,

  db: knex(config.database),
  md: {
    instance: new MarkdownIt({
      // https://markdown-it.github.io/markdown-it/#MarkdownIt.new
      html: false,
      breaks: true,
      linkify: true
    }),
    defaultRenderers: {}
  },
  gitHash: null,

  idMaxTries: config.uploads.maxTries || 1,

  stripTagsBlacklistedExts: Array.isArray(config.uploads.stripTags.blacklistExtensions)
    ? config.uploads.stripTags.blacklistExtensions
    : [],

  thumbsSize: config.uploads.generateThumbs.size || 200,
  ffprobe: promisify(ffmpeg.ffprobe),

  timezoneOffset: new Date().getTimezoneOffset(),

  retentions: {
    enabled: false,
    periods: {},
    default: {}
  },

  albumRenderStore: new SimpleDataStore({
    limit: 10,
    strategy: SimpleDataStore.STRATEGIES[0]
  }),
  contentDispositionStore: null
}

// Remember old renderer, if overridden, or proxy to default renderer
self.md.defaultRenderers.link_open = self.md.instance.renderer.rules.link_open || function (tokens, idx, options, env, that) {
  return that.renderToken(tokens, idx, options)
}

// Add target="_blank" to URLs if applicable
self.md.instance.renderer.rules.link_open = function (tokens, idx, options, env, that) {
  const aIndex = tokens[idx].attrIndex('target')
  if (aIndex < 0) {
    tokens[idx].attrPush(['target', '_blank'])
  } else {
    tokens[idx].attrs[aIndex][1] = '_blank'
  }
  return self.md.defaultRenderers.link_open(tokens, idx, options, env, that)
}

if (typeof config.uploads.retentionPeriods === 'object' &&
  Object.keys(config.uploads.retentionPeriods).length) {
  // Build a temporary index of group values
  const _retentionPeriods = Object.assign({}, config.uploads.retentionPeriods)
  const _groups = { _: -1 }
  Object.assign(_groups, perms.permissions)

  // Sanitize config values
  const names = Object.keys(_groups)
  for (const name of names) {
    if (Array.isArray(_retentionPeriods[name]) && _retentionPeriods[name].length) {
      _retentionPeriods[name] = _retentionPeriods[name]
        .filter((v, i, a) => (Number.isFinite(v) && v >= 0) || v === null)
    } else {
      _retentionPeriods[name] = []
    }
  }

  if (!_retentionPeriods._.length && !config.private) {
    logger.error('Guests\' retention periods are missing, yet this installation is not set to private.')
    process.exit(1)
  }

  // Create sorted array of group names based on their values
  const _sorted = Object.keys(_groups)
    .sort((a, b) => _groups[a] - _groups[b])

  // Build retention periods array for each groups
  for (let i = 0; i < _sorted.length; i++) {
    const current = _sorted[i]
    const _periods = [..._retentionPeriods[current]]
    self.retentions.default[current] = _periods.length ? _periods[0] : null

    if (i > 0) {
      // Inherit retention periods of lower-valued groups
      for (let j = i - 1; j >= 0; j--) {
        const lower = _sorted[j]
        if (_groups[lower] < _groups[current]) {
          _periods.unshift(..._retentionPeriods[lower])
          if (self.retentions.default[current] === null) {
            self.retentions.default[current] = self.retentions.default[lower]
          }
        }
      }
    }

    self.retentions.periods[current] = _periods
      .filter((v, i, a) => v !== null && a.indexOf(v) === i) // re-sanitize & uniquify
      .sort((a, b) => a - b) // sort from lowest to highest (zero/permanent will always be first)

    // Mark the feature as enabled, if at least one group was configured
    if (self.retentions.periods[current].length) {
      self.retentions.enabled = true
    }
  }
} else if (Array.isArray(config.uploads.temporaryUploadAges) && config.uploads.temporaryUploadAges.length) {
  self.retentions.periods._ = config.uploads.temporaryUploadAges
    .filter((v, i, a) => Number.isFinite(v) && v >= 0)
  self.retentions.default._ = self.retentions.periods._[0]

  for (const name of Object.keys(perms.permissions)) {
    self.retentions.periods[name] = self.retentions.periods._
    self.retentions.default[name] = self.retentions.default._
  }

  self.retentions.enabled = true
}

// This helper function initiates fetch() with AbortController
// signal controller to handle per-instance global timeout.
// node-fetch's built-in timeout option resets on every redirect,
// and thus not reliable in certain cases.
self.fetch = (url, options = {}) => {
  if (options.timeout === undefined) {
    return fetch(url, options)
  }

  // Init AbortController
  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    abortController.abort()
  }, options.timeout)

  // Clean up options object
  options.signal = abortController.signal
  delete options.timeout

  // Return instance with an attached Promise.finally() handler to clear timeout
  return fetch(url, options)
    .finally(() => {
      clearTimeout(timeout)
    })
}

const cloudflareAuth = config.cloudflare && config.cloudflare.zoneId &&
  (config.cloudflare.apiToken || config.cloudflare.userServiceKey ||
  (config.cloudflare.apiKey && config.cloudflare.email))

const cloudflarePurgeCacheQueue = cloudflareAuth && fastq.promise(async chunk => {
  const MAX_TRIES = 3
  const url = `https://api.cloudflare.com/client/v4/zones/${config.cloudflare.zoneId}/purge_cache`

  const result = {
    success: false,
    files: chunk,
    errors: []
  }

  const headers = {
    'Content-Type': 'application/json'
  }
  if (config.cloudflare.apiToken) {
    headers.Authorization = `Bearer ${config.cloudflare.apiToken}`
  } else if (config.cloudflare.userServiceKey) {
    headers['X-Auth-User-Service-Key'] = config.cloudflare.userServiceKey
  } else if (config.cloudflare.apiKey && config.cloudflare.email) {
    headers['X-Auth-Key'] = config.cloudflare.apiKey
    headers['X-Auth-Email'] = config.cloudflare.email
  }

  for (let i = 0; i < MAX_TRIES; i++) {
    const _log = message => {
      let prefix = `[CF]: ${i + 1}/${MAX_TRIES}: ${path.basename(chunk[0])}`
      if (chunk.length > 1) prefix += ',\u2026'
      logger.log(`${prefix}: ${message}`)
    }

    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ files: chunk }),
      headers
    })
      .then(res => res.json())
      .catch(error => error)

    // If fetch errors out, instead of API responding with API errors
    if (response instanceof Error) {
      const errorString = response.toString()
      if (i < MAX_TRIES - 1) {
        _log(`${errorString}. Retrying in 5 seconds\u2026`)
        await new Promise(resolve => setTimeout(resolve, 5000))
        continue
      }
      result.errors = [errorString]
      break
    }

    // If API reponds with API errors
    const hasErrorsArray = Array.isArray(response.errors) && response.errors.length
    if (hasErrorsArray) {
      const rateLimit = response.errors.find(error => /rate limit/i.test(error.message))
      if (rateLimit && i < MAX_TRIES - 1) {
        _log(`${rateLimit.code}: ${rateLimit.message}. Retrying in a minute\u2026`)
        await new Promise(resolve => setTimeout(resolve, 60000))
        continue
      }
    }

    // If succeeds or out of retries
    result.success = response.success
    result.errors = hasErrorsArray
      ? response.errors.map(error => `${error.code}: ${error.message}`)
      : []
    break
  }

  return result
}, 1) // concurrency: 1

self.mayGenerateThumb = extname => {
  extname = extname.toLowerCase()
  return (config.uploads.generateThumbs.image && Constants.IMAGE_EXTS.includes(extname)) ||
    (config.uploads.generateThumbs.video && Constants.VIDEO_EXTS.includes(extname))
}

self.isAnimatedThumb = extname => {
  extname = extname.toLowerCase()
  return (config.uploads.generateThumbs.animated && Constants.ANIMATED_EXTS.includes(extname))
}

// Expand if necessary (should be case-insensitive)
const extPreserves = [
  /\.tar\.\w+/i // tarballs
]

self.extname = (filename, lower) => {
  // Always return blank string if the filename does not seem to have a valid extension
  // Files such as .DS_Store (anything that starts with a dot, without any extension after) will still be accepted
  if (!/\../.test(filename)) return ''

  let multi = ''
  let extname = ''

  // check for multi-archive extensions (.001, .002, and so on)
  if (/\.\d{3}$/.test(filename)) {
    multi = filename.slice(filename.lastIndexOf('.') - filename.length)
    filename = filename.slice(0, filename.lastIndexOf('.'))
  }

  // check against extensions that must be preserved
  for (const extPreserve of extPreserves) {
    const match = filename.match(extPreserve)
    if (match && match[0]) {
      extname = match[0]
      break
    }
  }

  if (!extname) {
    extname = filename.slice(filename.lastIndexOf('.') - filename.length)
  }

  const str = extname + multi
  return lower ? str.toLowerCase() : str
}

const escapeMap = {
  '&': '&amp;',
  '"': '&quot;',
  '\'': '&#39;',
  '<': '&lt;',
  '>': '&gt;',
  '\\': '&#92;'
}

const escapeRegex = /[&"'<>\\]/g

const unescapeMap = Object.keys(escapeMap).reduce((ret, key) => {
  ret[escapeMap[key]] = key
  return ret
}, {})

const unescapeRegex = /&(amp|quot|#39|lt|gt|#92);/g

self.escape = string => {
  return string.replace(escapeRegex, key => escapeMap[key])
}

self.unescape = string => {
  return string.replace(unescapeRegex, key => unescapeMap[key])
}

self.stripIndents = string => {
  if (!string) return string
  const result = string.replace(/^[^\S\n]+/gm, '')
  const match = result.match(/^[^\S\n]*(?=\S)/gm)
  const indent = match && Math.min(...match.map(el => el.length))
  if (indent) {
    const regexp = new RegExp(`^.{${indent}}`, 'gm')
    return result.replace(regexp, '')
  }
  return result
}

self.mask = string => {
  if (!string) return string
  const max = Math.min(Math.floor(string.length / 2), 8)
  const fragment = Math.floor(max / 2)
  if (string.length <= fragment) {
    return '*'.repeat(string.length)
  } else {
    return string.substring(0, fragment) +
      '*'.repeat(Math.min(string.length - (fragment * 2), 4)) +
      string.substring(string.length - fragment)
  }
}

self.pathSafeIp = ip => {
  // Mainly intended for IPv6 addresses
  if (!ip) return ''
  return ip.replace(/:/g, '-')
}

self.filterUniquifySqlArray = (value, index, array) => {
  return value !== null &&
    value !== undefined &&
    value !== '' &&
    array.indexOf(value) === index
}

self.unlistenEmitters = (emitters, eventName, listener) => {
  emitters.forEach(emitter => {
    if (!emitter) return
    emitter.off(eventName, listener)
  })
}

self.assertRequestType = (req, type) => {
  if (!req.is(type)) {
    throw new ClientError(`Request Content-Type must be ${type}.`)
  }
}

self.assertJSON = async (req, res) => {
  // Assert Request Content-Type
  self.assertRequestType(req, 'application/json')
  // Parse JSON payload
  req.body = await req.json()
}

self.generateThumbs = async (name, extname, force) => {
  extname = extname.toLowerCase()
  const thumbname = name.slice(0, -extname.length)
  let thumbext = '.png'
  if (self.isAnimatedThumb(extname)) thumbext = '.gif'

  const thumbfile = path.join(paths.thumbs, thumbname + thumbext)

  try {
    // Check if old static thumbnail exists, then unlink it
    if (thumbext === '.gif') {
      const staticthumb = path.join(paths.thumbs, thumbname + '.png')
      const stat = await jetpack.inspectAsync(staticthumb)
      if (stat) {
        await jetpack.removeAsync(staticthumb)
      }
    }

    // Check if thumbnail already exists
    const stat = await jetpack.inspectAsync(thumbfile)
    if (stat) {
      if (stat.type === 'symlink') {
        // Unlink if symlink (should be symlink to the placeholder)
        await jetpack.removeAsync(thumbfile)
      } else if (!force) {
        // Continue only if it does not exist, unless forced to
        return true
      }
    }

    // Full path to input file
    const input = path.join(paths.uploads, name)

    // If image extension
    if (Constants.IMAGE_EXTS.includes(extname)) {
      const sharpOptions = {}
      if (thumbext === '.gif') {
        sharpOptions.animated = true
      }

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

      const image = sharp(input, sharpOptions)

      const metadata = await image.metadata()
      if (metadata.width > resizeOptions.width || metadata.height > resizeOptions.height) {
        await image
          .resize(resizeOptions)
          .toFile(thumbfile)
      } else if (metadata.width === resizeOptions.width && metadata.height === resizeOptions.height) {
        await image
          .toFile(thumbfile)
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
          .toFile(thumbfile)
      }
    } else if (Constants.VIDEO_EXTS.includes(extname)) {
      const metadata = await self.ffprobe(input)

      const duration = parseInt(metadata.format.duration)
      if (isNaN(duration)) {
        throw new Error('File does not have valid duration metadata')
      }

      const videoStream = metadata.streams && metadata.streams.find(s => s.codec_type === 'video')
      if (!videoStream || !videoStream.width || !videoStream.height) {
        throw new Error('File does not have valid video stream metadata')
      }

      await new Promise((resolve, reject) => {
        ffmpeg(input)
          .on('error', error => reject(error))
          .on('end', () => resolve())
          .screenshots({
            folder: paths.thumbs,
            filename: name.slice(0, -extname.length) + '.png',
            timemarks: [
              config.uploads.generateThumbs.videoTimemark || '20%'
            ],
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
          if (await jetpack.existsAsync(thumbfile)) {
            return true
          } else {
            throw error || new Error('FFMPEG exited with empty output file')
          }
        })
    } else {
      return false
    }
  } catch (error) {
    logger.error(`[${name}]: generateThumbs(): ${error.toString().trim()}`)
    await jetpack.removeAsync(thumbfile) // try to unlink incomplete thumbs first
    try {
      await jetpack.symlinkAsync(paths.thumbPlaceholder, thumbfile)
      return true
    } catch (err) {
      logger.error(`[${name}]: generateThumbs(): ${err.toString().trim()}`)
      return false
    }
  }

  return true
}

self.stripTags = async (name, extname) => {
  extname = extname.toLowerCase()
  if (self.stripTagsBlacklistedExts.includes(extname)) return false

  const fullPath = path.join(paths.uploads, name)
  let tmpPath
  let isError

  try {
    if (Constants.IMAGE_EXTS.includes(extname)) {
      const tmpName = `tmp-${name}`
      tmpPath = path.join(paths.uploads, tmpName)
      await jetpack.renameAsync(fullPath, tmpName)
      await sharp(tmpPath)
        .toFile(fullPath)
    } else if (config.uploads.stripTags.video && Constants.VIDEO_EXTS.includes(extname)) {
      const tmpName = `tmp-${name}`
      tmpPath = path.join(paths.uploads, tmpName)
      await jetpack.renameAsync(fullPath, tmpName)
      await new Promise((resolve, reject) => {
        ffmpeg(tmpPath)
          .output(fullPath)
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
    } else {
      return false
    }
  } catch (error) {
    logger.error(`[${name}]: stripTags(): ${error.toString().trim()}`)
    isError = true
  }

  if (tmpPath) {
    await jetpack.removeAsync(tmpPath)
  }

  if (isError) {
    throw new ServerError('An error occurred while stripping tags. The format may not be supported.')
  }

  return jetpack.inspectAsync(fullPath)
}

self.unlinkFile = async filename => {
  await jetpack.removeAsync(path.join(paths.uploads, filename))

  const identifier = filename.split('.')[0]
  const extname = self.extname(filename, true)

  if (Constants.IMAGE_EXTS.includes(extname) || Constants.VIDEO_EXTS.includes(extname)) {
    await jetpack.removeAsync(path.join(paths.thumbs, `${identifier}.png`))
  }
}

self.bulkDeleteFromDb = async (field, values = [], user, permissionBypass = false) => {
  // NOTE: permissionBypass should not be set unless used by chibisafe's automated service.

  if ((!user && !permissionBypass) || !['id', 'name'].includes(field) || !values.length) {
    return values
  }

  // SQLITE_LIMIT_VARIABLE_NUMBER, which defaults to 999
  // Read more: https://www.sqlite.org/limits.html
  const MAX_VARIABLES_CHUNK_SIZE = 999
  const chunks = []
  while (values.length) {
    chunks.push(values.splice(0, MAX_VARIABLES_CHUNK_SIZE))
  }

  const failed = []
  const ismoderator = permissionBypass || perms.is(user, 'moderator')

  try {
    const unlinkeds = []
    const albumids = []

    // NOTE: Not wrapped within a Transaction because
    // we cannot rollback files physically unlinked from the storage
    await Promise.all(chunks.map(async chunk => {
      const files = await self.db.table('files')
        .whereIn(field, chunk)
        .where(function () {
          if (!ismoderator) {
            this.where('userid', user.id)
          }
        })

      // Push files that could not be found in db
      failed.push(...chunk.filter(value => !files.find(file => file[field] === value)))

      // Unlink all found files
      const unlinked = []

      await Promise.all(files.map(async file => {
        try {
          await self.unlinkFile(file.name)
          unlinked.push(file)
        } catch (error) {
          logger.error(error)
          failed.push(file[field])
        }
      }))

      if (!unlinked.length) return

      // Delete all unlinked files from db
      await self.db.table('files')
        .whereIn('id', unlinked.map(file => file.id))
        .del()
      self.invalidateStatsCache('uploads')

      unlinked.forEach(file => {
        // Push album ids
        if (file.albumid && !albumids.includes(file.albumid)) {
          albumids.push(file.albumid)
        }
        // Delete from Content-Disposition store if used
        if (self.contentDispositionStore) {
          self.contentDispositionStore.delete(file.name)
        }
      })

      // Push unlinked files
      unlinkeds.push(...unlinked)
    }))

    if (unlinkeds.length) {
      // Update albums if necessary, but do not wait
      if (albumids.length) {
        self.db.table('albums')
          .whereIn('id', albumids)
          .update('editedAt', Math.floor(Date.now() / 1000))
          .catch(logger.error)
        self.deleteStoredAlbumRenders(albumids)
      }

      // Purge Cloudflare's cache if necessary, but do not wait
      if (config.cloudflare.purgeCache) {
        self.purgeCloudflareCache(unlinkeds.map(file => file.name), true, true)
          .then(results => {
            for (const result of results) {
              if (result.errors.length) {
                result.errors.forEach(error => logger.error(`[CF]: ${error}`))
              }
            }
          })
      }
    }
  } catch (error) {
    logger.error(error)
  }

  return failed
}

self.purgeCloudflareCache = async (names, uploads, thumbs) => {
  const errors = []
  if (!cloudflareAuth) {
    errors.push('Cloudflare auth is incomplete or missing')
  }
  if (!Array.isArray(names) || !names.length) {
    errors.push('Names array is invalid or empty')
  }
  if (errors.length) {
    return [{ success: false, files: [], errors }]
  }

  let domain = config.domain
  if (!uploads) domain = config.homeDomain

  const thumbNames = []
  names = names.map(name => {
    if (uploads) {
      const url = `${domain}/${name}`
      const extname = self.extname(name)
      if (thumbs && self.mayGenerateThumb(extname)) {
        thumbNames.push(`${domain}/thumbs/${name.slice(0, -extname.length)}.png`)
      }
      return url
    } else {
      return name === 'home' ? domain : `${domain}/${name}`
    }
  })
  names.push(...thumbNames)

  // Split array into multiple arrays with max length of 30 URLs
  // https://api.cloudflare.com/#zone-purge-files-by-url
  const MAX_LENGTH = 30
  const chunks = []
  while (names.length) {
    chunks.push(names.splice(0, MAX_LENGTH))
  }

  const results = []
  for (const chunk of chunks) {
    const result = await cloudflarePurgeCacheQueue.push(chunk)
    results.push(result)
  }
  return results
}

self.bulkDeleteExpired = async (dryrun, verbose) => {
  const timestamp = Date.now() / 1000
  const fields = ['id']
  if (verbose) fields.push('name')

  const result = {}
  result.expired = await self.db.table('files')
    .where('expirydate', '<=', timestamp)
    .select(fields)

  if (!dryrun) {
    // Make a shallow copy
    const field = fields[0]
    const values = result.expired.slice().map(row => row[field])
    // NOTE: 4th parameter set to true to bypass permission check
    result.failed = await self.bulkDeleteFromDb(field, values, null, true)
    if (verbose && result.failed.length) {
      result.failed = result.failed
        .map(failed => result.expired.find(file => file[fields[0]] === failed))
    }
  }
  return result
}

self.deleteStoredAlbumRenders = albumids => {
  for (const albumid of albumids) {
    self.albumRenderStore.delete(`${albumid}`)
    self.albumRenderStore.delete(`${albumid}-nojs`)
  }
}

/** Statistics API **/

self.invalidateStatsCache = StatsManager.invalidateStatsCache

self.buildStatsPayload = name => {
  return {
    ...((StatsManager.cachedStats[name] && StatsManager.cachedStats[name].cache) || {}),
    meta: {
      key: name,
      ...(StatsManager.cachedStats[name]
        ? {
            cached: Boolean(StatsManager.cachedStats[name].cache),
            generatedOn: StatsManager.cachedStats[name].generatedOn || 0,
            maxAge: typeof StatsManager.statGenerators[name].maxAge === 'number'
              ? StatsManager.statGenerators[name].maxAge
              : null
          }
        : {
            cached: false
          }),
      type: StatsManager.Type.HIDDEN
    }
  }
}

self.stats = async (req, res) => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    return res.status(403).end()
  }

  const hrstart = process.hrtime()

  await StatsManager.generateStats(self.db)

  // Ensures object payload has its keys matching the required ordering
  const stats = StatsManager.statNames.reduce((acc, name) => {
    const title = StatsManager.statGenerators[name].title
    acc[title] = self.buildStatsPayload(name)
    return acc
  }, {})

  return res.json({ success: true, stats, hrtime: process.hrtime(hrstart) })
}

self.statsCategory = async (req, res) => {
  const isadmin = perms.is(req.locals.user, 'admin')
  if (!isadmin) {
    return res.status(403).end()
  }

  const category = req.path_parameters && req.path_parameters.category
  if (!category || !StatsManager.statNames.includes(category)) {
    throw new ClientError('Bad request.')
  }

  const hrstart = process.hrtime()

  // Generate required stats category, forced
  await StatsManager.generateStats(self.db, [category], true)

  const title = StatsManager.statGenerators[category].title
  const stats = {
    [title]: self.buildStatsPayload(category)
  }

  return res.json({ success: true, stats, hrtime: process.hrtime(hrstart) })
}

module.exports = self
