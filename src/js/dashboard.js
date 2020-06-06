/* global swal, axios, ClipboardJS, LazyLoad */

const lsKeys = {
  token: 'token',
  viewType: {
    uploads: 'viewTypeUploads',
    uploadsAll: 'viewTypeUploadsAll'
  },
  selected: {
    uploads: 'selectedUploads',
    uploadsAll: 'selectedUploadsAll',
    albums: 'selectedAlbums',
    albumsAll: 'selectedAlbumsAll',
    users: 'selectedUsers'
  }
}

const page = {
  // #dashboard
  section: null,
  // #page
  dom: null,

  // user token
  token: localStorage[lsKeys.token],

  // from api/tokens/verify
  username: null,
  permissions: null,

  // sidebar menus
  menusContainer: null,
  menus: [],

  currentView: null,
  views: {
    // params of uploads view
    uploads: {
      type: localStorage[lsKeys.viewType.uploads],
      album: null, // album's id
      pageNum: null
    },
    // params of uploads view (all)
    uploadsAll: {
      type: localStorage[lsKeys.viewType.uploadsAll],
      filters: null,
      pageNum: null,
      all: true
    },
    // params of albums view
    albums: {
      filters: null,
      pageNum: null
    },
    // params of albums view (all)
    albumsAll: {
      filters: null,
      pageNum: null,
      all: true
    },
    // params of users view
    users: {
      filters: null,
      pageNum: null
    }
  },

  // ids of selected items (shared across pages and will be synced with localStorage)
  selected: {
    uploads: [],
    uploadsAll: [],
    albums: [],
    albumsAll: [],
    users: []
  },
  checkboxes: [],
  lastSelected: [],

  // select album dom for dialogs/modals
  selectAlbumContainer: null,

  // cache for dialogs/modals
  cache: {},

  clipboardJS: null,
  lazyLoad: null,

  imageExts: ['.webp', '.jpg', '.jpeg', '.gif', '.png', '.tiff', '.tif', '.svg'],
  // TODO: Disable "Load original" button with non-streamable extensions
  videoExts: ['.webm', '.mp4', '.wmv', '.avi', '.mov', '.mkv', '.m4v', '.m2ts'],

  isSomethingLoading: false,
  fadingIn: null,

  albumTitleMaxLength: 70,
  albumDescMaxLength: 4000
}

page.unhide = () => {
  document.querySelector('#loader').classList.add('is-hidden')
  page.section.classList.remove('is-hidden')
}

// Handler for regular JS errors
page.onError = error => {
  console.error(error)

  const content = document.createElement('div')
  content.innerHTML = `<code>${error.toString()}</code>`
  return swal({
    title: 'An error occurred!',
    icon: 'error',
    content
  })
}

// Handler for Axios errors
page.onAxiosError = error => {
  console.error(error)

  // Better Cloudflare errors
  const cloudflareErrors = {
    520: 'Unknown Error',
    521: 'Web Server Is Down',
    522: 'Connection Timed Out',
    523: 'Origin Is Unreachable',
    524: 'A Timeout Occurred',
    525: 'SSL Handshake Failed',
    526: 'Invalid SSL Certificate',
    527: 'Railgun Error',
    530: 'Origin DNS Error'
  }

  const statusText = cloudflareErrors[error.response.status] || error.response.statusText
  const description = error.response.data && error.response.data.description
    ? error.response.data.description
    : 'There was an error with the request, please check the console for more information.'

  return swal(`${error.response.status} ${statusText}`, description, 'error')
}

page.preparePage = () => {
  if (page.token)
    page.verifyToken(page.token, true)
  else
    window.location = 'auth'
}

page.checkClientVersion = apiVersion => {
  const self = document.querySelector('#mainScript')
  const match = self.src.match(/\?_=(\d+)$/)
  if (match && match[1] && match[1] !== apiVersion)
    return swal({
      title: 'Updated detected!',
      text: 'Client assets have been updated. Reload to display the latest version?',
      icon: 'info',
      buttons: {
        confirm: {
          text: 'Reload',
          closeModal: false
        }
      }
    }).then(() => {
      window.location.reload()
    })
}

page.verifyToken = (token, reloadOnError) => {
  axios.post('api/tokens/verify', { token }).then(response => {
    if (response.data.success === false)
      return swal({
        title: 'An error occurred!',
        text: response.data.description,
        icon: 'error'
      }).then(() => {
        if (!reloadOnError) return
        localStorage.removeItem(lsKeys.token)
        window.location = 'auth'
      })

    axios.defaults.headers.common.token = token
    localStorage[lsKeys.token] = token

    if (response.data.version)
      page.checkClientVersion(response.data.version)

    page.token = token
    page.username = response.data.username
    page.permissions = response.data.permissions
    page.prepareDashboard()
  }).catch(page.onAxiosError)
}

page.prepareDashboard = () => {
  page.section = document.querySelector('#dashboard')
  page.dom = page.section.querySelector('#page')

  // Capture all click events
  page.dom.addEventListener('click', page.domClick, true)

  // Capture all submit events
  page.dom.addEventListener('submit', event => {
    // Prevent default if necessary
    if (event.target && event.target.classList.contains('prevent-default'))
      return event.preventDefault()
  }, true)

  page.menusContainer = document.querySelector('#menu')

  // All item menus in the sidebar
  const itemMenus = [
    { selector: '#itemUploads', onclick: page.getUploads },
    { selector: '#itemDeleteUploadsByNames', onclick: page.deleteUploadsByNames },
    { selector: '#itemManageYourAlbums', onclick: page.getAlbums },
    { selector: '#itemManageToken', onclick: page.changeToken },
    { selector: '#itemChangePassword', onclick: page.changePassword },
    { selector: '#itemLogout', onclick: page.logout },
    { selector: '#itemManageUploads', onclick: page.getUploads, params: { all: true }, group: 'moderator' },
    { selector: '#itemManageAlbums', onclick: page.getAlbums, params: { all: true }, group: 'moderator' },
    { selector: '#itemStatistics', onclick: page.getStatistics, group: 'admin' },
    { selector: '#itemManageUsers', onclick: page.getUsers, group: 'admin' }
  ]

  for (let i = 0; i < itemMenus.length; i++) {
    // Skip item menu if not enough permission
    if (itemMenus[i].group && !page.permissions[itemMenus[i].group])
      continue

    // Add onclick event listener
    const item = document.querySelector(itemMenus[i].selector)
    item.addEventListener('click', event => {
      if (page.isSomethingLoading)
        return page.warnSomethingLoading()

      // eslint-disable-next-line compat/compat
      itemMenus[i].onclick.call(null, Object.assign(itemMenus[i].params || {}, {
        trigger: event.currentTarget
      }))
    })

    item.classList.remove('is-hidden')
    page.menus.push(item)
  }

  // If at least a moderator, show administration section
  if (page.permissions.moderator) {
    document.querySelector('#itemLabelAdmin').classList.remove('is-hidden')
    document.querySelector('#itemListAdmin').classList.remove('is-hidden')
  }

  // Update text of logout button
  document.querySelector('#itemLogout').innerHTML = `Logout ( ${page.username} )`

  // Finally display dashboard
  page.unhide()

  // Load albums sidebar
  page.getAlbumsSidebar()

  if (typeof page.prepareShareX === 'function')
    page.prepareShareX()
}

page.logout = params => {
  page.updateTrigger(params.trigger, 'active')
  localStorage.removeItem(lsKeys.token)
  window.location = 'auth'
}

page.warnSomethingLoading = () => {
  swal('Please wait!', 'Something else is still loading\u2026', 'warning', {
    buttons: false,
    timer: 3000
  })
}

page.updateTrigger = (trigger, newState) => {
  if (!trigger) return

  // Disable menus container and pagination when loading
  if (newState === 'loading') {
    page.isSomethingLoading = true
    page.section.classList.add('is-loading')
  } else {
    page.section.classList.remove('is-loading')
    page.isSomethingLoading = false
  }

  if (newState === 'loading') {
    trigger.classList.add('is-loading')
  } else if (newState === 'active') {
    if (trigger.parentNode.tagName !== 'LI')
      return
    for (let i = 0; i < page.menus.length; i++)
      page.menus[i].classList.remove('is-active')
    trigger.classList.remove('is-loading')
    trigger.classList.add('is-active')
  } else {
    trigger.classList.remove('is-loading')
    trigger.classList.remove('is-active')
  }
}

page.getItemID = element => {
  // This expects the item's parent to have the item's ID
  let parent = element.parentNode
  // If the element is part of a set of controls, use the container's parent instead
  if (element.parentNode.classList.contains('controls')) parent = parent.parentNode
  return parseInt(parent.dataset.id)
}

page.domClick = event => {
  // We are processing clicks this way to avoid using "onclick" attribute
  // Apparently we will need to use "unsafe-inline" for "script-src" directive
  // of Content Security Policy (CSP), if we want to use "onclick" attribute
  // Though I think that only applies to some browsers (?)
  // Of course it wouldn't have mattered if we didn't use CSP to begin with
  // Anyway, I personally would rather not use "onclick" attribute
  let element = event.target
  if (!element) return

  // Delegate click events to their A or BUTTON parents
  if (['I'].includes(element.tagName) && ['SPAN'].includes(element.parentNode.tagName))
    element = element.parentNode
  if (['SPAN'].includes(element.tagName) && ['A', 'BUTTON'].includes(element.parentNode.tagName))
    element = element.parentNode

  // Skip elements that have no action data
  if (!element.dataset || !element.dataset.action) return

  // Skip disabled elements
  if (element.hasAttribute('disabled')) return

  event.stopPropagation() // maybe necessary
  const id = page.getItemID(element)
  const action = element.dataset.action

  switch (action) {
    // Uploads
    case 'view-list':
      return page.setUploadsView('list', element)
    case 'view-thumbs':
      return page.setUploadsView('thumbs', element)
    case 'add-to-album':
      return page.addToAlbum(id)
    case 'delete-upload':
      return page.deleteUpload(id)
    case 'add-selected-uploads-to-album':
      return page.addSelectedUploadsToAlbum()
    case 'bulk-delete-uploads':
      return page.bulkDeleteUploads()
    case 'display-preview':
      return page.displayPreview(id)
    // Manage uploads
    case 'upload-filters-help':
      return page.uploadFiltersHelp(element)
    case 'filter-uploads':
      return page.filterUploads(element)
    // Manage your albums
    case 'submit-album':
      return page.submitAlbum(element)
    case 'edit-album':
      return page.editAlbum(id)
    case 'disable-album':
      return page.disableAlbum(id)
    case 'view-album-uploads':
      return page.viewAlbumUploads(id, element)
    // Manage users
    case 'create-user':
      return page.createUser()
    case 'edit-user':
      return page.editUser(id)
    case 'disable-user':
      return page.disableUser(id)
    case 'delete-user':
      return page.deleteUser(id)
    case 'view-user-uploads':
      return page.viewUserUploads(id, element)
    // Others
    case 'get-new-token':
      return page.getNewToken(element)
    // Uploads & Users
    case 'clear-selection':
      return page.clearSelection()
    case 'select':
      return page.select(element, event)
    case 'select-all':
      return page.selectAll(element)
    case 'page-ellipsis':
      return page.focusJumpToPage(element)
    case 'page-prev':
    case 'page-next':
    case 'page-goto':
    case 'jump-to-page':
      return page.switchPage(action, element)
  }
}

