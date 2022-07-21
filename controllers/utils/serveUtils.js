const fresh = require('fresh')

const self = {
  BYTES_RANGE_REGEXP: /^ *bytes=/
}

self.isFresh = (req, res) => {
  return fresh(req.headers, {
    etag: res.get('ETag'),
    'last-modified': res.get('Last-Modified')
  })
}

/*
 * Based on https://github.com/pillarjs/send/blob/0.18.0/index.js
 * Copyright(c) 2012 TJ Holowaychuk
 * Copyright(c) 2014-2022 Douglas Christopher Wilson
 * MIT Licensed
 */

self.isRangeFresh = (req, res) => {
  const ifRange = req.headers['if-range']

  if (!ifRange) {
    return true
  }

  // if-range as etag
  if (ifRange.indexOf('"') !== -1) {
    const etag = res.get('ETag')
    return Boolean(etag && ifRange.indexOf(etag) !== -1)
  }

  // if-range as modified date
  const lastModified = res.get('Last-Modified')
  return self.parseHttpDate(lastModified) <= self.parseHttpDate(ifRange)
}

self.isConditionalGET = req => {
  return req.headers['if-match'] ||
    req.headers['if-unmodified-since'] ||
    req.headers['if-none-match'] ||
    req.headers['if-modified-since']
}

self.isPreconditionFailure = (req, res) => {
  // if-match
  const match = req.headers['if-match']
  if (match) {
    const etag = res.get('ETag')
    return !etag || (match !== '*' && self.parseTokenList(match).every(match => {
      return match !== etag && match !== 'W/' + etag && 'W/' + match !== etag
    }))
  }

  // if-unmodified-since
  const unmodifiedSince = self.parseHttpDate(req.headers['if-unmodified-since'])
  if (!isNaN(unmodifiedSince)) {
    const lastModified = self.parseHttpDate(res.get('Last-Modified'))
    return isNaN(lastModified) || lastModified > unmodifiedSince
  }

  return false
}

self.contentRange = (type, size, range) => {
  return type + ' ' + (range ? range.start + '-' + range.end : '*') + '/' + size
}

self.parseHttpDate = date => {
  const timestamp = date && Date.parse(date)

  return typeof timestamp === 'number'
    ? timestamp
    : NaN
}

self.parseTokenList = str => {
  let end = 0
  const list = []
  let start = 0

  // gather tokens
  for (let i = 0, len = str.length; i < len; i++) {
    switch (str.charCodeAt(i)) {
      case 0x20: /*   */
        if (start === end) {
          start = end = i + 1
        }
        break
      case 0x2c: /* , */
        if (start !== end) {
          list.push(str.substring(start, end))
        }
        start = end = i + 1
        break
      default:
        end = i + 1
        break
    }
  }

  // final token
  if (start !== end) {
    list.push(str.substring(start, end))
  }

  return list
}

module.exports = self
