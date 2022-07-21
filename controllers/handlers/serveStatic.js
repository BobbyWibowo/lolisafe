const contentDisposition = require('content-disposition')
const etag = require('etag')
const fs = require('fs')
const parseRange = require('range-parser')
const path = require('path')
const SimpleDataStore = require('./../utils/SimpleDataStore')
const errors = require('./../errorsController')
const paths = require('./../pathsController')
const utils = require('./../utilsController')
const serveUtils = require('./../utils/serveUtils')
const logger = require('./../../logger')

class ServeStatic {
  directory
  contentDispositionStore
  contentTypesMaps
  setContentDisposition
  setContentType

  #options

  constructor (directory, options = {}) {
    if (!directory || typeof directory !== 'string') {
      throw new TypeError('Root directory must be set')
    }

    this.directory = directory

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

    // Init Content-Type overrides
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
        this.setContentType = (req, res) => {
          // Do only if accessing files from uploads' root directory (i.e. not thumbs, etc.)
          if (req.path.indexOf('/', 1) === -1) {
            const name = req.path.substring(1)
            const extname = utils.extname(name).substring(1)
            const contentType = this.contentTypesMaps.get(extname)
            if (contentType) {
              res.header('Content-Type', contentType)
            }
          }
        }
      } else {
        this.contentTypesMaps = undefined
      }
    }

    // Init Content-Disposition store and setHeaders function if required
    if (options.setContentDisposition) {
      this.contentDispositionStore = new SimpleDataStore(
        options.contentDispositionOptions || {
          limit: 50,
          strategy: SimpleDataStore.STRATEGIES[0]
        }
      )

      this.setContentDisposition = async (req, res) => {
        // Do only if accessing files from uploads' root directory (i.e. not thumbs, etc.)
        if (req.path.indexOf('/', 1) !== -1) return
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

      logger.debug('Inititated SimpleDataStore for Content-Disposition: ' +
         `{ limit: ${this.contentDispositionStore.limit}, strategy: "${this.contentDispositionStore.strategy}" }`)
    }

    this.#options = options
  }

  async #get (fullPath) {
    const stat = await paths.stat(fullPath)

    if (stat.isDirectory()) return

    return stat
  }

  /*
   * Based on https://github.com/pillarjs/send/blob/0.18.0/index.js
   * Copyright(c) 2012 TJ Holowaychuk
   * Copyright(c) 2014-2022 Douglas Christopher Wilson
   * MIT Licensed
   */

  async #handler (req, res) {
    if (this.#options.ignorePatterns && this.#options.ignorePatterns.some(pattern => req.path.startsWith(pattern))) {
      return errors.handleNotFound(req, res)
    }

    const fullPath = path.join(this.directory, req.path)

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

    // ReadStream options
    let len = stat.size
    const opts = {}
    let ranges = req.headers.range
    let offset = 0

    // set content-type
    res.type(req.path)

    // set header fields
    await this.#setHeaders(req, res, stat)

    // conditional GET support
    if (serveUtils.isConditionalGET(req)) {
      if (serveUtils.isPreconditionFailure(req, res)) {
        return res.status(412).end()
      }

      if (serveUtils.isFresh(req, res)) {
        return res.status(304).end()
      }
    }

    // adjust len to start/end options
    len = Math.max(0, len - offset)
    if (opts.end !== undefined) {
      const bytes = opts.end - offset + 1
      if (len > bytes) len = bytes
    }

    // Range support
    if (this.#options.acceptRanges && serveUtils.BYTES_RANGE_REGEXP.test(ranges)) {
      // parse
      ranges = parseRange(len, ranges, {
        combine: true
      })

      // If-Range support
      if (!serveUtils.isRangeFresh(req, res)) {
        // range stale
        ranges = -2
      }

      // unsatisfiable
      if (ranges === -1) {
        // Content-Range
        res.header('Content-Range', serveUtils.contentRange('bytes', len))

        // 416 Requested Range Not Satisfiable
        return res.status(416).end()
      }

      // valid (syntactically invalid/multiple ranges are treated as a regular response)
      if (ranges !== -2 && ranges.length === 1) {
        // Content-Range
        res.status(206)
        res.header('Content-Range', serveUtils.contentRange('bytes', len, ranges[0]))

        // adjust for requested range
        offset += ranges[0].start
        len = ranges[0].end - ranges[0].start + 1
      }
    } else if (req.method === 'GET' && this.setContentDisposition) {
      // Only set Content-Disposition on complete GET requests
      // Range requests are typically when streaming
      await this.setContentDisposition(req, res)
    }

    // set read options
    opts.start = offset
    opts.end = Math.max(offset, offset + len - 1)

    // content-length
    res.header('Content-Length', String(len))

    // HEAD support
    if (req.method === 'HEAD') {
      return res.end()
    }

    return this.#stream(req, res, fullPath, opts)
  }

  async #setHeaders (req, res, stat) {
    // Override Content-Type if required
    if (this.setContentType) {
      this.setContentType(req, res)
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

  async #stream (req, res, fullPath, opts) {
    const readStream = fs.createReadStream(fullPath, opts)

    readStream.on('error', error => {
      readStream.destroy()
      logger.error(error)
    })

    return res.stream(readStream)
  }

  get handler () {
    return this.#handler.bind(this)
  }
}

module.exports = ServeStatic