page.fadeAndScroll = disableFading => {
  if (page.fadingIn) {
    clearTimeout(page.fadingIn)
    page.dom.classList.remove('fade-in')
  }

  if (!disableFading) {
    page.dom.classList.add('fade-in')
    page.fadingIn = setTimeout(() => {
      page.dom.classList.remove('fade-in')
    }, 500)
  }

  page.dom.scrollIntoView({
    behavior: disableFading ? 'auto' : 'smooth',
    block: 'start',
    inline: 'nearest'
  })
}

page.getByView = (view, get) => {
  switch (view) {
    case 'uploads':
    case 'uploadsAll':
      return {
        type: 'uploads',
        func: page.getUploads
      }[get]
    case 'albums':
    case 'albumsAll':
      return {
        type: 'albums',
        func: page.getAlbums
      }[get]
    case 'users':
      return {
        type: 'users',
        func: page.getUsers
      }[get]
    default:
      return null
  }
}

page.switchPage = (action, element) => {
  if (page.isSomethingLoading)
    return page.warnSomethingLoading()

  // eslint-disable-next-line compat/compat
  const params = Object.assign(page.views[page.currentView], {
    trigger: element
  })

  const func = page.getByView(page.currentView, 'func')

  switch (action) {
    case 'page-prev':
      params.pageNum = page.views[page.currentView].pageNum - 1
      if (params.pageNum < 0)
        return swal('An error occurred!', 'This is already the first page.', 'error')
      return func(params)
    case 'page-next':
      params.pageNum = page.views[page.currentView].pageNum + 1
      return func(params)
    case 'page-goto':
      params.pageNum = parseInt(element.dataset.goto)
      return func(params)
    case 'jump-to-page': {
      const jumpToPage = document.querySelector(`#${element.dataset.jumpid || 'jumpToPage'}`)
      if (!jumpToPage.checkValidity()) return
      const parsed = parseInt(jumpToPage.value)
      params.pageNum = isNaN(parsed) ? 0 : (parsed - 1)
      if (params.pageNum < 0) params.pageNum = 0
      return func(params)
    }
  }
}

page.focusJumpToPage = element => {
  const jumpToPage = document.querySelector(`#${element.dataset.jumpid || 'jumpToPage'}`)
  if (!jumpToPage) return
  jumpToPage.focus()
  jumpToPage.select()
}

