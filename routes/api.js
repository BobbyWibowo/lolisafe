const routes = require('express').Router()
const albumsController = require('./../controllers/albumsController')
const authController = require('./../controllers/authController')
const tokenController = require('./../controllers/tokenController')
const uploadController = require('./../controllers/uploadController')
const utilsController = require('./../controllers/utilsController')
const config = require('./../config')

routes.get('/check', (req, res, next) => {
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

routes.post('/login', (req, res, next) => authController.verify(req, res, next))
routes.post('/register', (req, res, next) => authController.register(req, res, next))
routes.post('/password/change', (req, res, next) => authController.changePassword(req, res, next))
routes.get('/uploads', (req, res, next) => uploadController.list(req, res, next))
routes.get('/uploads/:page', (req, res, next) => uploadController.list(req, res, next))
routes.post('/upload', (req, res, next) => uploadController.upload(req, res, next))
routes.post('/upload/delete', (req, res, next) => uploadController.delete(req, res, next))
routes.post('/upload/bulkdelete', (req, res, next) => uploadController.bulkDelete(req, res, next))
routes.post('/upload/finishchunks', (req, res, next) => uploadController.finishChunks(req, res, next))
routes.get('/upload/get/:identifier', (req, res, next) => uploadController.get(req, res, next))
routes.post('/upload/:albumid', (req, res, next) => uploadController.upload(req, res, next))
routes.get('/album/get/:identifier', (req, res, next) => albumsController.get(req, res, next))
routes.get('/album/zip/:identifier', (req, res, next) => albumsController.generateZip(req, res, next))
routes.get('/album/:id', (req, res, next) => albumsController.listFiles(req, res, next))
routes.get('/album/:id/:page', (req, res, next) => albumsController.listFiles(req, res, next))
routes.get('/albums', (req, res, next) => albumsController.list(req, res, next))
routes.get('/albums/:page', (req, res, next) => albumsController.list(req, res, next))
routes.post('/albums', (req, res, next) => albumsController.create(req, res, next))
routes.post('/albums/addfiles', (req, res, next) => albumsController.addFiles(req, res, next))
routes.post('/albums/delete', (req, res, next) => albumsController.delete(req, res, next))
routes.post('/albums/disable', (req, res, next) => albumsController.disable(req, res, next))
routes.post('/albums/edit', (req, res, next) => albumsController.edit(req, res, next))
routes.post('/albums/rename', (req, res, next) => albumsController.rename(req, res, next))
routes.get('/albums/test', (req, res, next) => albumsController.test(req, res, next))
routes.get('/tokens', (req, res, next) => tokenController.list(req, res, next))
routes.post('/tokens/verify', (req, res, next) => tokenController.verify(req, res, next))
routes.post('/tokens/change', (req, res, next) => tokenController.change(req, res, next))
routes.get('/filelength/config', (req, res, next) => authController.getFileLengthConfig(req, res, next))
routes.post('/filelength/change', (req, res, next) => authController.changeFileLength(req, res, next))
routes.get('/users', (req, res, next) => authController.listUsers(req, res, next))
routes.get('/users/:page', (req, res, next) => authController.listUsers(req, res, next))
routes.post('/users/create', (req, res, next) => authController.createUser(req, res, next))
routes.post('/users/edit', (req, res, next) => authController.editUser(req, res, next))
routes.post('/users/disable', (req, res, next) => authController.disableUser(req, res, next))
routes.post('/users/delete', (req, res, next) => authController.deleteUser(req, res, next))
routes.get('/stats', (req, res, next) => utilsController.stats(req, res, next))

module.exports = routes
