/*
 * ServeStatic is intended to be used last in middlewares/handlers hierarcy,
 * as it has to check the physical disks everytime to lookup for files.
 *
 * Hence for chibisafe, this is meant to be used solely to serve uploaded files,
 * if serving files with node.
 * Because of that, it optionally comes with Content-Type overrides,
 * and database query for Content-Disposition.
 *
 * This class also has Conditional GETs support,
 * which involves handling cache-related headers such as
 * If-Match, If-Unmodified-Since, ETag, etc.
 * And partial bytes fetch by handling Content-Range header,
 * which is useful for streaming, among other things.
 *
 * For other generic assets where lookups speed is a priority,
 * please use ServeStaticQuick middleware.
 */

const contentDisposition = require('content-disposition')
const etag = require('etag')
const fsPromises = require('fs/promises')
const jetpack = require('fs-jetpack')
const SimpleDataStore = require('./../utils/SimpleDataStore')
const errors = require('./../errorsController')
const utils = require('./../utilsController')
const serveUtils = require('./../utils/serveUtils')
const logger = require('./../../logger')

class ServeStatic {
  directory
  contentDispositionStore
  contentTypesMaps

  #options

  constructor (directory, options = {}) {
    if (!directory || typeof directory !== 'string') {
      throw new TypeError('Root directory must be set')
    }

    this.directory = serveUtils.forwardSlashes(directory)

    // Ensure does not end with a forward slash
    if (this.directory.endsWith('/')) {
      this.directory = this.directory.slice(0, -1)
    }

    if (options.acceptRanges === undefined) {
      options.acceptRanges = true
    }

    if (options.etag === undefined) {
      options.etag = true
    }

    if (options.ignorePatterns) {
      if (!Array.isArray(options.ignorePatterns) || options.ignorePatterns.some(pattern => typeof pattern !== 'string')) {
        throw new TypeError('Middleware option ignorePatterns must be an array of string')
      }
    }

    if (options.lastModified === undefined) {
      options.lastModified = true
    }

    if (options.setHeaders && typeof options.setHeaders !== 'function') {
      throw new TypeError('Middleware option setHeaders must be a function')
    }

    // Init Content-Type overrides map if required
    if (typeof options.overrideContentTypes === 'object') {
      this.contentTypesMaps = new Map()

      const types = Object.keys(options.overrideContentTypes)
      for (const type of types) {
        const extensions = options.overrideContentTypes[type]
        if (Array.isArray(extensions)) {
          for (const extension of extensions) {
            this.contentTypesMaps.set(extension, type)
          }
        }
      }

      if (this.contentTypesMaps.size) {
        logger.debug(`Initiated Content-Type overrides map for ${this.contentTypesMaps.size} extension(s).`)
      } else {
        this.contentTypesMaps = undefined
      }
    }

    // Init Content-Disposition store if required
    if (options.setContentDisposition) {
      this.contentDispositionStore = new SimpleDataStore(
        options.contentDispositionOptions || {
          limit: 50,
          strategy: SimpleDataStore.STRATEGIES[0]
        }
      )

      logger.debug('Initiated SimpleDataStore for Content-Disposition: ' +
         `{ limit: ${this.contentDispositionStore.limit}, strategy: "${this.contentDispositionStore.strategy}" }`)
    }

    this.#options = options
  }

  // Can be programatically called from within in-progress Requests
  // Essentially stream-based alternative for Response.download() or Response.send()
  async #handle (req, res, fullPath, stat, setHeaders) {
    const extname = utils.extname(req.path).substring(1)

    // Set Content-Type
    res.type(extname)

    // Set header fields
    await this.#setHeaders(req, res, stat, extname)

    // Per-request setHeaders, if required
    if (typeof setHeaders === 'function') {
      setHeaders(req, res)
    }

    // Conditional GET support
    if (serveUtils.assertConditionalGET(req, res)) {
      return res.end()
    }

