const path = require('path')
const paths = require('./pathsController')
const ClientError = require('./utils/ClientError')
const ServerError = require('./utils/ServerError')
const config = require('./../config')
const logger = require('./../logger')

const self = {
  errorPagesCodes: Object.keys(config.errorPages)
    .filter(key => /^\d+$/.test(key))
    .map(key => Number(key))
}

self.handleError = (req, res, error) => {
  if (!res || res.headersSent) {
    logger.error('Error: Unexpected missing "res" object or headers alredy sent.')
    return logger.error(error)
  }

  res.header('Cache-Control', 'no-store')

  // Errors that should be returned to users as JSON payload
  const isClientError = error instanceof ClientError
  const isServerError = error instanceof ServerError

  let statusCode = res.statusCode

  if (isClientError || isServerError) {
    if (isServerError && error.logStack) {
      logger.error(error)
    }

    const json = {
      success: false,
      description: error.message || 'An unexpected error occurred. Try again?',
      code: error.code
    }

    if (statusCode === undefined) {
      res.status(error.statusCode || 500)
    }

    return res.json(json)
  } else {
    // Generic Errors
    logger.error(error)

    if (statusCode === undefined) {
      statusCode = 500
    }

    if (self.errorPagesCodes.includes(statusCode)) {
      return res
        .status(statusCode)
        .sendFile(path.join(paths.errorRoot, config.errorPages[statusCode]))
    } else {
      return res
        .status(statusCode)
        .end()
    }
  }
}

self.handleNotFound = (req, res) => {
  res.header('Cache-Control', 'no-store')
  return res
    .status(404)
    .sendFile(path.join(paths.errorRoot, config.errorPages[404]))
}

module.exports = self
