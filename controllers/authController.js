const bcrypt = require('bcrypt')
const path = require('path')
const randomstring = require('randomstring')
const paths = require('./pathsController')
const perms = require('./permissionController')
const tokens = require('./tokenController')
const utils = require('./utilsController')
const ClientError = require('./utils/ClientError')
const ServerError = require('./utils/ServerError')
const config = require('./../config')

// Don't forget to update min/max length of text inputs in auth.njk
// when changing these values.
const self = {
  user: {
    min: 4,
    max: 32
  },
  pass: {
    min: 6,
    // Should not be more than 72 characters
    // https://github.com/kelektiv/node.bcrypt.js/tree/v5.0.1#security-issues-and-concerns
    max: 64,
    // Length of randomized password
    // when resetting passwordthrough Dashboard's Manage Users.
    rand: 16
  }
}

// https://github.com/kelektiv/node.bcrypt.js/tree/v5.0.1#a-note-on-rounds
const saltRounds = 10

self.verify = (req, res, next) => {
  Promise.resolve().then(async () => {
    const username = typeof req.body.username === 'string'
      ? req.body.username.trim()
      : ''
    if (!username) throw new ClientError('No username provided.')

    const password = typeof req.body.password === 'string'
      ? req.body.password.trim()
      : ''
    if (!password) throw new ClientError('No password provided.')

    const user = await utils.db.table('users')
      .where('username', username)
      .first()

    if (!user) throw new ClientError('Wrong credentials.', { statusCode: 403 })

    if (user.enabled === false || user.enabled === 0) {
      throw new ClientError('This account has been disabled.', { statusCode: 403 })
    }

    const result = await bcrypt.compare(password, user.password)
    if (result === false) {
      throw new ClientError('Wrong credentials.', { statusCode: 403 })
    } else {
      await res.json({ success: true, token: user.token })
    }
  }).catch(next)
}

self.register = (req, res, next) => {
  Promise.resolve().then(async () => {
    if (config.enableUserAccounts === false) {
      throw new ClientError('Registration is currently disabled.', { statusCode: 403 })
    }

    const username = typeof req.body.username === 'string'
      ? req.body.username.trim()
      : ''
    if (username.length < self.user.min || username.length > self.user.max) {
      throw new ClientError(`Username must have ${self.user.min}-${self.user.max} characters.`)
    }

    const password = typeof req.body.password === 'string'
      ? req.body.password.trim()
      : ''
    if (password.length < self.pass.min || password.length > self.pass.max) {
      throw new ClientError(`Password must have ${self.pass.min}-${self.pass.max} characters.`)
    }

    const user = await utils.db.table('users')
      .where('username', username)
      .first()

    if (user) throw new ClientError('Username already exists.')

    const hash = await bcrypt.hash(password, saltRounds)

    const token = await tokens.generateUniqueToken()
    if (!token) {
      throw new ServerError('Failed to allocate a unique token. Try again?')
    }

    await utils.db.table('users')
      .insert({
        username,
        password: hash,
        token,
        enabled: 1,
        permission: perms.permissions.user,
        registration: Math.floor(Date.now() / 1000)
      })
    utils.invalidateStatsCache('users')
    tokens.onHold.delete(token)

    await res.json({ success: true, token })
  }).catch(next)
}

self.changePassword = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const password = typeof req.body.password === 'string'
      ? req.body.password.trim()
      : ''
    if (password.length < self.pass.min || password.length > self.pass.max) {
      throw new ClientError(`Password must have ${self.pass.min}-${self.pass.max} characters.`)
    }

    const hash = await bcrypt.hash(password, saltRounds)

    await utils.db.table('users')
      .where('id', user.id)
      .update('password', hash)

    await res.json({ success: true })
  }).catch(next)
}

self.assertPermission = (user, target) => {
  if (!target) {
    throw new ClientError('Could not get user with the specified ID.')
  } else if (!perms.higher(user, target)) {
    throw new ClientError('The user is in the same or higher group as you.', { statusCode: 403 })
  } else if (target.username === 'root') {
    throw new ClientError('Root user may not be tampered with.', { statusCode: 403 })
  }
}

self.createUser = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const isadmin = perms.is(user, 'admin')
    if (!isadmin) return res.status(403).end()

    const username = typeof req.body.username === 'string'
      ? req.body.username.trim()
      : ''
    if (username.length < self.user.min || username.length > self.user.max) {
      throw new ClientError(`Username must have ${self.user.min}-${self.user.max} characters.`)
    }

    let password = typeof req.body.password === 'string'
      ? req.body.password.trim()
      : ''
    if (password.length) {
      if (password.length < self.pass.min || password.length > self.pass.max) {
        throw new ClientError(`Password must have ${self.pass.min}-${self.pass.max} characters.`)
      }
    } else {
      password = randomstring.generate(self.pass.rand)
    }

    let group = req.body.group
    let permission
    if (group !== undefined) {
      permission = perms.permissions[group]
      if (typeof permission !== 'number' || permission < 0) {
        group = 'user'
        permission = perms.permissions.user
      }
    }

    const exists = await utils.db.table('users')
      .where('username', username)
      .first()

    if (exists) throw new ClientError('Username already exists.')

    const hash = await bcrypt.hash(password, saltRounds)

    const token = await tokens.generateUniqueToken()
    if (!token) {
      throw new ServerError('Failed to allocate a unique token. Try again?')
    }

    await utils.db.table('users')
      .insert({
        username,
        password: hash,
        token,
        enabled: 1,
        permission,
        registration: Math.floor(Date.now() / 1000)
      })
    utils.invalidateStatsCache('users')
    tokens.onHold.delete(token)

    await res.json({ success: true, username, password, group })
  }).catch(next)
}