    // ReadStream options with Content-Range support if required
    const result = serveUtils.buildReadStreamOptions(req, res, stat, this.#options.acceptRanges)
    if (!result) {
      return res.end()
    }

    // HEAD support
    if (req.method === 'HEAD') {
      // If HEAD, also set Content-Length (must be string)
      res.header('Content-Length', String(result.length))
      return res.end()
    }

    // Only set Content-Disposition on initial GET request
    // Skip for subsequent requests on non-zero start byte (e.g. streaming)
    if (result.options.start === 0 && this.contentDispositionStore) {
      await this.#setContentDisposition(req, res)
    }

    if (result.length === 0) {
      res.end()
    }

    return this.#stream(req, res, fullPath, result)
  }

  async #get (fullPath) {
    const stat = await fsPromises.stat(fullPath)

    if (stat.isDirectory()) return

    return stat
  }

  // As route handler function for HyperExpress.any()
  async #handler (req, res) {
    // Skip already-handled requests.
    if (!res || res.headersSent) return

    if (this.#options.ignorePatterns && this.#options.ignorePatterns.some(pattern => req.path.startsWith(pattern))) {
      return errors.handleNotFound(req, res)
    }

    const fullPath = this.directory + req.path
    const stat = await this.#get(fullPath)
      .catch(error => {
        // Only re-throw errors if not due to missing files
        if (error.code !== 'ENOENT') {
          throw error
        }
      })
    if (stat === undefined) {
      return errors.handleNotFound(req, res)
    }

    return this.#handle(req, res, fullPath, stat)
  }

  async #setContentDisposition (req, res) {
    // Do only if accessing files from uploads' root directory (i.e. not thumbs, etc.)
    if (req.path.indexOf('/', 1) !== -1) return

    // Encapsulate within try-catch block because we do not want these to throw
    const name = req.path.substring(1)
    try {
      let original = this.contentDispositionStore.get(name)
      if (original === undefined) {
        this.contentDispositionStore.hold(name)
        original = await utils.db.table('files')
          .where('name', name)
          .select('original')
          .first()
          .then(_file => {
            this.contentDispositionStore.set(name, _file.original)
            return _file.original
          })
      }
      if (original) {
        res.header('Content-Disposition', contentDisposition(original, { type: 'inline' }))
      }
    } catch (error) {
      this.contentDispositionStore.delete(name)
      logger.error(error)
    }
  }

  async #setHeaders (req, res, stat, extname) {
    // Override Content-Type if required
    if (this.contentTypesMaps && req.path.indexOf('/', 1) === -1) {
      // Do only if accessing files from uploads' root directory (i.e. not thumbs, etc.)
      const contentType = this.contentTypesMaps.get(extname)
      if (contentType) {
        // NOTE: Use lowercase key because the header initially set
        // with Response.type() is also lowercase
        res.header('content-type', contentType)
      }
    }

    // Always do external setHeaders function first,
    // in case it will overwrite the following default headers anyways
    if (this.#options.setHeaders) {
      this.#options.setHeaders(req, res)
    }

    if (this.#options.acceptRanges && !res.get('Accept-Ranges')) {
      res.header('Accept-Ranges', 'bytes')
    }

    if (this.#options.lastModified && !res.get('Last-Modified')) {
      const modified = stat.mtime.toUTCString()
      res.header('Last-Modified', modified)
    }

    if (this.#options.etag && !res.get('ETag')) {
      const val = etag(stat)
      res.header('ETag', val)
    }
  }

  async #stream (req, res, fullPath, result) {
    const readStream = jetpack.createReadStream(fullPath, result.options)

    readStream.on('error', error => {
      readStream.destroy()
      logger.error(error)
    })

    // 2nd param will be set as Content-Length header (must be number)
    return res.stream(readStream, result.length)
  }

  get handle () {
    return this.#handle.bind(this)
  }

  get handler () {
    return this.#handler.bind(this)
  }
}

module.exports = ServeStatic
