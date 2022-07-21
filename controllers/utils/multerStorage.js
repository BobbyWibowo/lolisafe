const fs = require('fs')
const path = require('path')
const blake3 = require('blake3')
const mkdirp = require('mkdirp')
const logger = require('./../../logger')

const REQUIRED_WEIGHT = 2

function DiskStorage (opts) {
  this.getFilename = opts.filename

  if (typeof opts.destination === 'string') {
    mkdirp.sync(opts.destination)
    this.getDestination = function ($0, $1, cb) { cb(null, opts.destination) }
  } else {
    this.getDestination = opts.destination
  }

  this.scan = opts.scan
  this.scanHelpers = opts.scanHelpers
}

DiskStorage.prototype._handleFile = function _handleFile (req, file, cb) {
  const that = this

  // "weighted" callback, to be able to "await" multiple callbacks
  let tempError = null
  let tempObject = {}
  let tempWeight = 0
  const _cb = (err = null, result = {}, weight = 2) => {
    tempError = err
    tempWeight += weight
    tempObject = Object.assign(result, tempObject)
    if (tempError || tempWeight >= REQUIRED_WEIGHT) {
      cb(tempError, tempObject)
    }
  }

  that.getDestination(req, file, function (err, destination) {
    if (err) return _cb(err)

    that.getFilename(req, file, function (err, filename) {
      if (err) return _cb(err)

      const finalPath = path.join(destination, filename)
      const onerror = err => {
        hash.dispose()
        _cb(err)
      }

      let outStream
      let hash
      let scanStream
      if (file._isChunk) {
        if (!file._chunksData.stream) {
          file._chunksData.stream = fs.createWriteStream(finalPath, { flags: 'a' })
          file._chunksData.stream.on('error', onerror)
        }
        if (!file._chunksData.hasher) {
          file._chunksData.hasher = blake3.createHash()
        }

        outStream = file._chunksData.stream
        hash = file._chunksData.hasher
      } else {
        outStream = fs.createWriteStream(finalPath)
        outStream.on('error', onerror)
        hash = blake3.createHash()

        if (that.scan.passthrough &&
          !that.scanHelpers.assertUserBypass(req._user, filename) &&
          !that.scanHelpers.assertFileBypass({ filename })) {
          scanStream = that.scan.instance.passthrough()
        }
      }

      file.stream.on('error', onerror)
      file.stream.on('data', d => hash.update(d))

      if (file._isChunk) {
        file.stream.on('end', () => {
          _cb(null, {
            destination,
            filename,
            path: finalPath
          })
        })
        file.stream.pipe(outStream, { end: false })
      } else {
        outStream.on('finish', () => {
          _cb(null, {
            destination,
            filename,
            path: finalPath,
            size: outStream.bytesWritten,
            hash: hash.digest('hex')
          }, scanStream ? 1 : 2)
        })

        if (scanStream) {
          logger.debug(`[ClamAV]: ${filename}: Passthrough scanning\u2026`)
          scanStream.on('error', onerror)
          scanStream.on('scan-complete', scan => {
            _cb(null, { scan }, 1)
          })
          file.stream.pipe(scanStream).pipe(outStream)
        } else {
          file.stream.pipe(outStream)
        }
      }
    })
  })
}

DiskStorage.prototype._removeFile = function _removeFile (req, file, cb) {
  const path = file.path

  delete file.destination
  delete file.filename
  delete file.path

  fs.unlink(path, cb)
}

module.exports = function (opts) {
  return new DiskStorage(opts)
}
