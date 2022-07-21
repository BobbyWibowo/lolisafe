const routes = require('express').Router()
const utils = require('../controllers/utilsController')
const config = require('../config')

routes.get([
  '/file/:identifier'
], async (req, res, next) => {
  // Uploads identifiers parsing, etc., are strictly handled by client-side JS at src/js/file.js
  return res.render('file', {
    config, utils, versions: utils.versionStrings
  })
})

module.exports = routes
