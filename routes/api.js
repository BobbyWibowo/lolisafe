const { Router } = require('hyper-express')
const routes = new Router()
const albumsController = require('./../controllers/albumsController')
const authController = require('./../controllers/authController')
const tokenController = require('./../controllers/tokenController')
const uploadController = require('./../controllers/uploadController')
const utilsController = require('./../controllers/utilsController')
const config = require('./../config')

routes.get('/check', async (req, res) => {
  const obj = {
    private: config.private,
    enableUserAccounts: config.enableUserAccounts,
    maxSize: config.uploads.maxSize,
    chunkSize: config.uploads.chunkSize,
    fileIdentifierLength: config.uploads.fileIdentifierLength,
    stripTags: config.uploads.stripTags
  }
  if (utilsController.retentions.enabled && utilsController.retentions.periods._) {
    obj.temporaryUploadAges = utilsController.retentions.periods._
    obj.defaultTemporaryUploadAge = utilsController.retentions.default._
  }
  if (utilsController.clientVersion) {
    obj.version = utilsController.clientVersion
  }

  return res.json(obj)
})

routes.post('/login', authController.verify)
routes.post('/register', authController.register)
routes.post('/password/change', authController.changePassword)
routes.get('/uploads', uploadController.list)
routes.get('/uploads/:page', uploadController.list)
routes.post('/upload', uploadController.upload, {
  // HyperExpress defaults to 250kb
  // https://github.com/kartikk221/hyper-express/blob/6.2.4/docs/Server.md#server-constructor-options
  max_body_length: parseInt(config.uploads.maxSize) * 1e6
})
routes.post('/upload/delete', uploadController.delete)
routes.post('/upload/bulkdelete', uploadController.bulkDelete)
routes.post('/upload/finishchunks', uploadController.finishChunks)
routes.get('/upload/get/:identifier', uploadController.get)
routes.post('/upload/:albumid', uploadController.upload)
routes.get('/album/get/:identifier', albumsController.get)
routes.get('/album/zip/:identifier', albumsController.generateZip)
routes.get('/album/:identifier', albumsController.getUpstreamCompat)
routes.get('/album/:albumid/:page', uploadController.list)
routes.get('/albums', albumsController.list)
routes.get('/albums/:page', albumsController.list)
routes.post('/albums', albumsController.create)
routes.post('/albums/addfiles', albumsController.addFiles)
routes.post('/albums/delete', albumsController.delete)
routes.post('/albums/disable', albumsController.disable)
routes.post('/albums/edit', albumsController.edit)
routes.post('/albums/rename', albumsController.rename)
routes.get('/albums/test', albumsController.test)
routes.get('/tokens', tokenController.list)
routes.post('/tokens/verify', tokenController.verify)
routes.post('/tokens/change', tokenController.change)
routes.get('/filelength/config', authController.getFileLengthConfig)
routes.post('/filelength/change', authController.changeFileLength)
routes.get('/users', authController.listUsers)
routes.get('/users/:page', authController.listUsers)
routes.post('/users/create', authController.createUser)
routes.post('/users/edit', authController.editUser)
routes.post('/users/disable', authController.disableUser)
routes.post('/users/delete', authController.deleteUser)
routes.get('/stats', utilsController.stats)

module.exports = routes