page.getUploads = (params = {}) => {
  if (params && params.all && !page.permissions.moderator)
    return swal('An error occurred!', 'You cannot do this!', 'error')

  if (page.isSomethingLoading)
    return page.warnSomethingLoading()

  page.updateTrigger(params.trigger, 'loading')

  if (typeof params.pageNum !== 'number' || params.pageNum < 0)
    params.pageNum = 0

  const url = params.album !== undefined
    ? `api/album/${params.album}/${params.pageNum}`
    : `api/uploads/${params.pageNum}`

  const headers = {}

  if (params.all)
    headers.all = '1'

  if (params.filters) {
    headers.filters = params.filters

    // Send client timezone offset if properly using date: and/or :expiry filters
    // Server will pretend client is on UTC if unset
    if (/(^|\s)(date|expiry):[\d"]/.test(params.filters))
      headers.minoffset = new Date().getTimezoneOffset()
  }

  axios.get(url, { headers }).then(response => {
    if (response.data.success === false)
      if (response.data.description === 'No token provided') {
        return page.verifyToken(page.token)
      } else {
        page.updateTrigger(params.trigger)
        return swal('An error occurred!', response.data.description, 'error')
      }

    const pages = Math.ceil(response.data.count / 25)
    const files = response.data.files
    if (params.pageNum && (files.length === 0))
      if (params.autoPage) {
        params.pageNum = pages - 1
        return page.getUploads(params)
      } else {
        page.updateTrigger(params.trigger)
        return swal('An error occurred!', `There are no more uploads to populate page ${params.pageNum + 1}.`, 'error')
      }

    page.currentView = params.all ? 'uploadsAll' : 'uploads'
    page.cache = {}

    const albums = response.data.albums
    const users = response.data.users
    const basedomain = response.data.basedomain

    if (params.pageNum < 0) params.pageNum = Math.max(0, pages + params.pageNum)
    const pagination = page.paginate(response.data.count, 25, params.pageNum)

    const filter = `
      <div class="column">
        <form class="prevent-default">
          <div class="field has-addons">
            <div class="control is-expanded">
              <input id="filters" class="input is-small" type="text" placeholder="Filter uploads" value="${page.escape(params.filters || '')}">
            </div>
            <div class="control">
              <button type="button" class="button is-small is-primary is-outlined" title="Help?" data-action="upload-filters-help"${params.all ? ' data-all="true"' : ''}>
                <span class="icon">
                  <i class="icon-help-circled"></i>
                </span>
              </button>
            </div>
            <div class="control">
              <button type="submit" class="button is-small is-info is-outlined" title="Filter uploads" data-action="filter-uploads">
                <span class="icon">
                  <i class="icon-filter"></i>
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    `
    const extraControls = `
      <div class="columns">
        ${filter}
        <div class="column is-one-quarter">
          <form class="prevent-default">
            <div class="field has-addons">
              <div class="control is-expanded">
                <input id="jumpToPage" class="input is-small" type="number" min="1" max="${pages}" value="${params.pageNum + 1}"${pages === 1 ? ' disabled' : ''}>
              </div>
              <div class="control">
                <button type="submit" class="button is-small is-info is-outlined" title="Jump to page" data-action="jump-to-page">
                  <span class="icon">
                    <i class="icon-paper-plane"></i>
                  </span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    `

    const controls = `
      <div class="columns">
        <div class="column is-hidden-mobile"></div>
        <div class="column has-text-centered">
          <a class="button is-small is-danger is-outlined" title="List view" data-action="view-list">
            <span class="icon">
              <i class="icon-th-list"></i>
            </span>
          </a>
          <a class="button is-small is-danger is-outlined" title="Thumbs view" data-action="view-thumbs">
            <span class="icon">
              <i class="icon-th-large"></i>
            </span>
          </a>
        </div>
        <div class="column bulk-operations has-text-right">
          <a class="button is-small is-info is-outlined" title="Clear selection" data-action="clear-selection">
            <span class="icon">
              <i class="icon-cancel"></i>
            </span>
          </a>
          ${params.all ? '' : `
          <a class="button is-small is-warning is-outlined" title="Bulk add to album" data-action="add-selected-uploads-to-album">
            <span class="icon">
              <i class="icon-plus"></i>
            </span>
          </a>`}
          <a class="button is-small is-danger is-outlined" title="Bulk delete" data-action="bulk-delete-uploads">
            <span class="icon">
              <i class="icon-trash"></i>
            </span>
            <span>Bulk delete</span>
          </a>
        </div>
      </div>
    `

    // Do some string replacements for bottom controls
    const bottomFiltersId = 'bFilters'
    const bottomJumpId = 'bJumpToPage'
    const bottomExtraControls = extraControls
      .replace(/id="filters"/, `id="${bottomFiltersId}"`)
      .replace(/(data-action="filter-uploads")/, `$1 data-filtersid="${bottomFiltersId}"`)
      .replace(/id="jumpToPage"/, `id="${bottomJumpId}"`)
      .replace(/(data-action="jump-to-page")/g, `$1 data-jumpid="${bottomJumpId}"`)
    const bottomPagination = pagination
      .replace(/(data-action="page-ellipsis")/g, `$1 data-jumpid="${bottomJumpId}"`)

    // Whether there are any unselected items
    let unselected = false

    const hasExpiryDateColumn = files.some(file => {
      return file.expirydate !== undefined
    })

    for (let i = 0; i < files.length; i++) {
      // Build full URLs
      files[i].file = `${basedomain}/${files[i].name}`
      if (files[i].thumb)
        files[i].thumb = `${basedomain}/${files[i].thumb}`

      // Determine types
      files[i].type = 'other'
      const exec = /.[\w]+(\?|$)/.exec(files[i].file)
      const extname = exec && exec[0] ? exec[0].toLowerCase() : null
      if (page.imageExts.includes(extname))
        files[i].type = 'picture'
      else if (page.videoExts.includes(extname))
        files[i].type = 'video'

      // Cache bare minimum data for thumbnails viewer
      page.cache[files[i].id] = {
        name: files[i].name,
        thumb: files[i].thumb,
        original: files[i].file,
        type: files[i].type
      }

      // Prettify
      files[i].prettyBytes = page.getPrettyBytes(parseInt(files[i].size))
      files[i].prettyDate = page.getPrettyDate(new Date(files[i].timestamp * 1000))

      if (hasExpiryDateColumn)
        files[i].prettyExpiryDate = files[i].expirydate
          ? page.getPrettyDate(new Date(files[i].expirydate * 1000))
          : null

      // Update selected status
      files[i].selected = page.selected[page.currentView].includes(files[i].id)
      if (!files[i].selected) unselected = true

      // Appendix (display album or user)
      if (params.all)
        files[i].appendix = files[i].userid
          ? users[files[i].userid] || ''
          : ''
      else if (params.album === undefined)
        files[i].appendix = files[i].albumid
          ? albums[files[i].albumid] || ''
          : ''
    }

    if (page.views[page.currentView].type === 'thumbs') {
      page.dom.innerHTML = `
        ${pagination}
        ${extraControls}
        ${controls}
        <div id="table" class="columns is-multiline is-mobile is-centered">
        </div>
        ${controls}
        ${bottomExtraControls}
        ${bottomPagination}
      `

      const table = document.querySelector('#table')

      for (let i = 0; i < files.length; i++) {
        const upload = files[i]
        const div = document.createElement('div')
        div.className = 'image-container column'
        div.dataset.id = upload.id

        if (upload.thumb !== undefined)
          div.innerHTML = `<a class="image" href="${upload.file}" target="_blank"><img alt="${upload.name}" data-src="${upload.thumb}"/></a>`
        else
          div.innerHTML = `<a class="image" href="${upload.file}" target="_blank"><h1 class="title">${upload.extname || 'N/A'}</h1></a>`

        div.innerHTML += `
          <input type="checkbox" class="checkbox" title="Select" data-index="${i}" data-action="select"${upload.selected ? ' checked' : ''}>
          <div class="controls">
            ${upload.thumb ? `
            <a class="button is-small is-primary" title="Display preview" data-action="display-preview">
              <span class="icon">
                <i class="${upload.type !== 'other' ? `icon-${upload.type}` : 'icon-doc-inv'}"></i>
              </span>
            </a>` : ''}
            <a class="button is-small is-info clipboard-js" title="Copy link to clipboard" data-clipboard-text="${upload.file}">
              <span class="icon">
                <i class="icon-clipboard"></i>
              </span>
            </a>
            <a class="button is-small is-warning" title="Add to album" data-action="add-to-album">
              <span class="icon">
                <i class="icon-plus"></i>
              </span>
            </a>
            <a class="button is-small is-danger" title="Delete" data-action="delete-upload">
              <span class="icon">
                <i class="icon-trash"></i>
              </span>
            </a>
          </div>
          <div class="details">
            <p><span class="name">${upload.name}</span></p>
            <p>${upload.appendix ? `<span>${upload.appendix}</span> – ` : ''}${upload.prettyBytes}</p>
            ${hasExpiryDateColumn && upload.prettyExpiryDate ? `
            <p class="expirydate">EXP: ${upload.prettyExpiryDate}</p>` : ''}
          </div>
        `

        table.appendChild(div)
        page.checkboxes = table.querySelectorAll('.checkbox[data-action="select"]')
      }
    } else {
      const allAlbums = params.all && params.filters && params.filters.includes('albumid:')
      page.dom.innerHTML = `
        ${pagination}
        ${extraControls}
        ${controls}
        <div class="table-container">
          <table class="table is-narrow is-fullwidth is-hoverable">
            <thead>
              <tr>
                <th><input id="selectAll" class="checkbox" type="checkbox" title="Select all" data-action="select-all"></th>
                <th title="Key: name">File name</th>
                ${params.album === undefined ? `<th title="Key: ${params.all ? 'userid">User' : 'albumid">Album'}</th>` : ''}
                ${allAlbums ? '<th title="Key: albumid">Album</th>' : ''}
                <th title="Key: size">Size</th>
                ${params.all ? '<th title="Key: ip">IP</th>' : ''}
                <th title="Key: timestamp">Upload date</th>
                ${hasExpiryDateColumn ? '<th title="Key: expirydate">Expiry date</th>' : ''}
                <th></th>
              </tr>
            </thead>
            <tbody id="table">
            </tbody>
          </table>
        </div>
        ${controls}
        ${bottomExtraControls}
        ${bottomPagination}
      `

      const table = document.querySelector('#table')

      for (let i = 0; i < files.length; i++) {
        const upload = files[i]
        const tr = document.createElement('tr')
        tr.dataset.id = upload.id
        tr.innerHTML = `
          <td class="controls"><input type="checkbox" class="checkbox" title="Select" data-index="${i}" data-action="select"${upload.selected ? ' checked' : ''}></td>
          <th><a href="${upload.file}" target="_blank" title="${upload.file}">${upload.name}</a></th>
          ${params.album === undefined ? `<th>${upload.appendix}</th>` : ''}
          ${allAlbums ? `<th>${upload.albumid ? (albums[upload.albumid] || '') : ''}</th>` : ''}
          <td>${upload.prettyBytes}</td>
          ${params.all ? `<td>${upload.ip || ''}</td>` : ''}
          <td>${upload.prettyDate}</td>
          ${hasExpiryDateColumn ? `<td>${upload.prettyExpiryDate || '-'}</td>` : ''}
          <td class="controls has-text-right">
            <a class="button is-small is-primary is-outlined" title="${upload.thumb ? 'Display preview' : 'File can\'t be previewed'}" data-action="display-preview"${upload.thumb ? '' : ' disabled'}>
              <span class="icon">
                <i class="${upload.type !== 'other' ? `icon-${upload.type}` : 'icon-doc-inv'}"></i>
              </span>
            </a>
            <a class="button is-small is-info is-outlined clipboard-js" title="Copy link to clipboard" data-clipboard-text="${upload.file}">
              <span class="icon">
                <i class="icon-clipboard"></i>
              </span>
            </a>
            ${params.all ? '' : `
            <a class="button is-small is-warning is-outlined" title="Add to album" data-action="add-to-album">
              <span class="icon">
                <i class="icon-plus"></i>
              </span>
            </a>`}
            <a class="button is-small is-danger is-outlined" title="Delete" data-action="delete-upload">
              <span class="icon">
                <i class="icon-trash"></i>
              </span>
            </a>
          </td>
        `

        table.appendChild(tr)
        page.checkboxes = table.querySelectorAll('.checkbox[data-action="select"]')
      }
    }

    const selectAll = document.querySelector('#selectAll')
    if (selectAll && !unselected && files.length) {
      selectAll.checked = true
      selectAll.title = 'Unselect all'
    }

    if (page.views[page.currentView].type === 'thumbs') {
      page.fadeAndScroll(true)
      page.lazyLoad.update()
    } else {
      page.fadeAndScroll()
    }

    page.updateTrigger(params.trigger, 'active')

    if (page.currentView === 'uploads')
      page.views.uploads.album = params.album
    if (page.currentView === 'uploadsAll')
      page.views.uploadsAll.filters = params.filters
    page.views[page.currentView].pageNum = files.length ? params.pageNum : 0
  }).catch(error => {
    page.updateTrigger(params.trigger)
    page.onAxiosError(error)
  })
}

page.setUploadsView = (view, element) => {
  if (page.isSomethingLoading)
    return page.warnSomethingLoading()

  if (view === 'list') {
    delete localStorage[lsKeys.viewType[page.currentView]]
    page.views[page.currentView].type = undefined
  } else {
    localStorage[lsKeys.viewType[page.currentView]] = view
    page.views[page.currentView].type = view
  }

  // eslint-disable-next-line compat/compat
  page.getUploads(Object.assign(page.views[page.currentView], {
    trigger: element
  }))
}

page.displayPreview = id => {
  const file = page.cache[id]
  if (!file.thumb) return

  const div = document.createElement('div')
  div.innerHTML = `
    <div class="field has-text-centered">
      <label class="label">${file.name}</label>
      <div class="controls swal-display-thumb-container">
        <img id="swalThumb" src="${file.thumb}">
      </div>
    </div>
  `

  if (file.original) {
    const exec = /.[\w]+(\?|$)/.exec(file.original)
    const extname = exec && exec[0] ? exec[0].toLowerCase() : null
    const isimage = page.imageExts.includes(extname)
    const isvideo = !isimage && page.videoExts.includes(extname)

    if (isimage || isvideo) {
      div.innerHTML += `
        <div class="field has-text-centered">
          <div class="controls">
            <a id="swalOriginal" type="button" class="button is-info is-outlined is-fullwidth" data-original="${file.original}">
              <span class="icon">
                <i class="icon-arrows-cw"></i>
              </span>
              <span>Load original</span>
            </a>
          </div>
        </div>
      `

      div.querySelector('#swalOriginal').addEventListener('click', event => {
        const trigger = event.currentTarget
        if (trigger.classList.contains('is-danger'))
          return

        trigger.classList.add('is-loading')
        const thumb = div.querySelector('#swalThumb')

        if (isimage) {
          thumb.src = file.original
          thumb.onload = () => {
            trigger.classList.add('is-hidden')
            document.body.querySelector('.swal-overlay .swal-modal:not(.is-expanded)').classList.add('is-expanded')
          }
          thumb.onerror = event => {
            event.currentTarget.classList.add('is-hidden')
            trigger.className = 'button is-danger is-fullwidth'
            trigger.innerHTML = `
              <span class="icon">
                <i class="icon-block"></i>
              </span>
              <span>Unable to load original</span>
            `
          }
        } else if (isvideo) {
          thumb.classList.add('is-hidden')
          const video = document.createElement('video')
          video.id = 'swalVideo'
          video.controls = true
          video.autoplay = true
          video.src = file.original
          thumb.insertAdjacentElement('afterend', video)

          trigger.classList.add('is-hidden')
          document.body.querySelector('.swal-overlay .swal-modal:not(.is-expanded)').classList.add('is-expanded')
        }
      })
    }
  }

  return swal({
    content: div,
    buttons: false
  }).then(() => {
  // Destroy video, if necessary
    const video = div.querySelector('#swalVideo')
    if (video) video.remove()

    // Restore modal size
    document.body.querySelector('.swal-overlay .swal-modal').classList.remove('is-expanded')
  })
}

page.selectAll = element => {
  for (let i = 0; i < page.checkboxes.length; i++) {
    const id = page.getItemID(page.checkboxes[i])
    if (isNaN(id)) continue
    if (page.checkboxes[i].checked !== element.checked) {
      page.checkboxes[i].checked = element.checked
      if (page.checkboxes[i].checked)
        page.selected[page.currentView].push(id)
      else
        page.selected[page.currentView].splice(page.selected[page.currentView].indexOf(id), 1)
    }
  }

  if (page.selected[page.currentView].length)
    localStorage[lsKeys.selected[page.currentView]] = JSON.stringify(page.selected[page.currentView])
  else
    delete localStorage[lsKeys.selected[page.currentView]]

  element.title = element.checked ? 'Unselect all' : 'Select all'
}

page.selectInBetween = (element, lastElement) => {
  const thisIndex = parseInt(element.dataset.index)
  const lastIndex = parseInt(lastElement.dataset.index)

  const distance = Math.abs(thisIndex - lastIndex)
  if (distance < 2)
    return

  for (let i = 0; i < page.checkboxes.length; i++)
    if ((thisIndex > lastIndex && i > lastIndex && i < thisIndex) ||
      (thisIndex < lastIndex && i > thisIndex && i < lastIndex)) {
      // Check or uncheck depending on the state of the initial checkbox
      const checked = page.checkboxes[i].checked = lastElement.checked
      const id = page.getItemID(page.checkboxes[i])
      if (!page.selected[page.currentView].includes(id) && checked)
        page.selected[page.currentView].push(id)
      else if (page.selected[page.currentView].includes(id) && !checked)
        page.selected[page.currentView].splice(page.selected[page.currentView].indexOf(id), 1)
    }
}

page.select = (element, event) => {
  const id = page.getItemID(element)
  if (isNaN(id)) return

  if (event.shiftKey && page.lastSelected) {
    page.selectInBetween(element, page.lastSelected)
    // Check or uncheck depending on the state of the initial checkbox
    element.checked = page.lastSelected.checked
  } else {
    page.lastSelected = element
  }

  if (!page.selected[page.currentView].includes(id) && element.checked)
    page.selected[page.currentView].push(id)
  else if (page.selected[page.currentView].includes(id) && !element.checked)
    page.selected[page.currentView].splice(page.selected[page.currentView].indexOf(id), 1)

  // Update local storage
  if (page.selected[page.currentView].length)
    localStorage[lsKeys.selected[page.currentView]] = JSON.stringify(page.selected[page.currentView])
  else
    delete localStorage[lsKeys.selected[page.currentView]]
}

page.clearSelection = () => {
  const selected = page.selected[page.currentView]
  const type = page.getByView(page.currentView, 'type')
  const count = selected.length
  if (!count)
    return swal('An error occurred!', `You have not selected any ${type}.`, 'error')

  const suffix = count === 1 ? type.substring(0, type.length - 1) : type
  return swal({
    title: 'Are you sure?',
    text: `You are going to unselect ${count} ${suffix}.`,
    buttons: true
  }).then(proceed => {
    if (!proceed) return

    const checkboxes = page.checkboxes
    for (let i = 0; i < checkboxes.length; i++)
      if (checkboxes[i].checked)
        checkboxes[i].checked = false

    page.selected[page.currentView] = []
    delete localStorage[lsKeys.selected[page.currentView]]

    const selectAll = document.querySelector('#selectAll')
    if (selectAll) selectAll.checked = false

    return swal('Cleared selection!', `Unselected ${count} ${suffix}.`, 'success')
  })
}

page.uploadFiltersHelp = element => {
  const all = Boolean(element.dataset.all)
  const content = document.createElement('div')
  content.style = 'text-align: left'
  content.innerHTML = `${all ? `
    There are 2 filter keys, namely <b>user</b> (username) and <b>ip</b>.
    These keys can be specified more than once.
    For usernames with whitespaces, wrap them with double quotes (<code>"</code>).
    Special cases such as uploads by non-registered users or have no IPs respectively, use <code>user:-</code> or <code>ip:-</code>.

    To exclude certain users/ips while still listing every other uploads, add negation sign (<code>-</code>) before the keys.
    Negation sign can also be used to exclude the special cases mentioned above (i.e. <code>-user:-</code> or <code>-ip:-</code>).

    If you know the ID of a user's album, you can list its uploads with <b>albumid</b> key.
    Negation sign works for this key as well.
    ` : `
    There is only 1 filter key, namely <b>albumid</b>.
    This key can be specified more than once.
    Special case such as uploads with no albums, use <code>albumid:-</code>.

    To exclude certain albums while still listing every other uploads, add negation sign (<code>-</code>) before the keys.
    Negation sign can also be used to exclude the special case mentioned above (i.e. <code>-albumid:-</code>).
    `}
    There are 2 range keys: <b>date</b> (upload date) and <b>expiry</b> (expiry date).
    Their format is: <code>"YYYY/MM/DD HH:MM:SS-YYYY/MM/DD HH:MM:SS"</code> ("from" date and "to" date respectively).
    You may specify only one of the dates.
    If "to" date is missing, 'now' will be used. If "from" date is missing, 'beginning of time' will be used.
    If any of the subsequent date or time units are not specified, their first value will be used (e.g. January for month, 1 for day, and so on).
    If only time is specified, today's date will be used.
    If you do not need to specify both date and time, you may omit the double quotes.
    In conclusion, the following examples are all valid: <code>date:"2020/01/01 01:23-2018/01/01 06"</code>, <code>expiry:-2020/05</code>, <code>date:12:34:56</code>.
    These keys can only be specified once each.

    <b>Timezone?</b> Feel free to query the dates with your own timezone.
    API requests to the filter endpoint will attach your browser's timezone offset, so the server will automatically calculate timezone differences.

    Matches can also be sorted with <b>sort</b> keys.
    Their formats are: <code>sort:columnName[:d[escending]]</code>, where <code>:d[escending]</code> is an optional tag to set the direction to descending.
    This key must be used with internal column names used in the database (<code>id</code>, <code>${all ? 'userid' : 'albumid'}</code>, and so on),
    but there are 2 shortcuts available: <b>date</b> for <code>timestamp</code> column and <b>expiry</b> for <code>expirydate</code> column.
    This key can also be specified more than once, where their order will decide the sorting steps.

    Finally, there are type-<b>is</b> keys to refine by types.
    You can use <code>is:image</code> and <code>is:video</code> to list images and videos respectively.
    This will only use image/video extensions whose thumbnails can be generated by the safe.
    Negation sign works for this key as well.
    Mixing inclusion and exclusion is not allowed (i.e. <code>is:image -is:video</code>, since the second key is redundant).

    Any leftover keywords which do not use keys (non-keyed keywords) will be matched against the matches' file names.
    Excluding certain keywords is also supported by adding negation sign before the keywords.

    <b>Internal steps:</b>
    ${all ? `- Query uploads passing ALL exclusion filter keys OR matching ANY filter keys, if any.
    - Refine matches` : '- Filter uploads'} using date key, if any.
    - Refine matches using expiry key, if any.
    - Refine matches using type-is keys, if any.
    - Refine matches using ANY non-keyed keywords, if any.
    - Filter matches using ALL exclusion non-keyed keywords, if any.
    - Sort matches using sorting keys, if any.

    <b>Examples:</b>
    ${all ? `- Uploads from users named "demo" AND/OR "John Doe" AND/OR non-registered users:
    <code>user:demo user:"John Doe" user:-</code>
    - ALL uploads, but NOT the ones from user named "demo" AND "John Doe":
    <code>-user:demo -user:"John Doe"</code>
    - Uploads from IP "127.0.0.1" AND which file names match "*.rar" OR "*.zip":
    <code>ip:127.0.0.1 *.rar *.zip</code>
    ` : ''}- Uploads without albums:
    <code>albumid:-</code>
    - ALL uploads, but NOT the ones from album with ID 69:
    <code>-albumid:69</code>
    - Uploads uploaded since "1 June 2019 00:00:00":
    <code>date:2019/06</code>
    - Uploads uploaded between "7 April 2020 12:00:00" and "7 April 2020 23:59:59":
    <code>date:"2020/04/07 12-2020/04/07 23:59:59"</code>
    - Uploads uploaded before "5 February 2020 00:00:00":
    <code>date:-2020/02/05</code>
    - Uploads which file names match "*.gz" but NOT "*.tar.gz":
    <code>*.gz -*.tar.gz</code>
    - Sort matches by "size" column in ascending and descending order respectively:
    <code>${all ? 'user:"John Doe"' : '*.txt'} sort:size</code>
    <code>*.mp4 ${all ? 'user:- ' : ''}sort:size:d</code>
    ${!page.permissions.moderator ? `
    <b>Notice:</b> Regular users may face some limitations in the amount of keys that can be used at a time.
    ` : ''}
    <b>Friendly reminder:</b> This window can be scrolled up!
  `.trim().replace(/^\s*/g, '').replace(/\n/g, '<br>')

  swal({ content }).then(() => {
    // Restore modal size
    document.body.querySelector('.swal-overlay .swal-modal').classList.remove('is-expanded')
  })

  // Expand modal size
  document.body.querySelector('.swal-overlay .swal-modal:not(.is-expanded)').classList.add('is-expanded')
}

page.filterUploads = element => {
  const filters = document.querySelector(`#${element.dataset.filtersid || 'filters'}`).value
    .trim()
    .replace(/\t/g, ' ')
    .replace(/(^|\s)((albumid|ip|user|date|expiry|is|sort|orderby):)\s+/g, '$2')
  // eslint-disable-next-line compat/compat
  page.getUploads(Object.assign(page.views[page.currentView], {
    filters,
    pageNum: 0,
    trigger: element
  }))
}

page.viewUserUploads = (id, element) => {
  const user = page.cache[id]
  if (!user) return
  element.classList.add('is-loading')
  // Wrap username in quotes if it contains whitespaces
  const username = user.username.includes(' ')
    ? `"${user.username}"`
    : user.username
  page.getUploads({
    all: true,
    filters: `user:${username}`,
    trigger: document.querySelector('#itemManageUploads')
  })
}

page.viewAlbumUploads = (id, element) => {
  if (!page.cache[id]) return
  element.classList.add('is-loading')
  // eslint-disable-next-line compat/compat
  const all = page.currentView === 'albumsAll' && page.permissions.moderator
  page.getUploads({
    all,
    filters: `albumid:${id}`,
    trigger: all
      ? document.querySelector('#itemManageUploads')
      : document.querySelector('#itemUploads')
  })
}

page.deleteUpload = id => {
  page.postBulkDeleteUploads({
    all: page.currentView === 'uploadsAll',
    field: 'id',
    values: [id],
    cb (failed) {
      // Remove from remembered checkboxes if necessary
      if (!failed.length && page.selected[page.currentView].includes(id))
        page.selected[page.currentView].splice(page.selected[page.currentView].indexOf(id), 1)

      // Update local storage
      if (page.selected[page.currentView].length)
        localStorage[lsKeys.selected[page.currentView]] = JSON.stringify(page.selected[page.currentView])
      else
        delete localStorage[lsKeys.selected[page.currentView]]

      // Reload upload list
      // eslint-disable-next-line compat/compat
      page.getUploads(Object.assign(page.views[page.currentView], {
        autoPage: true
      }))
    }
  })
}

page.bulkDeleteUploads = () => {
  const count = page.selected[page.currentView].length
  if (!count)
    return swal('An error occurred!', 'You have not selected any uploads.', 'error')

  page.postBulkDeleteUploads({
    all: page.currentView === 'uploadsAll',
    field: 'id',
    values: page.selected[page.currentView],
    cb (failed) {
      // Update state of checkboxes
      if (failed.length)
        page.selected[page.currentView] = page.selected[page.currentView]
          .filter(id => {
            return failed.includes(id)
          })
      else
        page.selected[page.currentView] = []

      // Update local storage
      if (page.selected[page.currentView].length)
        localStorage[lsKeys.selected[page.currentView]] = JSON.stringify(page.selected[page.currentView])
      else
        delete localStorage[lsKeys.selected[page.currentView]]

      // Reload uploads list
      // eslint-disable-next-line compat/compat
      page.getUploads(Object.assign(page.views[page.currentView], {
        autoPage: true
      }))
    }
  })
}

page.deleteUploadsByNames = (params = {}) => {
  let appendix = ''
  if (page.permissions.moderator)
    appendix = '<br><b>Hint:</b> You can use this feature to delete uploads by other users.'

  page.dom.innerHTML = `
    <form class="prevent-default">
      <div class="field">
        <label class="label">Upload names:</label>
        <div class="control">
          <textarea id="bulkDeleteNames" class="textarea"></textarea>
        </div>
        <p class="help">Separate each entry with a new line.${appendix}</p>
      </div>
      <div class="field">
        <div class="control">
          <button type="submit" id="submitBulkDelete" class="button is-danger is-outlined is-fullwidth">
            <span class="icon">
              <i class="icon-trash"></i>
            </span>
            <span>Bulk delete</span>
          </button>
        </div>
      </div>
    </form>
  `
  page.fadeAndScroll()
  page.updateTrigger(params.trigger, 'active')

  document.querySelector('#submitBulkDelete').addEventListener('click', () => {
    if (page.isSomethingLoading)
      return page.warnSomethingLoading()

    const textArea = document.querySelector('#bulkDeleteNames')

    // Clean up
    const seen = {}
    const names = textArea.value
      .split(/\r?\n/)
      .map(name => {
        const trimmed = name.trim()
        return /^[^\s]+$/.test(trimmed)
          ? trimmed
          : ''
      })
      .filter(name => {
        // Filter out invalid and duplicate names
        return (!name || Object.prototype.hasOwnProperty.call(seen, name))
          ? false
          : (seen[name] = true)
      })

    // Update textarea with cleaned names
    textArea.value = names.join('\n')

    if (!names.length)
      return swal('An error occurred!', 'You have not entered any upload names.', 'error')

    page.postBulkDeleteUploads({
      all: true,
      field: 'name',
      values: names,
      cb (failed) {
        textArea.value = failed.join('\n')
      }
    })
  })
}

page.postBulkDeleteUploads = (params = {}) => {
  const count = params.values.length

  const objective = `${params.values.length} upload${count === 1 ? '' : 's'}`
  const boldObjective = objective.replace(/^(\d*)(.*)/, '<b>$1</b>$2')
  let text = `<p>You won't be able to recover ${boldObjective}!</p>`

  if (params.all) {
    const obj1 = count === 1 ? 'an upload' : 'some uploads'
    const obj2 = count === 1 ? 'another user' : 'other users'
    text += `\n<p><b>Warning:</b> You may be nuking ${obj1} by ${obj2}!</p>`
  }

  const content = document.createElement('div')
  content.innerHTML = text

  swal({
    title: 'Are you sure?',
    content,
    icon: 'warning',
    dangerMode: true,
    buttons: {
      cancel: true,
      confirm: {
        text: `Yes, nuke ${params.values.length === 1 ? 'it' : 'them'}!`,
        closeModal: false
      }
    }
  }).then(proceed => {
    if (!proceed) return

    axios.post('api/upload/bulkdelete', {
      field: params.fields,
      values: params.values
    }).then(response => {
      if (!response) return

      if (response.data.success === false)
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }

      const failed = Array.isArray(response.data.failed) ? response.data.failed : []
      if (failed.length === params.values.length)
        swal('An error occurred!', `Unable to delete any of the ${objective}.`, 'error')
      else if (failed.length && failed.length < params.values.length)
        swal('Warning!', `From ${objective}, unable to delete ${failed.length} of them.`, 'warning')
      else
        swal('Deleted!', `${objective} ${count === 1 ? 'has' : 'have'} been deleted.`, 'success', {
          buttons: false,
          timer: 1500
        })

      if (typeof params.cb === 'function')
        params.cb(failed)
    }).catch(page.onAxiosError)
  })
}

page.addSelectedUploadsToAlbum = () => {
  if (page.currentView !== 'uploads')
    return

  const count = page.selected[page.currentView].length
  if (!count)
    return swal('An error occurred!', 'You have not selected any uploads.', 'error')

  page.addUploadsToAlbum(page.selected[page.currentView], failed => {
    if (!failed) return
    if (failed.length)
      page.selected[page.currentView] = page.selected[page.currentView].filter(id => {
        return failed.includes(id)
      })
    else
      page.selected[page.currentView] = []

    localStorage[lsKeys.selected[page.currentView]] = JSON.stringify(page.selected[page.currentView])
    page.getUploads(page.views[page.currentView])
  })
}

page.addToAlbum = id => {
  page.addUploadsToAlbum([id], failed => {
    if (!failed) return
    page.getUploads(page.views[page.currentView])
  })
}

page.addUploadsToAlbum = (ids, callback) => {
  const count = ids.length

  const content = document.createElement('div')
  content.innerHTML = `
    <div class="field has-text-centered">
      <p>You are about to add <b>${count}</b> upload${count === 1 ? '' : 's'} to an album.</p>
      <p><b>If an upload is already in an album, it will be moved.</b></p>
    </div>
    <div class="field">
      <div class="control">
        <div class="select is-fullwidth">
          <select id="swalAlbum" disabled>
            <option value="-1">Remove from album</option>
            <option value="" selected disabled>Fetching albums list\u2026</option>
          </select>
        </div>
      </div>
    </div>
  `

  swal({
    icon: 'warning',
    content,
    buttons: {
      cancel: true,
      confirm: {
        text: 'OK',
        closeModal: false
      }
    }
  }).then(choose => {
    if (!choose) return

    const albumid = parseInt(document.querySelector('#swalAlbum').value)
    if (isNaN(albumid))
      return swal('An error occurred!', 'You did not choose an album.', 'error')

    axios.post('api/albums/addfiles', {
      ids,
      albumid
    }).then(add => {
      if (!add) return

      if (add.data.success === false) {
        if (add.data.description === 'No token provided')
          page.verifyToken(page.token)
        else
          swal('An error occurred!', add.data.description, 'error')

        return
      }

      let added = ids.length
      if (add.data.failed && add.data.failed.length)
        added -= add.data.failed.length

      const suffix = `upload${ids.length === 1 ? '' : 's'}`
      if (!added)
        return swal('An error occurred!', `Could not add the ${suffix} to the album.`, 'error')

      swal('Woohoo!', `Successfully ${albumid < 0 ? 'removed' : 'added'} ${added} ${suffix} ${albumid < 0 ? 'from' : 'to'} the album.`, 'success', {
        buttons: false,
        timer: 1500
      })
      callback(add.data.failed)
    }).catch(page.onAxiosError)
  })

  // Get albums list then update content of swal
  axios.get('api/albums').then(list => {
    if (list.data.success === false) {
      if (list.data.description === 'No token provided')
        page.verifyToken(page.token)
      else
        swal('An error occurred!', list.data.description, 'error')

      return
    }

    // If the prompt was replaced, the container would be missing
    const select = document.querySelector('#swalAlbum')
    if (!select) return

    select.innerHTML += list.data.albums
      .map(album => {
        return `<option value="${album.id}">${album.name}</option>`
      })
      .join('\n')

    select.getElementsByTagName('option')[1].innerHTML = 'Choose an album'
    select.removeAttribute('disabled')
  }).catch(page.onAxiosError)
}

page.getAlbums = (params = {}) => {
  if (params && params.all && !page.permissions.moderator)
    return swal('An error occurred!', 'You cannot do this!', 'error')

  if (page.isSomethingLoading)
    return page.warnSomethingLoading()

  page.updateTrigger(params.trigger, 'loading')

  if (typeof params.pageNum !== 'number')
    params.pageNum = 0

  const headers = {}

  if (params.all)
    headers.all = '1'

  const url = `api/albums/${params.pageNum}`
  axios.get(url, { headers }).then(response => {
    if (!response) return

    if (response.data.success === false)
      if (response.data.description === 'No token provided') {
        return page.verifyToken(page.token)
      } else {
        page.updateTrigger(params.trigger)
        return swal('An error occurred!', response.data.description, 'error')
      }

    const pages = Math.ceil(response.data.count / 25)
    const albums = response.data.albums
    if (params.pageNum && (albums.length === 0))
      if (params.autoPage) {
        params.pageNum = pages - 1
        return page.getAlbums(params)
      } else {
        page.updateTrigger(params.trigger)
        return swal('An error occurred!', `There are no more albums to populate page ${params.pageNum + 1}.`, 'error')
      }

    page.currentView = params.all ? 'albumsAll' : 'albums'
    page.cache = {}

    const users = response.data.users
    const homeDomain = response.data.homeDomain

    if (params.pageNum < 0) params.pageNum = Math.max(0, pages + params.pageNum)
    const pagination = page.paginate(response.data.count, 25, params.pageNum)

    const filter = `
      <div class="column">
        <form class="prevent-default">
          <div class="field has-addons">
            <div class="control is-expanded">
              <input id="filters" class="input is-small" type="text" placeholder="Filter albums (WIP)" value="${page.escape(params.filters || '')}" disabled>
            </div>
            <div class="control">
              <button type="button" class="button is-small is-primary is-outlined" title="Help? (WIP)" data-action="album-filters-help" disabled>
                <span class="icon">
                  <i class="icon-help-circled"></i>
                </span>
              </button>
            </div>
            <div class="control">
              <button type="submit" class="button is-small is-info is-outlined" title="Filter albums (WIP)" data-action="filter-albums" disabled>
                <span class="icon">
                  <i class="icon-filter"></i>
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    `
    const extraControls = `
      <div class="columns">
        ${filter}
        <div class="column is-one-quarter">
          <form class="prevent-default">
            <div class="field has-addons">
              <div class="control is-expanded">
                <input id="jumpToPage" class="input is-small" type="number" min="1" max="${pages}" value="${params.pageNum + 1}"${pages === 1 ? ' disabled' : ''}>
              </div>
              <div class="control">
                <button type="submit" class="button is-small is-info is-outlined" title="Jump to page" data-action="jump-to-page">
                  <span class="icon">
                    <i class="icon-paper-plane"></i>
                  </span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    `

    const controls = `
      <div class="columns">
        <div class="column is-hidden-mobile"></div>
        <div class="column bulk-operations has-text-right">
          <a class="button is-small is-info is-outlined" title="Clear selection" data-action="clear-selection">
            <span class="icon">
              <i class="icon-cancel"></i>
            </span>
          </a>
          <a class="button is-small is-dangerish is-outlined" title="Bulk disable (WIP)" data-action="bulk-disable-albums" disabled>
            <span class="icon">
              <i class="icon-trash"></i>
            </span>
            ${!params.all ? '<span>Bulk disable</span>' : ''}
          </a>
          ${params.all
            ? `<a class="button is-small is-danger is-outlined" title="Bulk delete (WIP)" data-action="bulk-delete-albums" disabled>
                <span class="icon">
                  <i class="icon-trash"></i>
                </span>
                <span>Bulk delete</span>
              </a>`
            : ''}
        </div>
      </div>
    `

    // Do some string replacements for bottom controls
    const bottomFiltersId = 'bFilters'
    const bottomJumpId = 'bJumpToPage'
    const bottomExtraControls = extraControls
      .replace(/id="filters"/, `id="${bottomFiltersId}"`)
      .replace(/(data-action="filter-uploads")/, `$1 data-filtersid="${bottomFiltersId}"`)
      .replace(/id="jumpToPage"/, `id="${bottomJumpId}"`)
      .replace(/(data-action="jump-to-page")/g, `$1 data-jumpid="${bottomJumpId}"`)
    const bottomPagination = pagination
      .replace(/(data-action="page-ellipsis")/g, `$1 data-jumpid="${bottomJumpId}"`)

    // Whether there are any unselected items
    let unselected = false

    const createNewAlbum = `
      <h2 class="subtitle">Create new album</h2>
      <form class="prevent-default">
        <div class="field">
          <div class="control">
            <input id="albumName" class="input" type="text" placeholder="Name" maxlength="${page.albumTitleMaxLength}">
          </div>
          <p class="help">Max length is ${page.albumTitleMaxLength} characters.</p>
        </div>
        <div class="field">
          <div class="control">
            <textarea id="albumDescription" class="textarea" placeholder="Description" rows="1" maxlength="${page.albumDescMaxLength}"></textarea>
          </div>
          <p class="help">Max length is ${page.albumDescMaxLength} characters.</p>
        </div>
        <div class="field">
          <div class="control">
            <button type="submit" id="submitAlbum" class="button is-info is-outlined is-fullwidth" data-action="submit-album">
              <span class="icon">
                <i class="icon-paper-plane"></i>
              </span>
              <span>Create</span>
            </button>
          </div>
        </div>
      </form>
      <hr>
    `

    page.dom.innerHTML = `
      ${!params.all ? createNewAlbum : ''}
      ${pagination}
      ${extraControls}
      ${controls}
      <div class="table-container">
        <table class="table is-narrow is-fullwidth is-hoverable">
          <thead>
            <tr>
              <th><input id="selectAll" class="checkbox" type="checkbox" title="Select all" data-action="select-all"></th>
              <th>ID</th>
              <th>Name</th>
              ${params.all ? '<th>User</th>' : ''}
              <th>Uploads</th>
              <th>Created at</th>
              <th>Public link</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="table">
          </tbody>
        </table>
      </div>
      ${controls}
      ${bottomExtraControls}
      ${bottomPagination}
    `

    const table = document.querySelector('#table')

    for (let i = 0; i < albums.length; i++) {
      const album = albums[i]
      const albumUrl = `${homeDomain}/a/${album.identifier}`

      const selected = page.selected[page.currentView].includes(album.id)
      if (!selected) unselected = true

      // Prettify
      album.prettyDate = page.getPrettyDate(new Date(album.timestamp * 1000))

      // Server-side explicitly expect this value to consider an album as disabled
      const enabled = album.enabled !== 0
      page.cache[album.id] = {
        name: album.name,
        download: album.download,
        public: album.public,
        description: album.description,
        enabled
      }

      const tr = document.createElement('tr')
      tr.dataset.id = album.id
      tr.innerHTML = `
        <td class="controls"><input type="checkbox" class="checkbox" title="Select" data-index="${i}" data-action="select"${selected ? ' checked' : ''}></td>
        <th>${album.id}</th>
        <th${enabled ? '' : ' class="has-text-grey"'}>${album.name}</td>
        ${params.all ? `<th>${album.userid ? (users[album.userid] || '') : ''}</th>` : ''}
        <th>${album.uploads}</th>
        <td>${album.prettyDate}</td>
        <td><a ${enabled && album.public ? '' : 'class="is-linethrough" '}href="${albumUrl}" target="_blank">${albumUrl}</a></td>
        <td class="has-text-right" data-id="${album.id}">
          <a class="button is-small is-primary is-outlined" title="Edit album" data-action="edit-album">
            <span class="icon is-small">
              <i class="icon-pencil"></i>
            </span>
          </a>
          <a class="button is-small is-info is-outlined" title="${album.uploads ? 'View uploads' : 'Album doesn\'t have uploads'}" data-action="view-album-uploads" ${album.uploads ? '' : 'disabled'}>
            <span class="icon">
              <i class="icon-docs"></i>
            </span>
          </a>
          <a class="button is-small is-info is-outlined clipboard-js" title="Copy link to clipboard" ${album.public ? `data-clipboard-text="${albumUrl}"` : 'disabled'}>
            <span class="icon is-small">
              <i class="icon-clipboard"></i>
            </span>
          </a>
          <a class="button is-small is-warning is-outlined" title="Download album" ${enabled && album.download ? `href="api/album/zip/${album.identifier}?v=${album.editedAt}"` : 'disabled'}>
            <span class="icon is-small">
              <i class="icon-download"></i>
            </span>
          </a>
          <a class="button is-small is-dangerish is-outlined" title="Disable album" data-action="disable-album"${enabled ? '' : ' disabled'}>
            <span class="icon is-small">
              <i class="icon-trash"></i>
            </span>
          </a>
        </td>
      `

      table.appendChild(tr)
      page.checkboxes = table.querySelectorAll('.checkbox[data-action="select"]')
    }

    const selectAll = document.querySelector('#selectAll')
    if (selectAll && !unselected) {
      selectAll.checked = true
      selectAll.title = 'Unselect all'
    }

    page.fadeAndScroll()
    page.updateTrigger(params.trigger, 'active')

    if (page.currentView === 'albumsAll')
      page.views[page.currentView].filters = params.filters
    page.views[page.currentView].pageNum = albums.length ? params.pageNum : 0
  }).catch(error => {
    page.updateTrigger(params.trigger)
    page.onAxiosError(error)
  })
}

page.editAlbum = id => {
  const album = page.cache[id]
  if (!album) return

  const div = document.createElement('div')
  div.innerHTML = `
    <div class="field">
      <div class="controls">
        <input id="swalName" class="input" type="text" placeholder="Name" maxlength="${page.albumTitleMaxLength}" value="${(album.name || '').substring(0, page.albumTitleMaxLength)}">
      </div>
      <p class="help">Max length is ${page.albumTitleMaxLength} characters.</p>
    </div>
    <div class="field">
      <div class="control">
        <textarea id="swalDescription" class="textarea" placeholder="Description" rows="2" maxlength="${page.albumDescMaxLength}">${(album.description || '').substring(0, page.albumDescMaxLength)}</textarea>
      </div>
      <p class="help">Max length is ${page.albumDescMaxLength} characters.</p>
    </div>
    ${page.currentView === 'albumsAll' && page.permissions.moderator
      ? `<div class="field">
          <div class="control">
            <label class="checkbox">
              <input id="swalEnabled" type="checkbox" ${album.enabled ? 'checked' : ''}>
              Enabled
            </label>
          </div>
        </div>`
      : ''}
    <div class="field">
      <div class="control">
        <label class="checkbox">
          <input id="swalDownload" type="checkbox" ${album.download ? 'checked' : ''}>
          Enable download
        </label>
      </div>
    </div>
    <div class="field">
      <div class="control">
        <label class="checkbox">
          <input id="swalPublic" type="checkbox" ${album.public ? 'checked' : ''}>
          Enable public link
        </label>
      </div>
    </div>
    <div class="field">
      <div class="control">
        <label class="checkbox">
          <input id="swalRequestLink" type="checkbox">
          Request new public link
        </label>
      </div>
    </div>
  `

  swal({
    title: 'Edit album',
    icon: 'info',
    content: div,
    buttons: {
      cancel: true,
      confirm: {
        closeModal: false
      }
    }
  }).then(value => {
    if (!value) return

    const post = {
      id,
      name: document.querySelector('#swalName').value.trim(),
      description: document.querySelector('#swalDescription').value.trim(),
      download: document.querySelector('#swalDownload').checked,
      public: document.querySelector('#swalPublic').checked,
      requestLink: document.querySelector('#swalRequestLink').checked
    }

    if (page.currentView === 'albumsAll' && page.permissions.moderator)
      post.enabled = document.querySelector('#swalEnabled').checked

    axios.post('api/albums/edit', post).then(response => {
      if (!response) return

      if (response.data.success === false)
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }

      if (response.data.identifier)
        swal('Success!', `The album's new identifier is: ${response.data.identifier}.`, 'success')
      else if (response.data.name !== album.name)
        swal('Success!', `The album was renamed to: ${response.data.name}.`, 'success')
      else
        swal('Success!', 'The album was edited.', 'success', {
          buttons: false,
          timer: 1500
        })

      page.getAlbumsSidebar()
      // Reload albums list
      // eslint-disable-next-line compat/compat
      page.getAlbums(Object.assign(page.views[page.currentView], {
        autoPage: true
      }))
    }).catch(page.onAxiosError)
  })
}

page.disableAlbum = id => {
  swal({
    title: 'Are you sure?',
    text: 'This won\'t delete the uploads associated with the album!',
    icon: 'warning',
    dangerMode: true,
    buttons: {
      cancel: true,
      confirm: {
        text: 'Yes, disable it!',
        closeModal: false
      },
      purge: {
        text: 'Umm, delete the uploads too, please?',
        value: 'purge',
        className: 'swal-button--danger',
        closeModal: false
      }
    }
  }).then(proceed => {
    if (!proceed) return

    axios.post('api/albums/disable', {
      id,
      purge: proceed === 'purge'
    }).then(response => {
      if (response.data.success === false) {
        const failed = Array.isArray(response.data.failed)
          ? response.data.failed
          : []

        if (response.data.description === 'No token provided')
          return page.verifyToken(page.token)
        else if (failed.length)
          return swal('An error occurred!', `Unable to delete ${failed.length} of the album's upload${failed.length === 1 ? '' : 's'}.`, 'error')
        else
          return swal('An error occurred!', response.data.description, 'error')
      }

      swal('Deleted!', 'Your album has been disabled.', 'success', {
        buttons: false,
        timer: 1500
      })

      page.getAlbumsSidebar()
      // Reload albums list
      // eslint-disable-next-line compat/compat
      page.getAlbums(Object.assign(page.views[page.currentView], {
        autoPage: true
      }))
    }).catch(page.onAxiosError)
  })
}

page.submitAlbum = element => {
  page.updateTrigger(element, 'loading')

  axios.post('api/albums', {
    name: document.querySelector('#albumName').value.trim(),
    description: document.querySelector('#albumDescription').value.trim()
  }).then(response => {
    if (!response) return

    page.updateTrigger(element)
    if (response.data.success === false)
      if (response.data.description === 'No token provided') {
        return page.verifyToken(page.token)
      } else {
        return swal('An error occurred!', response.data.description, 'error')
      }

    swal('Woohoo!', 'Album was created successfully.', 'success', {
      buttons: false,
      timer: 1500
    })
    page.getAlbumsSidebar()
    page.getAlbums({
      pageNum: -1
    })
  }).catch(error => {
    page.updateTrigger(element)
    page.onAxiosError(error)
  })
}

page.getAlbumsSidebar = () => {
  axios.get('api/albums', { headers: { sidebar: '1' } }).then(response => {
    if (!response) return

    if (response.data.success === false)
      if (response.data.description === 'No token provided') {
        return page.verifyToken(page.token)
      } else {
        return swal('An error occurred!', response.data.description, 'error')
      }

    const albums = response.data.albums
    const count = response.data.count
    const albumsContainer = document.querySelector('#albumsContainer')

    // Clear albums sidebar if necessary
    const oldAlbums = albumsContainer.querySelectorAll('li > a')
    if (oldAlbums.length) {
      for (let i = 0; i < oldAlbums.length; i++)
        page.menus.splice(page.menus.indexOf(oldAlbums[i]), 1)
      albumsContainer.innerHTML = ''
    }

    if (albums === undefined)
      return

    for (let i = 0; i < albums.length; i++) {
      const album = albums[i]
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.id = album.id
      a.className = 'is-relative'
      a.innerHTML = album.name

      a.addEventListener('click', event => {
        page.getUploads({
          album: parseInt(event.currentTarget.id),
          trigger: event.currentTarget
        })
      })
      page.menus.push(a)

      li.appendChild(a)
      albumsContainer.appendChild(li)
    }

    if (count > albums.length) {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.className = 'is-relative'
      a.innerHTML = '...'
      a.title = `You have ${count} albums, but the sidebar can only list your first ${albums.length} albums.`

      a.addEventListener('click', event => {
        page.getAlbums({
          trigger: document.querySelector('#itemManageYourAlbums')
        })
      })

      li.appendChild(a)
      albumsContainer.appendChild(li)
    }
  }).catch(page.onAxiosError)
}

page.changeToken = (params = {}) => {
  page.dom.innerHTML = `
    <div class="field">
      <label class="label">Your current token:</label>
      <div class="field">
        <div class="control">
          <input id="token" readonly class="input" type="text" placeholder="Your token" value="${page.token}">
        </div>
      </div>
    </div>
    <div class="field">
      <div class="control">
        <a id="getNewToken" class="button is-info is-outlined is-fullwidth">
          <span class="icon">
            <i class="icon-arrows-cw"></i>
          </span>
          <span>Request new token</span>
        </a>
      </div>
    </div>
  `
  page.fadeAndScroll()
  page.updateTrigger(params.trigger, 'active')

  document.querySelector('#getNewToken').addEventListener('click', event => {
    if (page.isSomethingLoading)
      return page.warnSomethingLoading()

    const trigger = event.currentTarget
    page.updateTrigger(trigger, 'loading')
    axios.post('api/tokens/change').then(response => {
      if (response.data.success === false)
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          page.updateTrigger(trigger)
          return swal('An error occurred!', response.data.description, 'error')
        }

      page.updateTrigger(trigger)
      swal({
        title: 'Woohoo!',
        text: 'Your token was successfully changed.',
        icon: 'success',
        buttons: false,
        timer: 1500
      }).then(() => {
        axios.defaults.headers.common.token = response.data.token
        localStorage[lsKeys.token] = response.data.token
        page.token = response.data.token
        page.changeToken()
      })
    }).catch(error => {
      page.updateTrigger(trigger)
      page.onAxiosError(error)
    })
  })
}

page.changePassword = (params = {}) => {
  page.dom.innerHTML = `
    <form class="prevent-default">
      <div class="field">
        <label class="label">New password:</label>
        <div class="control">
          <input id="password" class="input" type="password" minlength="6" maxlength="64">
        </div>
      </div>
      <div class="field">
        <label class="label">Re-type new password:</label>
        <div class="control">
          <input id="passwordConfirm" class="input" type="password" minlength="6" maxlength="64">
        </div>
      </div>
      <div class="field">
        <div class="control">
          <button type="submit" id="sendChangePassword" class="button is-info is-outlined is-fullwidth">
            <span class="icon">
              <i class="icon-paper-plane"></i>
            </span>
            <span>Set new password</span>
          </button>
        </div>
      </div>
    </form>
  `
  page.fadeAndScroll()
  page.updateTrigger(params.trigger, 'active')

  document.querySelector('#sendChangePassword').addEventListener('click', event => {
    if (page.isSomethingLoading)
      return page.warnSomethingLoading()

    if (!page.dom.querySelector('form').checkValidity())
      return

    if (document.querySelector('#password').value === document.querySelector('#passwordConfirm').value)
      page.sendNewPassword(document.querySelector('#password').value, event.currentTarget)
    else
      swal({
        title: 'Password mismatch!',
        text: 'Your passwords do not match, please try again.',
        icon: 'error'
      })
  })
}

page.sendNewPassword = (pass, element) => {
  page.updateTrigger(element, 'loading')

  axios.post('api/password/change', { password: pass }).then(response => {
    if (response.data.success === false)
      if (response.data.description === 'No token provided') {
        return page.verifyToken(page.token)
      } else {
        page.updateTrigger(element)
        return swal('An error occurred!', response.data.description, 'error')
      }

    page.updateTrigger(element)
    swal({
      title: 'Woohoo!',
      text: 'Your password was successfully changed.',
      icon: 'success',
      buttons: false,
      timer: 1500
    }).then(() => {
      page.changePassword()
    })
  }).catch(error => {
    page.updateTrigger(element)
    page.onAxiosError(error)
  })
}

page.getUsers = (params = {}) => {
  if (page.isSomethingLoading)
    return page.warnSomethingLoading()

  if (!page.permissions.admin)
    return swal('An error occurred!', 'You cannot do this!', 'error')

  page.updateTrigger(params.trigger, 'loading')

  if (typeof params.pageNum !== 'number')
    params.pageNum = 0

  const url = `api/users/${params.pageNum}`
  axios.get(url).then(response => {
    if (response.data.success === false)
      if (response.data.description === 'No token provided') {
        return page.verifyToken(page.token)
      } else {
        page.updateTrigger(params.trigger)
        return swal('An error occurred!', response.data.description, 'error')
      }

    const pages = Math.ceil(response.data.count / 25)
    const users = response.data.users
    if (params.pageNum && (users.length === 0))
      if (params.autoPage) {
        params.pageNum = pages - 1
        return page.getUsers(params)
      } else {
        page.updateTrigger(params.trigger)
        return swal('An error occurred!', `There are no more users to populate page ${params.pageNum + 1}.`, 'error')
      }

    page.currentView = 'users'
    page.cache = {}

    if (params.pageNum < 0) params.pageNum = Math.max(0, pages + params.pageNum)
    const pagination = page.paginate(response.data.count, 25, params.pageNum)

    const filter = `
      <div class="column">
        <form class="prevent-default">
          <div class="field has-addons">
            <div class="control is-expanded">
              <input id="filters" class="input is-small" type="text" placeholder="Filter users (WIP)" value="${page.escape(params.filters || '')}" disabled>
            </div>
            <div class="control">
              <button type="button" class="button is-small is-primary is-outlined" title="Help? (WIP)" data-action="user-filters-help" disabled>
                <span class="icon">
                  <i class="icon-help-circled"></i>
                </span>
              </button>
            </div>
            <div class="control">
              <button type="submit" class="button is-small is-info is-outlined" title="Filter users (WIP)" data-action="filter-users" disabled>
                <span class="icon">
                  <i class="icon-filter"></i>
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    `
    const extraControls = `
      <div class="columns">
        ${filter}
        <div class="column is-one-quarter">
          <form class="prevent-default">
            <div class="field has-addons">
              <div class="control is-expanded">
                <input id="jumpToPage" class="input is-small" type="number" min="1" max="${pages}" value="${params.pageNum + 1}"${pages === 1 ? ' disabled' : ''}>
              </div>
              <div class="control">
                <button type="submit" class="button is-small is-info is-outlined" title="Jump to page" data-action="jump-to-page">
                  <span class="icon">
                    <i class="icon-paper-plane"></i>
                  </span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    `

    const controls = `
      <div class="columns">
        <div class="column exclusive-operations has-text-left">
          <a class="button is-small is-primary is-outlined" title="Create new user" data-action="create-user">
            <span class="icon">
              <i class="icon-plus"></i>
            </span>
            <span>Create new user</span>
          </a>
        </div>
        <div class="column bulk-operations has-text-right">
          <a class="button is-small is-info is-outlined" title="Clear selection" data-action="clear-selection">
            <span class="icon">
              <i class="icon-cancel"></i>
            </span>
          </a>
          <a class="button is-small is-dangerish is-outlined" title="Bulk disable (WIP)" data-action="bulk-disable-users" disabled>
            <span class="icon">
              <i class="icon-hammer"></i>
            </span>
          </a>
          <a class="button is-small is-danger is-outlined" title="Bulk delete (WIP)" data-action="bulk-delete-users" disabled>
            <span class="icon">
              <i class="icon-trash"></i>
            </span>
            <span>Bulk delete</span>
          </a>
        </div>
      </div>
    `

    // Do some string replacements for bottom controls
    const bottomFiltersId = 'bFilters'
    const bottomJumpId = 'bJumpToPage'
    const bottomExtraControls = extraControls
      .replace(/id="filters"/, `id="${bottomFiltersId}"`)
      .replace(/(data-action="filter-uploads")/, `$1 data-filtersid="${bottomFiltersId}"`)
      .replace(/id="jumpToPage"/, `id="${bottomJumpId}"`)
      .replace(/(data-action="jump-to-page")/g, `$1 data-jumpid="${bottomJumpId}"`)
    const bottomPagination = pagination
      .replace(/(data-action="page-ellipsis")/g, `$1 data-jumpid="${bottomJumpId}"`)

    // Whether there are any unselected items
    let unselected = false

    page.dom.innerHTML = `
      ${pagination}
      ${extraControls}
      ${controls}
      <div class="table-container">
        <table class="table is-narrow is-fullwidth is-hoverable">
          <thead>
            <tr>
              <th><input id="selectAll" class="checkbox" type="checkbox" title="Select all" data-action="select-all"></th>
              <th title="Key: username">Username</th>
              <th>Uploads</th>
              <th>Usage</th>
              <th title="Key: permission">Group</th>
              <th title="Key: registration">Registration date</th>
              <th title="Key: timestamp">Last token update</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="table">
          </tbody>
        </table>
      </div>
      ${controls}
      ${bottomExtraControls}
      ${bottomPagination}
    `

    const table = document.querySelector('#table')

    for (let i = 0; i < users.length; i++) {
      const user = users[i]
      const selected = page.selected[page.currentView].includes(user.id)
      if (!selected) unselected = true

      let displayGroup = null
      const groups = Object.keys(user.groups)
      for (let i = 0; i < groups.length; i++) {
        if (!user.groups[groups[i]]) break
        displayGroup = groups[i]
      }

      // Server-side explicitly expects either of these two values to consider a user as disabled
      const enabled = user.enabled !== false && user.enabled !== 0
      page.cache[user.id] = {
        username: user.username,
        groups: user.groups,
        enabled,
        displayGroup
      }

      const prettyDate = user.registration
        ? page.getPrettyDate(new Date(user.registration * 1000))
        : '-'
      const prettyTokenUpdate = user.timestamp
        ? page.getPrettyDate(new Date(user.timestamp * 1000))
        : '-'

      const tr = document.createElement('tr')
      tr.dataset.id = user.id
      tr.innerHTML = `
        <td class="controls"><input type="checkbox" class="checkbox" title="Select" data-index="${i}" data-action="select"${selected ? ' checked' : ''}></td>
        <th${enabled ? '' : ' class="has-text-grey"'}>${user.username}</td>
        <th>${user.uploads}</th>
        <td>${page.getPrettyBytes(user.usage)}</td>
        <td>${displayGroup}</td>
        <td>${prettyDate}</td>
        <td>${prettyTokenUpdate}</td>
        <td class="controls has-text-right">
          <a class="button is-small is-primary is-outlined" title="Edit user" data-action="edit-user">
            <span class="icon">
              <i class="icon-pencil"></i>
            </span>
          </a>
          <a class="button is-small is-info is-outlined" title="${user.uploads ? 'View uploads' : 'User doesn\'t have uploads'}" data-action="view-user-uploads" ${user.uploads ? '' : 'disabled'}>
            <span class="icon">
              <i class="icon-docs"></i>
            </span>
          </a>
          <a class="button is-small is-dangerish is-outlined" title="${enabled ? 'Disable user' : 'User is disabled'}" data-action="disable-user" ${enabled ? '' : 'disabled'}>
            <span class="icon">
              <i class="icon-hammer"></i>
            </span>
          </a>
          <a class="button is-small is-danger is-outlined" title="Delete user" data-action="delete-user">
            <span class="icon">
              <i class="icon-trash"></i>
            </span>
          </a>
        </td>
      `

      table.appendChild(tr)
      page.checkboxes = table.querySelectorAll('.checkbox[data-action="select"]')
    }

    const selectAll = document.querySelector('#selectAll')
    if (selectAll && !unselected) {
      selectAll.checked = true
      selectAll.title = 'Unselect all'
    }

    page.fadeAndScroll()
    page.updateTrigger(params.trigger, 'active')

    page.views[page.currentView].pageNum = users.length ? params.pageNum : 0
  }).catch(error => {
    page.updateTrigger(params.trigger)
    page.onAxiosError(error)
  })
}

page.createUser = () => {
  const groupOptions = Object.keys(page.permissions).map((g, i, a) => {
    const disabled = !(a[i + 1] && page.permissions[a[i + 1]])
    return `<option value="${g}"${disabled ? ' disabled' : ''}>${g}</option>`
  }).join('\n')

  const div = document.createElement('div')
  div.innerHTML = `
    <div class="field">
      <label class="label">Username</label>
      <div class="controls">
        <input id="swalUsername" class="input" type="text">
      </div>
    </div>
    <div class="field">
      <label class="label">Password (optional)</label>
      <div class="controls">
        <input id="swalPassword" class="input" type="text">
      </div>
    </div>
    <div class="field">
      <label class="label">User group</label>
      <div class="control">
        <div class="select is-fullwidth">
          <select id="swalGroup">
            ${groupOptions}
          </select>
        </div>
      </div>
    </div>
  `

  swal({
    title: 'Create new user',
    icon: 'info',
    content: div,
    buttons: {
      cancel: true,
      confirm: {
        closeModal: false
      }
    }
  }).then(proceed => {
    if (!proceed) return

    axios.post('api/users/create', {
      username: document.querySelector('#swalUsername').value,
      password: document.querySelector('#swalPassword').value,
      group: document.querySelector('#swalGroup').value
    }).then(response => {
      if (!response) return

      if (response.data.success === false)
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }

      const div = document.createElement('div')
      div.innerHTML = `
        <p>Username: <b>${response.data.username}</b></p>
        <p>Password: <code>${response.data.password}</code></p>
        <p>User group: <b>${response.data.group}</b></p>
      `
      swal({
        title: 'Created a new user!',
        icon: 'success',
        content: div
      })

      // Load last page of users list
      // eslint-disable-next-line compat/compat
      page.getUsers(Object.assign(page.views.users, {
        pageNum: -1
      }))
    }).catch(page.onAxiosError)
  })
}

page.editUser = id => {
  const user = page.cache[id]
  if (!user) return

  const groupOptions = Object.keys(page.permissions).map((g, i, a) => {
    const selected = g === user.displayGroup
    const disabled = !(a[i + 1] && page.permissions[a[i + 1]])
    return `<option value="${g}"${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}>${g}</option>`
  }).join('\n')

  const div = document.createElement('div')
  div.innerHTML = `
    <div class="field">
      <p>User ID: ${id}</p>
    </div>
    <div class="field">
      <label class="label">Username</label>
      <div class="controls">
        <input id="swalUsername" class="input" type="text" value="${user.username || ''}">
      </div>
    </div>
    <div class="field">
      <label class="label">User group</label>
      <div class="control">
        <div class="select is-fullwidth">
          <select id="swalGroup">
            ${groupOptions}
          </select>
        </div>
      </div>
    </div>
    <div class="field">
      <div class="control">
        <label class="checkbox">
          <input id="swalEnabled" type="checkbox" ${user.enabled ? 'checked' : ''}>
          Enabled
        </label>
      </div>
    </div>
    <div class="field">
      <div class="control">
        <label class="checkbox">
          <input id="swalResetPassword" type="checkbox">
          Reset password
        </label>
      </div>
    </div>
  `

  swal({
    title: 'Edit user',
    icon: 'info',
    content: div,
    buttons: {
      cancel: true,
      confirm: {
        closeModal: false
      }
    }
  }).then(proceed => {
    if (!proceed) return

    axios.post('api/users/edit', {
      id,
      username: document.querySelector('#swalUsername').value,
      group: document.querySelector('#swalGroup').value,
      enabled: document.querySelector('#swalEnabled').checked,
      resetPassword: document.querySelector('#swalResetPassword').checked
    }).then(response => {
      if (!response) return

      if (response.data.success === false)
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }

      let autoClose = true
      const div = document.createElement('div')

      let displayName = user.username
      if (response.data.update.username !== user.username) {
        div.innerHTML += `<p>${user.username} was renamed into: <b>${response.data.update.username}</b>.</p>`
        autoClose = false
        displayName = response.data.update.username
      }

      if (response.data.update.password) {
        div.innerHTML += `
          <p>${displayName}'s new password is:</p>
          <p><code>${response.data.update.password}</code></p>
        `
        autoClose = false
      }

      if (response.data.update.enabled !== user.enabled)
        div.innerHTML += `<p>${displayName} has been ${response.data.update.enabled ? 'enabled' : 'disabled'}!</p>`

      if (!div.innerHTML)
        div.innerHTML = `<p>${displayName} was edited!</p>`

      swal({
        title: 'Success!',
        icon: 'success',
        content: div,
        buttons: !autoClose,
        timer: autoClose ? 1500 : null
      })
      page.getUsers(page.views.users)
    }).catch(page.onAxiosError)
  })
}

