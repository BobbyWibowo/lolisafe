const { Router } = require('hyper-express')
const routes = new Router()
const uploadController = require('./../controllers/uploadController')
const utils = require('./../controllers/utilsController')
const config = require('./../config')

routes.get('/nojs', async (req, res) => {
  return res.render('nojs', {
    config,
    utils,
    versions: utils.versionStrings
  })
})

routes.post('/nojs', async (req, res) => {
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
  return uploadController.upload(req, res)
}, {
  // HyperExpress defaults to 250kb
  // https://github.com/kartikk221/hyper-express/blob/6.2.4/docs/Server.md#server-constructor-options
  max_body_length: parseInt(config.uploads.maxSize) * 1e6
})

module.exports = routes
