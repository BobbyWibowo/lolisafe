// TODO: Currently consulting with author of hyper-express
// about the behavior of Response.get()/.getHeader() not matching ExpressJS
// https://github.com/kartikk221/hyper-express/discussions/97
// This middleware is a workaround, hopefully only temporarily

class ExpressCompat {
  #getHeader (res, name) {
    // Always return first value in array if it only has a single value
    const values = res._getHeader(name)
    if (Array.isArray(values) && values.length === 1) {
      return values[0]
    } else {
      return values
    }
  }

  #middleware (req, res, next) {
    // Alias Response.get() and Response.getHeader() with a function that is more aligned with ExpressJS
    res._get = res.get
    res._getHeader = res.getHeader
    res.get = res.getHeader = name => this.#getHeader(res, name)

    return next()
  }

  get middleware () {
    return this.#middleware.bind(this)
  }
}

module.exports = ExpressCompat