page.disableUser = id => {
  const user = page.cache[id]
  if (!user || !user.enabled) return

  const content = document.createElement('div')
  content.innerHTML = `
    <p>You will be disabling a user named <b>${page.cache[id].username}</b>.</p>
    <p>Their files will remain.</p>
  `

  swal({
    title: 'Are you sure?',
    icon: 'warning',
    content,
    dangerMode: true,
    buttons: {
      cancel: true,
      confirm: {
        text: 'Yes, disable them!',
        closeModal: false
      }
    }
  }).then(proceed => {
    if (!proceed) return

    axios.post('api/users/disable', { id }).then(response => {
      if (!response) return

      if (response.data.success === false)
        if (response.data.description === 'No token provided')
          return page.verifyToken(page.token)
        else
          return swal('An error occurred!', response.data.description, 'error')

      swal('Success!', `${page.cache[id].username} has been disabled.`, 'success', {
        buttons: false,
        timer: 1500
      })
      page.getUsers(page.views.users)
    }).catch(page.onAxiosError)
  })
}

page.deleteUser = id => {
  const user = page.cache[id]
  if (!user) return

  const content = document.createElement('div')
  content.innerHTML = `
    <p>You will be deleting a user named <b>${page.cache[id].username}</b>.<p>
    <p>Their files will remain, unless you choose otherwise.</p>
  `

  swal({
    title: 'Are you sure?',
    icon: 'warning',
    content,
    dangerMode: true,
    buttons: {
      cancel: true,
      confirm: {
        text: 'Yes, delete it!',
        closeModal: false
      },
      purge: {
        text: 'Yes, and the uploads too!',
        value: 'purge',
        className: 'swal-button--danger',
        closeModal: false
      }
    }
  }).then(proceed => {
    if (!proceed) return

    axios.post('api/users/delete', {
      id,
      purge: proceed === 'purge'
    }).then(response => {
      if (!response) return

      if (response.data.success === false) {
        const failed = Array.isArray(response.data.failed)
          ? response.data.failed
          : []

        if (response.data.description === 'No token provided')
          return page.verifyToken(page.token)
        else if (failed.length)
          return swal('An error occurred!', `Unable to delete ${failed.length} of the user's upload${failed.length === 1 ? '' : 's'}.`, 'error')
        else
          return swal('An error occurred!', response.data.description, 'error')
      }

      swal('Success!', `${page.cache[id].username} has been deleted.`, 'success', {
        buttons: false,
        timer: 1500
      })

      // Reload users list
      // eslint-disable-next-line compat/compat
      page.getUsers(Object.assign(page.views.users, {
        autoPage: true
      }))
    }).catch(page.onAxiosError)
  })
}

