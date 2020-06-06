const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const blake3 = require('blake3')
const mkdirp = require('mkdirp')

function getFilename (req, file, cb) {
  // This won't be used since we use our own filename function.
  crypto.randomBytes(16, function (err, raw) {
    cb(err, err ? undefined : raw.toString('hex'))
  })
}

function getDestination (req, file, cb) {
  cb(null, os.tmpdir())
}

function DiskStorage (opts) {
  this.getFilename = (opts.filename || getFilename)

  if (typeof opts.destination === 'string') {
    mkdirp.sync(opts.destination)
    this.getDestination = function ($0, $1, cb) { cb(null, opts.destination) }
  } else {
    this.getDestination = (opts.destination || getDestination)
  }
}

DiskStorage.prototype._handleFile = function _handleFile (req, file, cb) {
  const that = this

  that.getDestination(req, file, function (err, destination) {
    if (err) return cb(err)

    that.getFilename(req, file, function (err, filename) {
      if (err) return cb(err)

      const finalPath = path.join(destination, filename)
      const outStream = fs.createWriteStream(finalPath)

      let hash = null
      if (!file._ischunk) {
        hash = blake3.createHash()
        const onerror = function (err) {
          hash.dispose()
          cb(err)
        }
        outStream.on('error', onerror)
        file.stream.on('error', onerror)
        file.stream.on('data', d => hash.update(d))
      } else {
        outStream.on('error', cb)
      }

      file.stream.pipe(outStream)
      outStream.on('finish', function () {
        cb(null, {
          destination,
          filename,
          path: finalPath,
          size: outStream.bytesWritten,
          hash: hash && hash.digest('hex')
        })
      })
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
