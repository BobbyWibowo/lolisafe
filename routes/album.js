const { Router } = require('hyper-express')
const routes = new Router()
const path = require('path')
const errors = require('./../controllers/errorsController')
const utils = require('./../controllers/utilsController')
const config = require('./../config')

routes.get('/a/:identifier', async (req, res) => {
  const identifier = req.path_parameters && req.path_parameters.identifier
  if (identifier === undefined) {
    return errors.handleNotFound(req, res)
  }

  const album = await utils.db.table('albums')
    .where({
      identifier,
      enabled: 1
    })
    .select('id', 'name', 'identifier', 'editedAt', 'download', 'public', 'description')
    .first()

  if (!album || album.public === 0) {
    return errors.handleNotFound(req, res)
  }

  const nojs = req.query_parameters.nojs !== undefined

  let cacheid
  if (process.env.NODE_ENV !== 'development') {
    // Cache ID - we use a separate cache key for No-JS version
    cacheid = `${album.id}${nojs ? '-nojs' : ''}`

    const cache = utils.albumRenderStore.get(cacheid)
    if (cache) {
      return res.type('html').send(cache)
    } else if (cache === null) {
      return res.render('album-notice', {
        config,
        utils,
        versions: utils.versionStrings,
        album,
        notice: 'This album\'s public page is still being generated. Please try again later.'
      })
    }

    utils.albumRenderStore.hold(cacheid)
  }

  const files = await utils.db.table('files')
    .select('name', 'size')
    .where('albumid', album.id)
    .orderBy('id', 'desc')

  album.thumb = ''
  album.totalSize = 0

  for (const file of files) {
    album.totalSize += parseInt(file.size)

    file.extname = path.extname(file.name)
    if (utils.mayGenerateThumb(file.extname)) {
      file.thumb = `thumbs/${file.name.slice(0, -file.extname.length)}.png`
      // If thumbnail for album is still not set, set it to current file's full URL.
      // A potential improvement would be to let the user set a specific image as an album cover.
      if (!album.thumb) album.thumb = file.name
    }
  }

  album.downloadLink = album.download === 0
    ? null
    : `api/album/zip/${album.identifier}?v=${album.editedAt}`

  album.url = `a/${album.identifier}`
  album.description = album.description
    ? utils.md.instance.render(album.description)
    : null

  // This will already end the Response,
  // thus may only continue with tasks that will not interface with Response any further
  const html = await res.render('album', {
    config,
    utils,
    versions: utils.versionStrings,
    album,
    files,
    nojs
  })

  if (cacheid) {
    // Only store rendered page if it did not error out and album actually have files
    if (html && files.length) {
      utils.albumRenderStore.set(cacheid, html)
    } else {
      utils.albumRenderStore.delete(cacheid)
    }
  }
})

module.exports = routes
