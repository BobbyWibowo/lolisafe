const LiveDirectory = require('live-directory')
const serveUtils = require('./../utils/serveUtils')

class ServeLiveDirectory {
  instance

  #options

  constructor (instanceOptions = {}, options = {}) {
    if (!instanceOptions.ignore) {
      instanceOptions.ignore = path => {
        // ignore dot files
        return path.startsWith('.')
      }
    }

    this.instance = new LiveDirectory(instanceOptions)

    if (options.etag === undefined) {
      options.etag = true
    }

    if (options.lastModified === undefined) {
      options.lastModified = true
    }

    if (options.setHeaders && typeof options.setHeaders !== 'function') {
      throw new TypeError('Middleware option setHeaders must be a function')
    }

    this.#options = options
  }

  /*
   * Based on https://github.com/pillarjs/send/blob/0.18.0/index.js
   * Copyright(c) 2012 TJ Holowaychuk
   * Copyright(c) 2014-2022 Douglas Christopher Wilson
   * MIT Licensed
   */

  handler (req, res, file) {
    // set header fields
    this.#setHeaders(req, res, file)

    // set content-type
    res.type(file.extension)

    // conditional GET support
    if (serveUtils.isConditionalGET(req)) {
      if (serveUtils.isPreconditionFailure(req, res)) {
        return res.status(412).end()
      }

      if (serveUtils.isFresh(req, res)) {
        return res.status(304).end()
      }
    }

    // HEAD support
    if (req.method === 'HEAD') {
      return res.end()
    }

    return res.send(file.buffer)
  }

  #middleware (req, res, next) {
    // Only process GET and HEAD requests
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next()
    }

    const file = this.instance.get(req.path)
    if (file === undefined) {
      return next()
    }

    return this.handler(req, res, file)
  }

  #setHeaders (req, res, file) {
    // Always do external setHeaders function first,
    // in case it will overwrite the following default headers anyways
    if (this.#options.setHeaders) {
      this.#options.setHeaders(req, res)
    }

    if (this.#options.lastModified && !res.get('Last-Modified')) {
      const modified = new Date(file.last_update).toUTCString()
      res.header('Last-Modified', modified)
    }

    if (this.#options.etag && !res.get('ETag')) {
      const val = file.etag
      res.header('ETag', val)
    }
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

module.exports = ServeLiveDirectory
