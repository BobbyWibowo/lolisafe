/* global swal, axios, Dropzone, ClipboardJS, LazyLoad */

const lsKeys = {
  token: 'token',
  chunkSize: 'chunkSize',
  parallelUploads: 'parallelUploads',
  uploadsHistoryOrder: 'uploadsHistoryOrder',
  previewImages: 'previewImages',
  fileLength: 'fileLength',
  uploadAge: 'uploadAge',
  stripTags: 'stripTags'
}

const page = {
  // user token
  token: localStorage[lsKeys.token],

  // configs from api/check
  apiChecked: false,
  private: null,
  enableUserAccounts: null,
  maxSize: null,
  chunkSizeConfig: null,
  temporaryUploadAges: null,
  defaultTemporaryUploadAge: null,
  fileIdentifierLength: null,
  stripTagsConfig: null,

  // store album id that will be used with upload requests
  album: null,

  parallelUploads: null,
  previewImages: null,
  fileLength: null,
  uploadAge: null,
  stripTags: null,

  maxSizeBytes: null,
  urlMaxSize: null,
  urlMaxSizeBytes: null,
  chunkSize: null,

  tabs: [],
  activeTab: null,
  albumSelect: null,
  albumSelectOnChange: null,
  previewTemplate: null,

  dropzone: null,
  clipboardJS: null,
  lazyLoad: null,

  // additional vars for url uploads
  urlsQueue: [],
  activeUrlsQueue: 0,

  // Include BMP for uploads preview only, because the real images will be used instead of server-generated thumbnails
  // Sharp is not capable of generating thumbnails for BMP images
  imageExts: ['.gif', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp', '.bmp'],
  videoExts: ['.avi', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4', '.webm', '.wmv'],

  albumTitleMaxLength: 70,
  albumDescMaxLength: 4000,

  // Better Cloudflare errors
  cloudflareErrors: {
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
}

// Handler for errors during initialization
page.onInitError = error => {
  // Hide these elements
  document.querySelector('#albumDiv').classList.add('is-hidden')
  document.querySelector('#tabs').classList.add('is-hidden')
  document.querySelectorAll('.tab-content').forEach(element => {
    return element.classList.add('is-hidden')
  })

  // Update upload button
  const uploadButton = document.querySelector('#loginToUpload')
  uploadButton.innerText = 'An error occurred. Try to reload?'
  uploadButton.classList.remove('is-loading')
  uploadButton.classList.remove('is-hidden')

  uploadButton.addEventListener('click', () => {
    window.location.reload()
  })

  if (!error) return
  if (error.response) page.onAxiosError(error)
  else page.onError(error)
}

// Handler for regular JS errors
page.onError = error => {
  console.error(error)

  const content = document.createElement('div')
  content.innerHTML = `
    <p><code>${error.toString()}</code></p>
    <p>Please check your console for more information.</p>
  `
  return swal({
    title: 'An error occurred!',
    icon: 'error',
    content
  })
}

// Handler for Axios errors
page.onAxiosError = error => {
  if (!error.response) {
    return page.onError(error)
  }

  const statusText = page.cloudflareErrors[error.response.status] || error.response.statusText
  const description = error.response.data && error.response.data.description
    ? error.response.data.description
    : 'There was an error with the request.\nPlease check the console for more information.'

  return swal(`${error.response.status} ${statusText}`, description, 'error')
}

page.formatAxiosError = error => {
  const statusText = page.cloudflareErrors[error.response.status] || error.response.statusText

  if (error.response.data && error.response.data.description) {
    return error.response
  } else {
    const description = error.response
      ? `${error.response.status} ${statusText}`
      : error.toString()
    return { data: { success: false, description } }
  }
}

page.checkClientVersion = apiVersion => {
  const self = document.querySelector('#mainScript')
  const match = self.src.match(/\?_=(\d+)$/)
  if (match && match[1] && match[1] !== apiVersion) {
    return swal({
      title: 'Update detected!',
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
}

page.checkIfPublic = () => {
  return axios.get('api/check', {
    onDownloadProgress: () => {
      // Only do render and/or newsfeed after this request has been initiated to avoid blocking
      /* global render */
      if (typeof render !== 'undefined' && !render.done) render.do()
      /* global newsfeed */
      if (typeof newsfeed !== 'undefined' && !newsfeed.done) newsfeed.do()
      if (!page.apiChecked) page.apiChecked = true
    }
  }).then(response => {
    if (response.data.version) {
      page.checkClientVersion(response.data.version)
    }

    page.private = response.data.private
    page.enableUserAccounts = response.data.enableUserAccounts

    page.maxSize = parseInt(response.data.maxSize)
    page.maxSizeBytes = page.maxSize * 1e6
    document.querySelector('#maxSize > span').innerHTML = page.getPrettyBytes(page.maxSizeBytes)

    page.chunkSizeConfig = {
      max: (response.data.chunkSize && parseInt(response.data.chunkSize.max)) || 95,
      default: response.data.chunkSize && parseInt(response.data.chunkSize.default)
    }

    page.temporaryUploadAges = response.data.temporaryUploadAges
    page.defaultTemporaryUploadAge = response.data.defaultTemporaryUploadAge || null
    page.fileIdentifierLength = response.data.fileIdentifierLength
    page.stripTagsConfig = response.data.stripTags

    return page.preparePage()
  }).catch(page.onInitError)
}

page.preparePage = () => {
  if (page.token) {
    return page.verifyToken(page.token)
  } else if (page.private) {
    const button = document.querySelector('#loginToUpload')
    button.href = 'auth'
    button.classList.remove('is-loading')
    if (page.enableUserAccounts) {
      button.innerText = 'Anonymous upload is disabled.\nLog in or register to upload.'
    } else {
      button.innerText = 'Running in private mode.\nLog in to upload.'
    }
  } else {
    return page.prepareUpload()
  }
}

page.verifyToken = token => {
  return axios.post('api/tokens/verify', { token }).then(response => {
    axios.defaults.headers.common.token = token
    localStorage[lsKeys.token] = token
    page.token = token

    // If user has its own retention periods array, override defaults
    if (Array.isArray(response.data.retentionPeriods)) {
      page.temporaryUploadAges = response.data.retentionPeriods
      page.defaultTemporaryUploadAge = response.data.defaultRetentionPeriod
    }

    return page.prepareUpload()
  }).catch(error => {
    return page.onAxiosError(error).then(() => {
      if (error.response.data && error.response.data.code === 10001) {
        localStorage.removeItem(lsKeys.token)
        window.location.reload()
      } else {
        page.onInitError()
      }
    })
  })
}

page.prepareUpload = () => {
  // I think this fits best here because we need to check for a valid token before we can get the albums
  if (page.token) {
    // Change /auth link to /dashboard
    const authLink = document.querySelector('#linksColumn a[href="auth"]')
    if (authLink) authLink.setAttribute('href', 'dashboard')

    // Display the album selection
    document.querySelector('#albumDiv').classList.remove('is-hidden')

    page.albumSelect = document.querySelector('#albumSelect')
    page.albumSelectOnChange = () => {
      page.album = parseInt(page.albumSelect.value)
      // Re-generate ShareX config file
      if (typeof page.prepareShareX === 'function') page.prepareShareX()
    }
    page.albumSelect.addEventListener('change', page.albumSelectOnChange)

    // Fetch albums
    page.fetchAlbums()
  } else if (page.enableUserAccounts) {
    document.querySelector('#loginLinkText').innerHTML = 'Create an account and keep track of your uploads'
  }

  // Prepare & generate config tab
  page.prepareUploadConfig()

  // Hide login button
  document.querySelector('#loginToUpload').classList.add('is-hidden')

  // Prepare & generate files upload tab
  page.prepareDropzone()

  // Generate ShareX config file
  if (typeof page.prepareShareX === 'function') page.prepareShareX()

  // Prepare urls upload tab
  const urlMaxSize = document.querySelector('#urlMaxSize')
  if (urlMaxSize) {
    page.urlMaxSize = parseInt(urlMaxSize.innerHTML)
    page.urlMaxSizeBytes = page.urlMaxSize * 1e6
    urlMaxSize.innerHTML = page.getPrettyBytes(page.urlMaxSizeBytes)
  }

  const uploadUrls = document.querySelector('#uploadUrls')
  if (uploadUrls) {
    uploadUrls.addEventListener('click', event => {
      page.addUrlsToQueue()
    })
  }

  // Get all tabs
  const tabsContainer = document.querySelector('#tabs')
  const tabs = tabsContainer.querySelectorAll('li')
  for (let i = 0; i < tabs.length; i++) {
    const id = tabs[i].dataset.id
    const tabContent = document.querySelector(`#${id}`)
    if (!tabContent) continue

    tabs[i].addEventListener('click', () => {
      page.setActiveTab(i)
    })
    page.tabs.push({ tab: tabs[i], content: tabContent })
  }

  // Set first valid tab as the default active tab
  if (page.tabs.length) {
    page.setActiveTab(0)
    tabsContainer.classList.remove('is-hidden')
  }
}

page.setActiveTab = index => {
  for (let i = 0; i < page.tabs.length; i++) {
    if (i === index) {
      page.tabs[i].tab.classList.add('is-active')
      page.tabs[i].content.classList.remove('is-hidden')
      page.activeTab = index
    } else {
      page.tabs[i].tab.classList.remove('is-active')
      page.tabs[i].content.classList.add('is-hidden')
    }
  }
}

page.fetchAlbums = () => {
  return axios.get('api/albums', { headers: { simple: '1' } }).then(response => {
    if (response.data.success === false) {
      return swal('An error occurred!', response.data.description, 'error')
    }

    // Create an option for each album
    if (Array.isArray(response.data.albums) && response.data.albums.length) {
      for (let i = 0; i < response.data.albums.length; i++) {
        const album = response.data.albums[i]
        const option = document.createElement('option')
        option.value = album.id
        option.innerHTML = album.name
        page.albumSelect.appendChild(option)
      }
    }
  }).catch(page.onInitError)
}

page.prepareDropzone = () => {
  // Parse template element
  const previewNode = document.querySelector('#tpl')
  page.previewTemplate = previewNode.innerHTML
  previewNode.parentNode.removeChild(previewNode)

  // Generate files upload tab
  const tabDiv = document.querySelector('#tab-files')
  const div = document.createElement('div')
  div.className = 'control is-expanded'
  div.innerHTML = `
    <div id="dropzone" class="button is-danger is-outlined is-fullwidth is-unselectable">
      <span class="icon">
        <i class="icon-upload-cloud"></i>
      </span>
      <span>Click here or drag & drop files</span>
    </div>
  `
  tabDiv.querySelector('.dz-container').appendChild(div)

  const previewsContainer = tabDiv.querySelector('#tab-files .field.uploads')

  page.dropzone = new Dropzone(document.body, {
    url: 'api/upload',
    paramName: 'files[]',
    clickable: tabDiv.querySelector('#dropzone'),
    maxFilesize: page.maxSizeBytes / 1024 / 1024, // this option expects MiB
    parallelUploads: page.parallelUploads,
    uploadMultiple: false,
    previewsContainer,
    previewTemplate: page.previewTemplate,
    createImageThumbnails: false,
    autoProcessQueue: true,
    headers: { token: page.token },
    chunking: Boolean(page.chunkSize),
    chunkSize: page.chunkSize * 1e6, // this option expects Bytes
    // chibisafe cannot handle parallel chunked uploads
    // due to technical reasons involving how we optimize I/O performance
    parallelChunkUploads: false,
    timeout: 0,

    init () {
      this.on('addedfile', file => {
        // Set active tab to file uploads, if necessary
        if (page.activeTab !== 0) page.setActiveTab(0)

        // Add file entry
        tabDiv.querySelector('.uploads').classList.remove('is-hidden')

        file.previewElement.querySelector('.name').innerHTML = file.name
        file.previewElement.querySelector('.descriptive-progress').innerHTML = 'Waiting in queue\u2026'
      })

      this.on('sending', (file, xhr) => {
        // Add timeout listener (hacky method due to lack of built-in timeout handler)
        if (!xhr.ontimeout) {
          xhr.ontimeout = () => {
            const instances = page.dropzone.getUploadingFiles()
              .filter(instance => instance.xhr === xhr)
            page.dropzone._handleUploadError(instances, xhr, 'Connection timed out. Try to reduce upload chunk size.')
          }
        }

        // Attach necessary data for initial upload speed calculation
        if (typeof xhr._uplSpeedCalc === 'undefined') {
          xhr._uplSpeedCalc = {
            lastSent: 0,
            data: [{ timestamp: Date.now(), bytes: 0 }]
          }
        }

        // If not chunked uploads, add extra headers
        if (!file.upload.chunked) {
          if (page.album !== null) xhr.setRequestHeader('albumid', page.album)
          if (page.fileLength !== null) xhr.setRequestHeader('filelength', page.fileLength)
          if (page.uploadAge !== null) xhr.setRequestHeader('age', page.uploadAge)
          if (page.stripTags !== null) xhr.setRequestHeader('striptags', page.stripTags)
        }

        if (!file.upload.chunked) {
          file.previewElement.querySelector('.descriptive-progress').innerHTML = 'Uploading\u2026'
        } else if (file.upload.chunks.length === 1) {
          file.previewElement.querySelector('.descriptive-progress').innerHTML = `Uploading chunk 1/${file.upload.totalChunkCount}\u2026`
        }
      })

      // Update descriptive progress
      this.on('uploadprogress', (file, progress) => {
        // Total bytes will eventually be bigger than file size when chunked
        const total = Math.max(file.size, file.upload.total)
        const percentage = (file.upload.bytesSent / total * 100).toFixed(0)

        const upl = file.upload.chunked
          ? file.upload.chunks[file.upload.chunks.length - 1]
          : file.upload
        const xhr = upl.xhr || file.xhr

        let prefix = 'Uploading\u2026'
        let skipProgress = false
        if (file.upload.chunked) {
          const done = upl.bytesSent === upl.total
          const last = file.upload.chunks.length === file.upload.totalChunkCount
          let chunkIndex = file.upload.chunks.length
          if (done && !last) {
            chunkIndex++
            skipProgress = true
          }
          prefix = `Uploading chunk ${chunkIndex}/${file.upload.totalChunkCount}\u2026`
        }

        // Real-time upload speed calculation
        let prettyBytesPerSec
        if (!skipProgress) {
          const now = Date.now()
          const bytesSent = upl.bytesSent - xhr._uplSpeedCalc.lastSent

          // Push data of current iteration
          xhr._uplSpeedCalc.lastSent = upl.bytesSent
          xhr._uplSpeedCalc.data.push({ timestamp: now, bytes: bytesSent })

          // Wait till at least the 2nd iteration (3 data including initial data)
          const length = xhr._uplSpeedCalc.data.length
          if (length > 2) {
            // Calculate using data from all iterations
            let elapsed = 0
            let bytesPerSec = 0
            let fullSec = false
            let i = length - 1 // Always start with 2nd from last item
            while (i--) {
              // Splice data of unrequired iterations
              if (fullSec) {
                xhr._uplSpeedCalc.data.splice(i, 1)
                continue
              }
              // Sum data
              elapsed = now - xhr._uplSpeedCalc.data[i].timestamp
              if (elapsed > 1000) {
                const excessDuration = elapsed - 1000
                const newerIterationElapsed = now - xhr._uplSpeedCalc.data[i + 1].timestamp
                const duration = elapsed - newerIterationElapsed
                const fragment = (duration - excessDuration) / duration * xhr._uplSpeedCalc.data[i + 1].bytes
                bytesPerSec += fragment
                fullSec = true
              } else {
                bytesPerSec += xhr._uplSpeedCalc.data[i + 1].bytes
              }
            }

            // If not enough data
            if (!fullSec) bytesPerSec = 1000 / elapsed * bytesPerSec

            // Get pretty bytes
            prettyBytesPerSec = page.getPrettyBytes(bytesPerSec)
          }
        }

        file.previewElement.querySelector('.descriptive-progress').innerHTML =
          `${prefix} ${percentage}%${prettyBytesPerSec ? ` at ${prettyBytesPerSec}/s` : ''}`
      })

      this.on('success', (file, data) => {
        if (!data) return
        file.previewElement.querySelector('.descriptive-progress').classList.add('is-hidden')

        if (data.success === false) {
          file.previewElement.querySelector('.error').innerHTML = data.description
          file.previewElement.querySelector('.error').classList.remove('is-hidden')
        }

        if (Array.isArray(data.files) && data.files[0]) {
          page.updateTemplate(file, data.files[0])
        }
      })

      this.on('error', (file, error, xhr) => {
        let err = error
        if (typeof error === 'object' && error.description) {
          err = error.description
        } else if (xhr) {
          const formatted = page.formatAxiosError({
            response: {
              status: xhr.status,
              statusText: xhr.statusText
            }
          })
          err = formatted.data.description
        } else if (error instanceof Error) {
          err = error.toString()
        }

        // Clean up file size errors
        if (/^File is too big/.test(err) || /File too large/.test(err)) {
          err = `File too large (${page.getPrettyBytes(file.size)}).`
        }

        file.previewElement.querySelector('.descriptive-progress').classList.add('is-hidden')

        file.previewElement.querySelector('.error').innerHTML = err
        file.previewElement.querySelector('.error').classList.remove('is-hidden')

        page.updateTemplateIcon(file.previewElement, 'icon-block')
      })
    },

    chunksUploaded (file, done) {
      file.previewElement.querySelector('.descriptive-progress').innerHTML =
        `Rebuilding ${file.upload.totalChunkCount} chunks\u2026`

      axios.post('api/upload/finishchunks', {
        // This API supports an array of multiple files
        files: [{
          uuid: file.upload.uuid,
          original: file.name,
          type: file.type,
          size: file.size,
          albumid: page.album,
          filelength: page.fileLength,
          age: page.uploadAge
        }]
      }, {
        headers: {
          // Unlike the options above (e.g. albumid, filelength, etc.),
          // strip tags cannot yet be configured per file with this API
          striptags: page.stripTags || ''
        }
      }).catch(error => page.formatAxiosError(error)).then(response => {
        file.previewElement.querySelector('.descriptive-progress').classList.add('is-hidden')

        if (response.data.success === false) {
          file.previewElement.querySelector('.error').innerHTML = response.data.description
          file.previewElement.querySelector('.error').classList.remove('is-hidden')

          page.updateTemplateIcon(file.previewElement, 'icon-block')
        }

        if (response.data.files && response.data.files[0]) {
          page.updateTemplate(file, response.data.files[0])
        }

        done()
      })
    }
  })
}

page.addUrlsToQueue = () => {
  const urls = document.querySelector('#urls').value
    .split(/\r?\n/)
    .filter(url => {
      return url.trim().length
    })

  if (!urls.length) {
    return swal('An error occurred!', 'You have not entered any URLs.', 'error')
  }

  const tabDiv = document.querySelector('#tab-urls')
  tabDiv.querySelector('.uploads').classList.remove('is-hidden')

  for (let i = 0; i < urls.length; i++) {
    const previewTemplate = document.createElement('template')
    previewTemplate.innerHTML = page.previewTemplate.trim()

    const previewElement = previewTemplate.content.firstChild
    previewElement.querySelector('.name').innerHTML = urls[i]
    previewElement.querySelector('.descriptive-progress').innerHTML = 'Waiting in queue\u2026'

    const previewsContainer = tabDiv.querySelector('.uploads')
    previewsContainer.appendChild(previewElement)

    page.urlsQueue.push({
      url: urls[i],
      previewElement
    })
  }

  page.processUrlsQueue()
  document.querySelector('#urls').value = ''
}

page.processUrlsQueue = () => {
  if (!page.urlsQueue.length) return

  function finishedUrlUpload (file, data) {
    file.previewElement.querySelector('.descriptive-progress').classList.add('is-hidden')

    if (data.success === false) {
      const match = data.description.match(/ over limit: (\d+)$/)
      if (match && match[1]) {
        data.description = `File exceeded limit of ${page.getPrettyBytes(match[1])}.`
      }

      file.previewElement.querySelector('.error').innerHTML = data.description
      file.previewElement.querySelector('.error').classList.remove('is-hidden')

      page.updateTemplateIcon(file.previewElement, 'icon-block')
    }

    if (Array.isArray(data.files) && data.files[0]) {
      page.updateTemplate(file, data.files[0])
    }

    page.activeUrlsQueue--
    return shiftQueue()
  }

  function initUrlUpload (file) {
    file.previewElement.querySelector('.descriptive-progress').innerHTML =
      'Waiting for server to fetch URL\u2026'

    return axios.post('api/upload', {
      urls: [file.url]
    }, {
      headers: {
        albumid: page.album || '',
        age: page.uploadAge || '',
        filelength: page.fileLength || ''
      }
    }).catch(error => page.formatAxiosError(error)).then(response => {
      return finishedUrlUpload(file, response.data)
    })
  }

  function shiftQueue () {
    while (page.urlsQueue.length && (page.activeUrlsQueue < page.parallelUploads)) {
      page.activeUrlsQueue++
      initUrlUpload(page.urlsQueue.shift())
    }
  }

  return shiftQueue()
}

page.updateTemplateIcon = (templateElement, iconClass) => {
  const iconElement = templateElement.querySelector('.icon')
  if (!iconElement) return

  iconElement.classList.add(iconClass)
  iconElement.classList.remove('is-hidden')
}

page.updateTemplate = (file, response) => {
  if (!response.url) return

  const link = file.previewElement.querySelector('.link')
  const a = link.querySelector('a')
  const clipboard = file.previewElement.querySelector('.clipboard-mobile > .clipboard-js')
  let url = response.url
  if (!/^https?:\/\//i.test(url)) {
    url = `${window.location.origin}/${url}`
  }
  a.href = a.innerHTML = clipboard.dataset.clipboardText = url

  link.classList.remove('is-hidden')
  clipboard.parentElement.classList.remove('is-hidden')

  const exec = /.[\w]+$/.exec(response.url)
  const extname = exec && exec[0]
    ? exec[0].toLowerCase()
    : null

  if (page.imageExts.includes(extname)) {
    if (page.previewImages) {
      const img = file.previewElement.querySelector('img')
      img.setAttribute('alt', response.name || '')
      img.dataset.src = response.url
      img.classList.remove('is-hidden')
      img.onerror = event => {
        // Hide image elements that fail to load
        // Consequently include WEBP in browsers that do not have WEBP support (e.g. IE)
        event.currentTarget.classList.add('is-hidden')
        page.updateTemplateIcon(file.previewElement, 'icon-picture')
      }
      page.lazyLoad.update(file.previewElement.querySelectorAll('img'))
    } else {
      page.updateTemplateIcon(file.previewElement, 'icon-picture')
    }
  } else if (page.videoExts.includes(extname)) {
    page.updateTemplateIcon(file.previewElement, 'icon-video')
  } else {
    page.updateTemplateIcon(file.previewElement, 'icon-doc-inv')
  }

  if (response.expirydate) {
    const expiryDate = file.previewElement.querySelector('.expiry-date')
    expiryDate.dataset.timestamp = response.expirydate
    expiryDate.innerHTML = `EXP: ${page.getPrettyDate(new Date(response.expirydate * 1000))}`
    expiryDate.classList.remove('is-hidden')
  }
}

page.createAlbum = () => {
  const div = document.createElement('div')
  div.innerHTML = `
    <div class="field">
      <div class="controls">
        <input id="swalName" class="input" type="text" placeholder="Name" maxlength="${page.albumTitleMaxLength}">
      </div>
      <p class="help">Max length is ${page.albumTitleMaxLength} characters.</p>
    </div>
    <div class="field">
      <div class="control">
        <textarea id="swalDescription" class="textarea" placeholder="Description" rows="2" maxlength="${page.albumDescMaxLength}"></textarea>
      </div>
      <p class="help">Max length is ${page.albumDescMaxLength} characters.</p>
    </div>
    <div class="field">
      <div class="control">
        <label class="checkbox">
          <input id="swalDownload" type="checkbox" checked>
          Enable download
        </label>
      </div>
    </div>
    <div class="field">
      <div class="control">
        <label class="checkbox">
          <input id="swalPublic" type="checkbox" checked>
          Enable public link
        </label>
      </div>
    </div>
  `

  swal({
    title: 'Create new album',
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

    const name = document.querySelector('#swalName').value.trim()
    axios.post('api/albums', {
      name,
      description: document.querySelector('#swalDescription').value.trim(),
      download: document.querySelector('#swalDownload').checked,
      public: document.querySelector('#swalPublic').checked
    }).then(response => {
      if (response.data.success === false) {
        return swal('An error occurred!', response.data.description, 'error')
      }

      const option = document.createElement('option')
      page.albumSelect.appendChild(option)
      option.value = response.data.id
      option.innerHTML = name
      option.selected = true
      page.albumSelectOnChange()

      swal('Woohoo!', 'Album was created successfully.', 'success')
    }).catch(page.onError)
  })
}

page.prepareUploadConfig = () => {
  // This object should only be used to set fallback values for page[key]
  // (essentially for page[key] properties that explicitly need to be set as something)
  // As for default values in the Config tab (which will not set page[key]),
  // check out number.default property of each config
  const fallback = {
    chunkSize: page.chunkSizeConfig.default,
    parallelUploads: 2
  }

  const temporaryUploadAges = Array.isArray(page.temporaryUploadAges) &&
    page.temporaryUploadAges.length
  const fileIdentifierLength = page.fileIdentifierLength &&
    typeof page.fileIdentifierLength.min === 'number' &&
    typeof page.fileIdentifierLength.max === 'number'

  const config = {
    siBytes: {
      label: 'File size display',
      select: [
        { value: 'default', text: '1000 B = 1 kB = 1 Kilobyte' },
        { value: '0', text: '1024 B = 1 KiB = 1 Kibibyte' }
      ],
      help: 'This will be used in our homepage, dashboard, and album public pages.',
      valueHandler () {} // Do nothing
    },
    ampmTime: {
      label: 'Show AM/PM on date',
      select: [
        { value: 'default', text: 'No' },
        { value: '1', text: 'Yes' }
      ],
      help: 'This will be used in our homepage and dashboard.',
      valueHandler () {} // Do nothing
    },
    fileLength: {
      display: fileIdentifierLength,
      label: 'File identifier length',
      number: fileIdentifierLength
        ? {
            min: page.fileIdentifierLength.min,
            max: page.fileIdentifierLength.max,
            default: page.fileIdentifierLength.default,
            round: true
          }
        : void 0,
      help: true, // true means auto-generated, for number-based configs only
      disabled: fileIdentifierLength && page.fileIdentifierLength.force
    },
    uploadAge: {
      display: temporaryUploadAges,
      label: 'Upload age',
      select: [],
      help: 'Whether to automatically delete your uploads after a certain amount of time.'
    },
    stripTags: {
      display: page.stripTagsConfig,
      label: 'Strip tags',
      select: page.stripTagsConfig
        ? [
            { value: page.stripTagsConfig.default ? 'default' : '1', text: 'Yes' },
            { value: page.stripTagsConfig.default ? '0' : 'default', text: 'No' }
          ]
        : null,
      help: `Whether to strip tags (e.g. EXIF) from your uploads.<br>
        This only applies to regular image${page.stripTagsConfig && page.stripTagsConfig.video ? ' and video' : ''} uploads (i.e. not URL uploads).`,
      disabled: page.stripTagsConfig && page.stripTagsConfig.force
    },
    chunkSize: {
      display: Boolean(page.chunkSizeConfig.default),
      label: 'Upload chunk size (MB)',
      number: {
        min: 1,
        max: page.chunkSizeConfig.max,
        default: fallback.chunkSize,
        suffix: ' MB',
        round: true
      },
      help: true
    },
    parallelUploads: {
      label: 'Parallel uploads',
      number: {
        min: 1,
        max: 10,
        default: fallback.parallelUploads,
        round: true
      },
      help: true
    },
    uploadsHistoryOrder: {
      label: 'Uploads history order',
      select: [
        { value: 'default', text: 'Older files on top' },
        { value: '0', text: 'Newer files on top' }
      ],
      help: `"Newer files on top" will use a CSS technique, which unfortunately come with <a href="https://developer.mozilla.org/en-US/docs/Web/CSS/flex-direction#Accessibility_concerns" target="_blank" rel="noopener">some undesirable side effects</a>.<br>
        This also affects text selection, such as when trying to select text from top to bottom will result in them being selected from bottom to top instead, and vice versa.`,
      valueHandler (value) {
        if (value === '0') {
          const uploadFields = document.querySelectorAll('.tab-content > .uploads')
          for (let i = 0; i < uploadFields.length; i++) {
            uploadFields[i].classList.add('is-reversed')
          }
        }
      }
    },
    previewImages: {
      label: 'Load images for preview',
      select: [
        { value: 'default', text: 'Yes' },
        { value: '0', text: 'No' }
      ],
      help: 'By default, uploaded images will be loaded as their previews.',
      valueHandler (value) {
        page.previewImages = value !== '0'
      }
    }
  }

  if (temporaryUploadAges) {
    const _default = page.defaultTemporaryUploadAge === null
      ? page.temporaryUploadAges[0]
      : page.defaultTemporaryUploadAge
    const stored = parseFloat(localStorage[lsKeys.uploadAge])
    for (let i = 0; i < page.temporaryUploadAges.length; i++) {
      const age = page.temporaryUploadAges[i]
      config.uploadAge.select.push({
        value: age === _default ? 'default' : String(age),
        text: page.getPrettyUploadAge(age)
      })
      if (age === stored) {
        config.uploadAge.value = stored
      }
    }
  }

  if (fileIdentifierLength) {
    const stored = parseInt(localStorage[lsKeys.fileLength])
    if (!page.fileIdentifierLength.force &&
      !isNaN(stored) &&
      stored >= page.fileIdentifierLength.min &&
      stored <= page.fileIdentifierLength.max) {
      config.fileLength.value = stored
    }
  }

  const tabContent = document.querySelector('#tab-config')
  const form = document.createElement('form')
  form.addEventListener('submit', event => event.preventDefault())

  const configKeys = Object.keys(config)
  for (let i = 0; i < configKeys.length; i++) {
    const key = configKeys[i]
    const conf = config[key]

    // Skip only if display attribute is explicitly set to false
    if (conf.display === false) continue

    const field = document.createElement('div')
    field.className = 'field'

    let value
    if (!conf.disabled) {
      if (typeof conf.value !== 'undefined') {
        value = conf.value
      } else if (typeof conf.number !== 'undefined') {
        const parsed = parseInt(localStorage[lsKeys[key]])
        if (!isNaN(parsed) && parsed <= conf.number.max && parsed >= conf.number.min) {
          value = parsed
        }
      } else {
        const stored = localStorage[lsKeys[key]]
        if (Array.isArray(conf.select)) {
          if (conf.select.find(sel => sel.value === stored)) {
            value = stored
          }
        } else {
          value = stored
        }
      }

      // If valueHandler function exists, defer to the function,
      // otherwise pass value to global page object
      if (typeof conf.valueHandler === 'function') {
        conf.valueHandler(value)
      } else if (typeof value !== 'undefined') {
        page[key] = value
      } else if (typeof fallback[key] !== 'undefined') {
        page[key] = fallback[key]
      }
    }

    let control
    if (Array.isArray(conf.select)) {
      control = document.createElement('div')
      control.className = 'select is-fullwidth'

      const opts = []
      for (let j = 0; j < conf.select.length; j++) {
        const opt = conf.select[j]
        const selected = (value && (opt.value === String(value))) ||
          (typeof value === 'undefined' && opt.value === 'default')
        opts.push(`
          <option value="${opt.value}"${selected ? ' selected' : ''}>
            ${opt.text}${opt.value === 'default' ? ' (default)' : ''}
          </option>
        `)
      }

      control.innerHTML = `
        <select id="${key}">
          ${opts.join('\n')}
        </select>
      `
    } else if (conf.number) {
      control = document.createElement('input')
      control.id = control.name = key
      control.className = 'input is-fullwidth'
      control.type = 'number'

      if (typeof conf.number.min !== 'undefined') control.min = conf.number.min
      if (typeof conf.number.max !== 'undefined') control.max = conf.number.max
      if (typeof value === 'number') control.value = value
      else if (typeof conf.number.default !== 'undefined') control.value = conf.number.default
    }

    let help
    if (conf.disabled) {
      if (Array.isArray(conf.select)) {
        control.querySelector('select').disabled = conf.disabled
      } else {
        control.disabled = conf.disabled
      }
      help = 'This option is currently not configurable.'
    } else if (typeof conf.help === 'string') {
      help = conf.help
    } else if (conf.help === true && typeof conf.number !== 'undefined') {
      const tmp = []

      if (typeof conf.number.default !== 'undefined') {
        tmp.push(`Default is ${conf.number.default}${conf.number.suffix || ''}.`)
      }
      if (typeof conf.number.min !== 'undefined') {
        tmp.push(`Min is ${conf.number.min}${conf.number.suffix || ''}.`)
      }
      if (typeof conf.number.max !== 'undefined') {
        tmp.push(`Max is ${conf.number.max}${conf.number.suffix || ''}.`)
      }

      help = tmp.join(' ')
    }

    field.innerHTML = `
      <label class="label">${conf.label}</label>
      <div class="control"></div>
      ${help ? `<p class="help">${help}</p>` : ''}
    `
    field.querySelector('div.control').appendChild(control)

    form.appendChild(field)
  }

  const submit = document.createElement('div')
  submit.className = 'field'
  submit.innerHTML = `
    <p class="control">
      <button id="saveConfig" type="submit" class="button is-danger is-outlined is-fullwidth">
        <span class="icon">
          <i class="icon-floppy"></i>
        </span>
        <span>Save & reload</span>
      </button>
    </p>
    <p class="help">
      This configuration will only be used in this browser.<br>
      After reloading the page, some of them will also be applied to the ShareX config that you can download by clicking on the ShareX icon below.
    </p>
  `

  form.appendChild(submit)
  form.querySelector('#saveConfig').addEventListener('click', () => {
    if (!form.checkValidity()) return

    const keys = Object.keys(config)
      .filter(key => config[key].display !== false && config[key].disabled !== true)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]

      let value
      if (typeof config[key].select !== 'undefined') {
        if (form.elements[key].value !== 'default') {
          value = form.elements[key].value
        }
      } else if (typeof config[key].number !== 'undefined') {
        const parsed = parseInt(form.elements[key].value)
        if (!isNaN(parsed) && parsed !== config[key].number.default) {
          value = Math.min(Math.max(parsed, config[key].number.min), config[key].number.max)
        }
      }

      if (typeof value !== 'undefined') localStorage[lsKeys[key]] = value
      else localStorage.removeItem(lsKeys[key])
    }

    swal({
      title: 'Woohoo!',
      text: 'Configuration saved into this browser.',
      icon: 'success'
    }).then(() => {
      window.location.reload()
    })
  })

  tabContent.appendChild(form)
}

page.getPrettyUploadAge = hours => {
  if (hours === 0) {
    return 'Permanent'
  } else if (hours < 1) {
    const minutes = hours * 60
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  } else if (hours >= 24) {
    const days = hours / 24
    return `${days} day${days === 1 ? '' : 's'}`
  } else {
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
}

// Handle image paste event
window.addEventListener('paste', event => {
  const items = (event.clipboardData || event.originalEvent.clipboardData).items
  const index = Object.keys(items)
  for (let i = 0; i < index.length; i++) {
    const item = items[index[i]]
    if (item.kind === 'file') {
      const blob = item.getAsFile()
      /* eslint-disable-next-line compat/compat */
      const file = new File([blob], `pasted-image.${blob.type.match(/(?:[^/]*\/)([^;]*)/)[1]}`, {
        type: blob.type
      })
      page.dropzone.addFile(file)
    }
  }
})

window.addEventListener('DOMContentLoaded', () => {
  if (window.cookieconsent) {
    window.cookieconsent.initialise({
      cookie: {
        name: 'cookieconsent_status',
        path: window.location.pathname,
        expiryDays: 730,
        secure: window.location.protocol === 'https:'
      },
      palette: {
        popup: {
          background: '#282828',
          text: '#eff0f1'
        },
        button: {
          background: '#209cee',
          text: '#ffffff'
        }
      },
      theme: 'classic',
      position: 'bottom-left',
      content: {
        message: 'We use cookies to offer you a better browsing experience and to analyze our traffic. You consent to our cookies if you continue to use this website.',
        dismiss: 'Got it!',
        link: 'Details in our Cookie Policy',
        href: 'cookiepolicy'
      }
    })
  }

  page.checkIfPublic()

  page.clipboardJS = new ClipboardJS('.clipboard-js')

  page.clipboardJS.on('success', () => {
    return swal('', 'The link has been copied to clipboard.', 'success', {
      buttons: false,
      timer: 1500
    })
  })

  page.clipboardJS.on('error', page.onError)

  page.lazyLoad = new LazyLoad({
    elements_selector: '.field.uploads img'
  })

  document.querySelector('#createAlbum').addEventListener('click', () => {
    page.createAlbum()
  })
})