self.editUser = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const isadmin = perms.is(user, 'admin')
    if (!isadmin) throw new ClientError('', { statusCode: 403 })

    const id = parseInt(req.body.id)
    if (isNaN(id)) throw new ClientError('No user specified.')

    const target = await utils.db.table('users')
      .where('id', id)
      .first()
    self.assertPermission(user, target)

    const update = {}

    if (req.body.username !== undefined) {
      update.username = String(req.body.username).trim()
      if (update.username.length < self.user.min || update.username.length > self.user.max) {
        throw new ClientError(`Username must have ${self.user.min}-${self.user.max} characters.`)
      }
    }

    if (req.body.enabled !== undefined) {
      update.enabled = Boolean(req.body.enabled)
    }

    if (req.body.group !== undefined) {
      update.permission = perms.permissions[req.body.group]
      if (typeof update.permission !== 'number' || update.permission < 0) {
        update.permission = target.permission
      }
    }

    let password
    if (req.body.resetPassword) {
      password = randomstring.generate(self.pass.rand)
      update.password = await bcrypt.hash(password, saltRounds)
    }

    await utils.db.table('users')
      .where('id', id)
      .update(update)
    utils.invalidateStatsCache('users')

    const response = { success: true, update }
    if (password) response.update.password = password
    await res.json(response)
  }).catch(next)
}

self.disableUser = (req, res, next) => {
  req.body = { id: req.body.id, enabled: false }
  return self.editUser(req, res, next)
}

self.deleteUser = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const isadmin = perms.is(user, 'admin')
    if (!isadmin) throw new ClientError('', { statusCode: 403 })

    const id = parseInt(req.body.id)
    const purge = req.body.purge
    if (isNaN(id)) throw new ClientError('No user specified.')

    const target = await utils.db.table('users')
      .where('id', id)
      .first()
    self.assertPermission(user, target)

    const files = await utils.db.table('files')
      .where('userid', id)
      .select('id')

    if (files.length) {
      const fileids = files.map(file => file.id)
      if (purge) {
        const failed = await utils.bulkDeleteFromDb('id', fileids, user)
        if (failed.length) return res.json({ success: false, failed })
        utils.invalidateStatsCache('uploads')
      } else {
        // Clear out userid attribute from the files
        await utils.db.table('files')
          .whereIn('id', fileids)
          .update('userid', null)
      }
    }

    const albums = await utils.db.table('albums')
      .where('userid', id)
      .where('enabled', 1)
      .select('id', 'identifier')

    if (albums.length) {
      const albumids = albums.map(album => album.id)
      await utils.db.table('albums')
        .whereIn('id', albumids)
        .del()
      utils.deleteStoredAlbumRenders(albumids)

      // Unlink their archives
      await Promise.all(albums.map(async album => {
        try {
          await paths.unlink(path.join(paths.zips, `${album.identifier}.zip`))
        } catch (error) {
          // Re-throw non-ENOENT error
          if (error.code !== 'ENOENT') throw error
        }
      }))
    }

    await utils.db.table('users')
      .where('id', id)
      .del()
    utils.invalidateStatsCache('users')

    await res.json({ success: true })
  }).catch(next)
}

self.bulkDeleteUsers = (req, res, next) => {
  // TODO
}

self.listUsers = (req, res, next) => {
  Promise.resolve().then(async () => {
    const user = await utils.authorize(req)

    const isadmin = perms.is(user, 'admin')
    if (!isadmin) throw new ClientError('', { statusCode: 403 })

    const count = await utils.db.table('users')
      .count('id as count')
      .then(rows => rows[0].count)
    if (!count) return res.json({ success: true, users: [], count })

    let offset = Number(req.params.page)
    if (isNaN(offset)) offset = 0
    else if (offset < 0) offset = Math.max(0, Math.ceil(count / 25) + offset)

    const users = await utils.db.table('users')
      .limit(25)
      .offset(25 * offset)
      .select('id', 'username', 'enabled', 'timestamp', 'permission', 'registration')

    const pointers = {}
    for (const user of users) {
      user.groups = perms.mapPermissions(user)
      delete user.permission
      user.uploads = 0
      user.usage = 0
      pointers[user.id] = user
    }

    const uploads = await utils.db.table('files')
      .whereIn('userid', Object.keys(pointers))
      .select('userid', 'size')

    for (const upload of uploads) {
      pointers[upload.userid].uploads++
      pointers[upload.userid].usage += parseInt(upload.size)
    }

    await res.json({ success: true, users, count })
  }).catch(next)
}

module.exports = self