// Roughly based on https://github.com/mayuska/pagination/blob/master/index.js
page.paginate = (totalItems, itemsPerPage, currentPage) => {
  currentPage = currentPage + 1
  const step = 3
  const numPages = Math.ceil(totalItems / itemsPerPage)

  let template = ''
  const elementsToShow = step * 2
  const add = {
    pageNum (start, end) {
      for (let i = start; i <= end; ++i)
        template += `<li><a class="button pagination-link ${i === currentPage ? ' is-current' : ''}" aria-label="Goto page ${i}" data-action="page-goto" data-goto="${i - 1}">${i}</a></li>`
    },
    startDots () {
      template += `
        <li><a class="button pagination-link" aria-label="Goto page 1" data-action="page-goto" data-goto="0">1</a></li>
        <li data-action="page-ellipsis"><span class="pagination-ellipsis">&hellip;</span></li>
      `
    },
    endDots () {
      template += `
        <li data-action="page-ellipsis"><span class="pagination-ellipsis">&hellip;</span></li>
        <li><a class="button pagination-link" aria-label="Goto page ${numPages}" data-action="page-goto" data-goto="${numPages - 1}">${numPages}</a></li>
      `
    }
  }

  if (elementsToShow + 1 >= numPages) {
    add.pageNum(1, numPages)
  } else if (currentPage < elementsToShow) {
    add.pageNum(1, elementsToShow)
    add.endDots()
  } else if (currentPage > numPages - elementsToShow + 1) {
    add.startDots()
    add.pageNum(numPages - elementsToShow + 1, numPages)
  } else {
    add.startDots()
    add.pageNum(currentPage - step + 1, currentPage + step - 1)
    add.endDots()
  }

  return `
    <nav class="pagination is-centered is-small">
      <a class="button pagination-previous" data-action="page-prev"${currentPage === 1 ? ' disabled' : ''}>Previous</a>
      <a class="button pagination-next" data-action="page-next"${currentPage >= numPages ? ' disabled' : ''}>Next page</a>
      <ul class="pagination-list">${template}</ul>
    </nav>
  `
}

