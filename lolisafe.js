const config = require('./config')
const api = require('./routes/api')
const album = require('./routes/album')
const nojs = require('./routes/nojs')
const express = require('express')
const bodyParser = require('body-parser')
const clamd = require('clamdjs')
const db = require('knex')(config.database)
const fs = require('fs')
const helmet = require('helmet')
const nunjucks = require('nunjucks')
const RateLimit = require('express-rate-limit')
const safe = express()

require('./database/db.js')(db)

fs.existsSync('./pages/custom') || fs.mkdirSync('./pages/custom')
fs.existsSync(`./${config.logsFolder}`) || fs.mkdirSync(`./${config.logsFolder}`)
fs.existsSync(`./${config.uploads.folder}`) || fs.mkdirSync(`./${config.uploads.folder}`)
fs.existsSync(`./${config.uploads.folder}/chunks`) || fs.mkdirSync(`./${config.uploads.folder}/chunks`)
fs.existsSync(`./${config.uploads.folder}/thumbs`) || fs.mkdirSync(`./${config.uploads.folder}/thumbs`)
fs.existsSync(`./${config.uploads.folder}/zips`) || fs.mkdirSync(`./${config.uploads.folder}/zips`)

safe.use(helmet())
safe.set('trust proxy', 1)

nunjucks.configure('views', {
  autoescape: true,
  express: safe
})
safe.set('view engine', 'njk')
safe.enable('view cache')

const limiter = new RateLimit({ windowMs: 5000, max: 2 })
safe.use('/api/login/', limiter)
safe.use('/api/register/', limiter)

safe.use(bodyParser.urlencoded({ extended: true }))
safe.use(bodyParser.json())

const setHeaders = res => {
  // Apply Cache-Control to all static files
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Cache-Control', 'public, max-age=2592000, must-revalidate, proxy-revalidate, immutable, stale-while-revalidate=86400, stale-if-error=604800') // max-age: 30 days
}

if (config.serveFilesWithNode) {
  safe.use('/', express.static(config.uploads.folder, { setHeaders }))
}

safe.use('/', express.static('./public', { setHeaders }))
safe.use('/', album)
safe.use('/', nojs)
safe.use('/api', api)

for (const page of config.pages) {
  if (fs.existsSync(`./pages/custom/${page}.html`)) {
    safe.get(`/${page}`, (req, res, next) => res.sendFile(`${page}.html`, {
      root: './pages/custom/'
    }))
  } else if (page === 'home') {
    safe.get('/', (req, res, next) => res.render('home', {
      urlMaxSize: config.uploads.urlMaxSize
    }))
  } else if (page === 'faq') {
    const fileLength = config.uploads.fileLength
    safe.get('/faq', (req, res, next) => res.render('faq', {
      filterBlacklist: config.filterBlacklist,
      extensionsFilter: config.extensionsFilter,
      fileLength,
      tooShort: (fileLength.max - fileLength.default) > (fileLength.default - fileLength.min),
      noJsMaxSize: parseInt(config.cloudflare.noJsMaxSize) < parseInt(config.uploads.maxSize),
      chunkSize: config.uploads.chunkSize
    }))
  } else {
    safe.get(`/${page}`, (req, res, next) => res.render(page))
  }
}

safe.use((req, res, next) => {
  res.status(404).sendFile('404.html', { root: './pages/error/' })
})
safe.use((error, req, res, next) => {
  console.error(error)
  res.status(500).sendFile('500.html', { root: './pages/error/' })
})

process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', error => {
  console.error('Unhandled Rejection (Promise):', error)
})

const start = async () => {
  if (config.uploads.scan && config.uploads.scan.enabled) {
    const created = await new Promise(async (resolve, reject) => {
      if (!config.uploads.scan.ip || !config.uploads.scan.port) {
        return reject(new Error('Clamd IP or Port is missing'))
      }
      const ping = await clamd.ping(config.uploads.scan.ip, config.uploads.scan.port).catch(reject)
      if (!ping) {
        return reject(new Error('Could not ping clamd'))
      }
      const version = await clamd.version(config.uploads.scan.ip, config.uploads.scan.port).catch(reject)
      console.log(`${config.uploads.scan.ip}:${config.uploads.scan.port}  ${version}`)
      const scanner = clamd.createScanner(config.uploads.scan.ip, config.uploads.scan.port)
      safe.set('clam-scanner', scanner)
      return resolve(true)
    }).catch(error => console.error(error.toString()))
    if (!created) { return process.exit(1) }
  }

  safe.listen(config.port, () => console.log(`lolisafe started on port ${config.port}`))
}

start()
