const routes = require('express').Router()
const utils = require('./../controllers/utilsController')
const config = require('./../config')

routes.get([
  '/player/:identifier',
  '/v/:identifier'
], async (req, res, next) => {
  // Uploads identifiers parsing, etc., are strictly handled by client-side JS at src/js/player.js
  return res.render('player', {
    config, utils, versions: utils.versionStrings
  })
})

module.exports = routes