page.getStatistics = (params = {}) => {
  if (!page.permissions.admin)
    return swal('An error occurred!', 'You cannot do this!', 'error')

  if (page.isSomethingLoading)
    return page.warnSomethingLoading()

  page.updateTrigger(params.trigger, 'loading')

  const url = 'api/stats'
  axios.get(url).then(response => {
    if (response.data.success === false)
      if (response.data.description === 'No token provided') {
        return page.verifyToken(page.token)
      } else {
        page.updateTrigger(params.trigger)
        return swal('An error occurred!', response.data.description, 'error')
      }

    let content = ''
    const keys = Object.keys(response.data.stats)
    for (let i = 0; i < keys.length; i++) {
      let rows = ''
      if (!response.data.stats[keys[i]])
        rows += `
          <tr>
            <td>Generating, please try again later\u2026</td>
            <td></td>
          </tr>
        `
      else
        try {
          const types = response.data.stats[keys[i]]._types || {}
          const valKeys = Object.keys(response.data.stats[keys[i]])
          for (let j = 0; j < valKeys.length; j++) {
            // Skip keys that starts with an underscore
            if (/^_/.test(valKeys[j]))
              continue

            const value = response.data.stats[keys[i]][valKeys[j]]
            let parsed = value

            // Parse values with some preset formatting
            if ((types.number || []).includes(valKeys[j]))
              parsed = value.toLocaleString()
            if ((types.byte || []).includes(valKeys[j]))
              parsed = page.getPrettyBytes(value)
            if ((types.byteUsage || []).includes(valKeys[j]))
              parsed = `${page.getPrettyBytes(value.used)} / ${page.getPrettyBytes(value.total)} (${Math.round(value.used / value.total * 100)}%)`

            const string = valKeys[j]
              .replace(/([A-Z])/g, ' $1')
              .replace(/(^|\s)(cpu|db|zip)/gi, s => s.toUpperCase())
            rows += `
              <tr>
                <th class="capitalize">${string}</th>
                <td>${parsed}</td>
              </tr>
            `
          }
        } catch (error) {
          rows = `
              <tr>
                <td>Error parsing response. Try again?</td>
                <td></td>
              </tr>
            `
          page.onError(error)
        }

      content += `
        <div class="table-container">
          <table id="statistics" class="table is-narrow is-fullwidth is-hoverable">
            <thead>
              <tr>
                <th class="capitalize">${keys[i]}</th>
                <td></td>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      `
    }

    page.dom.innerHTML = content
    page.fadeAndScroll()
    page.updateTrigger(params.trigger, 'active')
  }).catch(error => {
    page.updateTrigger(params.trigger)
    page.onAxiosError(error)
  })
}

