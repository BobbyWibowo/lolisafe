const ClientError = require('./../utils/ClientError')
const ServerError = require('./../utils/ServerError')
const logger = require('./../../logger')

module.exports = (error, req, res, next) => {
  if (!res) {
    return logger.error(new Error('Missing "res" object.'))
  }

  // Error messages that can be returned to users
  const isClientError = error instanceof ClientError
  const isServerError = error instanceof ServerError

  const logStack = (!isClientError && !isServerError) ||
    (isServerError && error.logStack)
  if (logStack) {
    logger.error(error)
  }

  const statusCode = (isClientError || isServerError)
    ? error.statusCode
    : 500

  const json = {}

  const description = (isClientError || isServerError)
    ? error.message
    : 'An unexpected error occurred. Try again?'
  if (description) {
    json.description = description
  }

  if ((isClientError || isServerError) && error.code) {
    json.code = error.code
  }

  if (Object.keys(json).length) {
    json.success = false
    return res.status(statusCode).json(json)
  } else {
    return res.status(statusCode).end()
  }
}
