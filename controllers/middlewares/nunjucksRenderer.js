const nunjucks = require('nunjucks')

class NunjucksRenderer {
  directory
  environment

  #persistentCaches = new Map()

  constructor (directory = '', options = {}) {
    if (typeof directory !== 'string') {
      throw new TypeError('Root directory must be a string value')
    }

    this.directory = directory

    this.environment = nunjucks.configure(
      this.directory,
      Object.assign(options, {
        autoescape: true
      })
    )
  }

  #middleware (req, res, next) {
    // Inject render() method into Response on each requests
    // If usePersistentCache, the rendered template will be cached forever (thus only use for absolutely static pages)
    res.render = (path, params, usePersistentCache) => this.#render(res, path, params, usePersistentCache)
    return next()
  }

  #render (res, path, params, usePersistentCache) {
    return new Promise((resolve, reject) => {
      const template = `${path}.njk`

      const cached = this.#persistentCaches.get(template)
      if (usePersistentCache && cached) {
        return resolve(cached)
      }

      this.environment.render(template, params, (err, html) => {
        if (err) {
          return reject(err)
        }
        if (usePersistentCache) {
          this.#persistentCaches.set(template, html)
        }
        resolve(html)
      })
    }).then(html => {
      res.type('html').send(html)
      return html
    })
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

module.exports = NunjucksRenderer