window.onload = () => {
  // Polyfill Object.assign()
  // eslint-disable-next-line compat/compat
  if (typeof Object.assign !== 'function')
    // Must be writable: true, enumerable: false, configurable: true
    Object.defineProperty(Object, 'assign', {
      value: function assign (target, varArgs) { // .length of function is 2
        'use strict'
        if (target === null || target === undefined)
          throw new TypeError('Cannot convert undefined or null to object')
        const to = Object(target)
        for (let i = 1; i < arguments.length; i++) {
          const nextSource = arguments[i]
          if (nextSource !== null && nextSource !== undefined)
            for (const nextKey in nextSource)
              // Avoid bugs when hasOwnProperty is shadowed
              if (Object.prototype.hasOwnProperty.call(nextSource, nextKey))
                to[nextKey] = nextSource[nextKey]
        }
        return to
      },
      writable: true,
      configurable: true
    })

  // Add 'no-touch' class to non-touch devices
  if (!('ontouchstart' in document.documentElement))
    document.documentElement.classList.add('no-touch')

  const selectedKeys = ['uploads', 'uploadsAll', 'albums', 'albumsAll', 'users']
  for (let i = 0; i < selectedKeys.length; i++) {
    const ls = localStorage[lsKeys.selected[selectedKeys[i]]]
    if (ls) page.selected[selectedKeys[i]] = JSON.parse(ls)
  }

  page.preparePage()

  page.clipboardJS = new ClipboardJS('.clipboard-js')

  page.clipboardJS.on('success', () => {
    return swal('', 'The link has been copied to clipboard.', 'success', {
      buttons: false,
      timer: 1500
    })
  })

  page.clipboardJS.on('error', page.onError)

  page.lazyLoad = new LazyLoad()
}
