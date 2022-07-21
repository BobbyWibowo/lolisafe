const routes = require('express').Router()
const uploadController = require('./../controllers/uploadController')
const utils = require('./../controllers/utilsController')
const config = require('./../config')

routes.get('/nojs', async (req, res, next) => {
  return res.render('nojs', {
    config,
    utils,
    versions: utils.versionStrings
  })
})

routes.post('/nojs', (req, res, next) => {
  res._json = res.json
  res.json = (...args) => {
    const result = args[0]
    return res.render('nojs', {
      config,
      utils,
      versions: utils.versionStrings,
      errorMessage: result.success ? '' : (result.description || 'An unexpected error occurred.'),
      files: result.files || [{}]
    })
  }
  return uploadController.upload(req, res, next)
})

module.exports = routes
