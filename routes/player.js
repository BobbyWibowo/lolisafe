const { Router } = require('hyper-express')
const routes = new Router()
const utils = require('./../controllers/utilsController')
const config = require('./../config')

const playerHandler = async (req, res) => {
  // Uploads identifiers parsing, etc., are strictly handled by client-side JS at src/js/player.js
  return res.render('player', {
    config, utils, versions: utils.versionStrings
  })
}

routes.get('/player/:identifier', playerHandler)
routes.get('/v/:identifier', playerHandler)

module.exports = routes
