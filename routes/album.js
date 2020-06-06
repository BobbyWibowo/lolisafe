const routes = require('express').Router()
const path = require('path')
const paths = require('./../controllers/pathsController')
const utils = require('./../controllers/utilsController')
const config = require('./../config')
const db = require('knex')(config.database)

routes.get('/a/:identifier', async (req, res, next) => {
  const identifier = req.params.identifier
  if (identifier === undefined)
    res.status(404).sendFile(path.join(paths.errorRoot, config.errorPages[404]))

  const album = await db.table('albums')
    .where({
      identifier,
      enabled: 1
    })
    .select('id', 'name', 'identifier', 'editedAt', 'download', 'public', 'description')
    .first()

  if (!album || album.public === 0)
    return res.status(404).sendFile(path.join(paths.errorRoot, config.errorPages[404]))

  const nojs = req.query.nojs !== undefined

  let cacheid
  if (process.env.NODE_ENV !== 'development') {
    // Cache ID - we initialize a separate cache for No-JS version
    cacheid = nojs ? `${album.id}-nojs` : album.id

    if (!utils.albumsCache[cacheid])
      utils.albumsCache[cacheid] = {
        cache: null,
        generating: false
      }

    if (!utils.albumsCache[cacheid].cache && utils.albumsCache[cacheid].generating)
      return res.render('album-notice', {
        config,
        versions: utils.versionStrings,
        album,
        notice: 'This album\'s public page is still being generated. Please try again later.'
      })
    else if (utils.albumsCache[cacheid].cache)
      return res.send(utils.albumsCache[cacheid].cache)

    utils.albumsCache[cacheid].generating = true
  }

  const files = await db.table('files')
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

  return res.render('album', {
    config,
    versions: utils.versionStrings,
    album,
    files,
    nojs
  }, (error, html) => {
    const data = error ? null : html
    if (cacheid) {
      utils.albumsCache[cacheid].cache = data
      utils.albumsCache[cacheid].generating = false
    }

    // Express should already send error to the next handler
    if (error) return
    return res.send(data)
  })
})

module.exports = routes
