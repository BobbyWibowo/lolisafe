/* global swal, axios, ClipboardJS, LazyLoad */

var page = {
  // #page
  dom: null,

  // user token
  token: localStorage.token,
  username: null, // from api/tokens/verify

  // view config (either list or thumbs)
  filesView: localStorage.filesView,

  // current view (which album and which page)
  currentView: { album: null, pageNum: null },

  // id of selected files (shared across pages and will be synced with localStorage)
  selectedFiles: [],
  checkboxes: [],
  lastSelected: null,

  // select album dom for dialogs/modals
  selectAlbumContainer: null,

  // cache of files and albums data for dialogs/modals
  files: {},
  albums: {},

  clipboardJS: null,
  lazyLoad: null
}

page.preparePage = function () {
  if (!page.token) {
    window.location = 'auth'
    return
  }
  page.verifyToken(page.token, true)
}

page.verifyToken = function (token, reloadOnError) {
  axios.post('api/tokens/verify', { token: token })
    .then(function (response) {
      if (response.data.success === false) {
        return swal({
          title: 'An error occurred!',
          text: response.data.description,
          icon: 'error'
        })
          .then(function () {
            if (!reloadOnError) { return }
            localStorage.removeItem('token')
            location.location = 'auth'
          })
      }

      axios.defaults.headers.common.token = token
      localStorage.token = token
      page.token = token
      page.username = response.data.username
      page.prepareDashboard()
    })
    .catch(function (error) {
      console.log(error)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.prepareDashboard = function () {
  page.dom = document.getElementById('page')
  page.dom.addEventListener('click', page.domClick, true)

  document.getElementById('auth').style.display = 'none'
  document.getElementById('dashboard').style.display = 'block'

  document.getElementById('itemUploads').addEventListener('click', function () {
    page.setActiveMenu(this)
    page.getUploads()
  })

  document.getElementById('itemDeleteByNames').addEventListener('click', function () {
    page.setActiveMenu(this)
    page.deleteByNames()
  })

  document.getElementById('itemManageGallery').addEventListener('click', function () {
    page.setActiveMenu(this)
    page.getAlbums()
  })

  document.getElementById('itemFileLength').addEventListener('click', function () {
    page.setActiveMenu(this)
    page.changeFileLength()
  })

  document.getElementById('itemTokens').addEventListener('click', function () {
    page.setActiveMenu(this)
    page.changeToken()
  })

  document.getElementById('itemPassword').addEventListener('click', function () {
    page.setActiveMenu(this)
    page.changePassword()
  })

  var logoutBtn = document.getElementById('itemLogout')
  logoutBtn.addEventListener('click', function () {
    page.logout()
  })
  logoutBtn.innerHTML = 'Logout ( ' + page.username + ' )'

  page.getAlbumsSidebar()
}

page.logout = function () {
  localStorage.removeItem('token')
  location.reload('.')
}

page.getItemID = function (element) {
  // This expects the item's parent to have the item's ID
  var parent = element.parentNode
  // If the element is part of a set of controls, use the container's parent instead
  if (element.parentNode.classList.contains('controls')) { parent = parent.parentNode }
  return parseInt(parent.dataset.id)
}

page.domClick = function (event) {
  var element = event.target
  if (!element) { return }

  // If the clicked element is an icon, delegate event to its A parent; hacky
  if (element.tagName === 'I' && element.parentNode.tagName === 'SPAN') { element = element.parentNode }
  if (element.tagName === 'SPAN' && element.parentNode.tagName === 'A') { element = element.parentNode }

  // Skip elements that have no action data
  if (!element.dataset || !element.dataset.action) { return }

  event.stopPropagation() // maybe necessary
  var id = page.getItemID(element)
  var action = element.dataset.action

  switch (action) {
  case 'page-prev':
    if (page.currentView.pageNum === 0) {
      return swal('Can\'t do that!', 'This is already the first page!', 'warning')
    }
    return page.getUploads(page.currentView.album, page.currentView.pageNum - 1, element)
  case 'page-next':
    return page.getUploads(page.currentView.album, page.currentView.pageNum + 1, element)
  case 'view-list':
    return page.setFilesView('list', element)
  case 'view-thumbs':
    return page.setFilesView('thumbs', element)
  case 'clear-selection':
    return page.clearSelection()
  case 'add-selected-files-to-album':
    return page.addSelectedFilesToAlbum()
  case 'bulk-delete':
    return page.deleteSelectedFiles()
  case 'select-file':
    return page.selectFile(element, event)
  case 'add-to-album':
    return page.addSingleFileToAlbum(id)
  case 'delete-file':
    return page.deleteFile(id)
  case 'select-all-files':
    return page.selectAllFiles(element)
  case 'display-thumbnail':
    return page.displayThumbnail(id)
  case 'delete-file-by-names':
    return page.deleteFileByNames()
  case 'submit-album':
    return page.submitAlbum(element)
  case 'edit-album':
    return page.editAlbum(id)
  case 'delete-album':
    return page.deleteAlbum(id)
  case 'get-new-token':
    return page.getNewToken(element)
  }
}

page.isLoading = function (element, state) {
  if (!element) { return }
  if (state) { return element.classList.add('is-loading') }
  element.classList.remove('is-loading')
}

page.getUploads = function (album, pageNum, element) {
  if (element) { page.isLoading(element, true) }
  if (pageNum === undefined) { pageNum = 0 }

  var url = 'api/uploads/' + pageNum
  if (album !== undefined) { url = 'api/album/' + album + '/' + pageNum }

  axios.get(url)
    .then(function (response) {
      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      if (pageNum && (response.data.files.length === 0)) {
        // Only remove loading class here, since beyond this the entire page will be replaced anyways
        if (element) { page.isLoading(element, false) }
        return swal('Can\'t do that!', 'There are no more files!', 'warning')
      }

      page.files = {}

      var pagination =
        '<nav class="pagination is-centered">\n' +
        '  <a class="button pagination-previous" data-action="page-prev">Previous</a>\n' +
        '  <a class="button pagination-next" data-action="page-next">Next page</a>\n' +
        '</nav>'

      var controls =
        '<div class="columns">\n' +
        '  <div class="column is-hidden-mobile"></div>\n' +
        '  <div class="column" style="text-align: center">\n' +
        '    <a class="button is-small is-danger" title="List view" data-action="view-list">\n' +
        '      <span class="icon">\n' +
        '        <i class="icon-th-list"></i>\n' +
        '      </span>\n' +
        '    </a>\n' +
        '    <a class="button is-small is-danger" title="Thumbs view" data-action="view-thumbs">\n' +
        '      <span class="icon">\n' +
        '        <i class="icon-th-large"></i>\n' +
        '      </span>\n' +
        '    </a>\n' +
        '  </div>\n' +
        '  <div class="column" style="text-align: right">\n' +
        '    <a class="button is-small is-info" title="Clear selection" data-action="clear-selection">\n' +
        '      <span class="icon">\n' +
        '        <i class="icon-cancel"></i>\n' +
        '      </span>\n' +
        '    </a>\n' +
        '    <a class="button is-small is-warning" title="Add selected files to album" data-action="add-selected-files-to-album">\n' +
        '      <span class="icon">\n' +
        '        <i class="icon-plus"></i>\n' +
        '      </span>\n' +
        '    </a>\n' +
        '    <a class="button is-small is-danger" title="Bulk delete" data-action="bulk-delete">\n' +
        '      <span class="icon">\n' +
        '        <i class="icon-trash"></i>\n' +
        '      </span>\n' +
        '      <span>Bulk delete</span>\n' +
        '    </a>\n' +
        '  </div>\n' +
        '</div>'

      var allFilesSelected = true
      var table, i, file, selected, displayAlbumOrUser

      if (page.filesView === 'thumbs') {
        page.dom.innerHTML =
          pagination + '\n' +
          '<hr>\n' +
          controls + '\n' +
          '<div id="table" class="columns is-multiline is-mobile is-centered">\n' +
          '</div>\n' +
          pagination

        table = document.getElementById('table')

        for (i = 0; i < response.data.files.length; i++) {
          file = response.data.files[i]
          selected = page.selectedFiles.includes(file.id)
          if (!selected && allFilesSelected) { allFilesSelected = false }

          displayAlbumOrUser = file.album
          if (page.username === 'root') {
            displayAlbumOrUser = ''
            if (file.username !== undefined) { displayAlbumOrUser = file.username }
          }

          var div = document.createElement('div')
          div.className = 'image-container column is-narrow'
          div.dataset.id = file.id
          if (file.thumb !== undefined) {
            div.innerHTML = '<a class="image" href="' + file.file + '" target="_blank" rel="noopener"><img alt="' + file.name + '" data-src="' + file.thumb + '"/></a>'
          } else {
            div.innerHTML = '<a class="image" href="' + file.file + '" target="_blank" rel="noopener"><h1 class="title">' + (file.extname || 'N/A') + '</h1></a>'
          }

          div.innerHTML +=
            '<input type="checkbox" class="file-checkbox" title="Select this file" data-action="select-file"' + (selected ? ' checked' : '') + '>\n' +
            '<div class="controls">\n' +
            '  <a class="button is-small is-info clipboard-js" title="Copy link to clipboard" data-clipboard-text="' + file.file + '">\n' +
            '    <span class="icon">\n' +
            '      <i class="icon-clipboard-1"></i>\n' +
            '    </span>\n' +
            '  </a>\n' +
            '  <a class="button is-small is-warning" title="Add to album" data-action="add-to-album">\n' +
            '    <span class="icon">\n' +
            '      <i class="icon-plus"></i>\n' +
            '    </span>\n' +
            '  </a>\n' +
            '  <a class="button is-small is-danger" title="Delete file" data-action="delete-file">\n' +
            '    <span class="icon">\n' +
            '      <i class="icon-trash"></i>\n' +
            '    </span>\n' +
            '  </a>\n' +
            '</div>\n' +
            '<div class="details">\n' +
            '  <p><span class="name" title="' + file.file + '">' + file.name + '</span></p>\n' +
            '  <p>' + (displayAlbumOrUser ? ('<span>' + displayAlbumOrUser + '</span> – ') : '') + file.size + '</p>\n' +
            '</div>'

          table.appendChild(div)
          page.checkboxes = Array.from(table.getElementsByClassName('file-checkbox'))
          page.lazyLoad.update()
        }
      } else {
        var albumOrUser = 'Album'
        if (page.username === 'root') { albumOrUser = 'User' }

        page.dom.innerHTML =
          pagination + '\n' +
          '<hr>\n' +
          controls + '\n' +
          '<div class="table-container">\n' +
          '  <table class="table is-narrow is-fullwidth is-hoverable">\n' +
          '    <thead>\n' +
          '      <tr>\n' +
          '          <th><input id="selectAll" type="checkbox" title="Select all files" data-action="select-all-files"></th>\n' +
          '          <th style="width: 25%">File</th>\n' +
          '          <th>' + albumOrUser + '</th>\n' +
          '          <th>Size</th>\n' +
          '          <th>Date</th>\n' +
          '          <th></th>\n' +
          '      </tr>\n' +
          '    </thead>\n' +
          '    <tbody id="table">\n' +
          '    </tbody>\n' +
          '  </table>\n' +
          '</div>\n' +
          '<hr>\n' +
          pagination

        table = document.getElementById('table')

        for (i = 0; i < response.data.files.length; i++) {
          file = response.data.files[i]
          selected = page.selectedFiles.includes(file.id)
          if (!selected && allFilesSelected) { allFilesSelected = false }

          page.files[file.id] = {
            name: file.name,
            thumb: file.thumb
          }

          displayAlbumOrUser = file.album
          if (page.username === 'root') {
            displayAlbumOrUser = ''
            if (file.username !== undefined) { displayAlbumOrUser = file.username }
          }

          var tr = document.createElement('tr')
          tr.dataset.id = file.id
          tr.innerHTML =
            '<th class="controls"><input type="checkbox" class="file-checkbox" title="Select this file" data-action="select-file"' + (selected ? ' checked' : '') + '></th>\n' +
            '<th><a href="' + file.file + '" target="_blank" rel="noopener" title="' + file.file + '">' + file.name + '</a></th>\n' +
            '<th>' + displayAlbumOrUser + '</th>\n' +
            '<td>' + file.size + '</td>\n' +
            '<td>' + file.date + '</td>\n' +
            '<td class="controls" style="text-align: right" >\n' +
            '  <a class="button is-small is-primary" title="View thumbnail" data-action="display-thumbnail"' + (file.thumb ? '' : ' disabled') + '>\n' +
            '    <span class="icon">\n' +
            '      <i class="icon-picture-1"></i>\n' +
            '    </span>\n' +
            '  </a>\n' +
            '  <a class="button is-small is-info clipboard-js" title="Copy link to clipboard" data-clipboard-text="' + file.file + '">\n' +
            '    <span class="icon">\n' +
            '      <i class="icon-clipboard-1"></i>\n' +
            '    </span>\n' +
            '  </a>\n' +
            '  <a class="button is-small is-warning" title="Add to album" data-action="add-to-album">\n' +
            '    <span class="icon">\n' +
            '      <i class="icon-plus"></i>\n' +
            '    </span>\n' +
            '  </a>\n' +
            '  <a class="button is-small is-danger" title="Delete file" data-action="delete-file">\n' +
            '    <span class="icon">\n' +
            '      <i class="icon-trash"></i>\n' +
            '    </span>\n' +
            '  </a>\n' +
            '</td>'

          table.appendChild(tr)
          page.checkboxes = Array.from(table.getElementsByClassName('file-checkbox'))
        }
      }

      if (allFilesSelected && response.data.files.length) {
        var selectAll = document.getElementById('selectAll')
        if (selectAll) { selectAll.checked = true }
      }

      page.currentView.album = album
      page.currentView.pageNum = response.data.files.length ? pageNum : 0
    })
    .catch(function (error) {
      console.log(error)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.setFilesView = function (view, element) {
  localStorage.filesView = view
  page.filesView = view
  page.getUploads(page.currentView.album, page.currentView.pageNum, element)
}

page.displayThumbnail = function (id) {
  var file = page.files[id]
  if (!file.thumb) { return }
  return swal({
    text: file.name,
    content: {
      element: 'img',
      attributes: { src: file.thumb }
    },
    button: true
  })
}

page.selectAllFiles = function (element) {
  var table = document.getElementById('table')
  var checkboxes = table.getElementsByClassName('file-checkbox')

  for (var i = 0; i < checkboxes.length; i++) {
    var id = page.getItemID(checkboxes[i])
    if (isNaN(id)) { continue }
    if (checkboxes[i].checked !== element.checked) {
      checkboxes[i].checked = element.checked
      if (checkboxes[i].checked) {
        page.selectedFiles.push(id)
      } else {
        page.selectedFiles.splice(page.selectedFiles.indexOf(id), 1)
      }
    }
  }

  if (page.selectedFiles.length) {
    localStorage.selectedFiles = JSON.stringify(page.selectedFiles)
  } else {
    localStorage.removeItem('selectedFiles')
  }

  element.title = element.checked ? 'Unselect all files' : 'Select all files'
}

page.selectInBetween = function (element, lastElement) {
  if (!element || !lastElement) { return }
  if (element === lastElement) { return }
  if (!page.checkboxes || !page.checkboxes.length) { return }

  var thisIndex = page.checkboxes.indexOf(element)
  var lastIndex = page.checkboxes.indexOf(lastElement)

  var distance = thisIndex - lastIndex
  if (distance >= -1 && distance <= 1) { return }

  for (var i = 0; i < page.checkboxes.length; i++) {
    if ((thisIndex > lastIndex && i > lastIndex && i < thisIndex) ||
      (thisIndex < lastIndex && i > thisIndex && i < lastIndex)) {
      page.checkboxes[i].checked = true
      page.selectedFiles.push(page.getItemID(page.checkboxes[i]))
    }
  }

  localStorage.selectedFiles = JSON.stringify(page.selectedFiles)
}

page.selectFile = function (element, event) {
  if (event.shiftKey && page.lastSelected) {
    page.selectInBetween(element, page.lastSelected)
  } else {
    page.lastSelected = element
  }

  var id = page.getItemID(element)
  if (isNaN(id)) { return }

  if (!page.selectedFiles.includes(id) && element.checked) {
    page.selectedFiles.push(id)
  } else if (page.selectedFiles.includes(id) && !element.checked) {
    page.selectedFiles.splice(page.selectedFiles.indexOf(id), 1)
  }

  if (page.selectedFiles.length) {
    localStorage.selectedFiles = JSON.stringify(page.selectedFiles)
  } else {
    localStorage.removeItem('selectedFiles')
  }
}

page.clearSelection = function () {
  var count = page.selectedFiles.length
  if (!count) {
    return swal('An error occurred!', 'You have not selected any files.', 'error')
  }

  var suffix = 'file' + (count === 1 ? '' : 's')
  return swal({
    title: 'Are you sure?',
    text: 'You are going to unselect ' + count + ' ' + suffix + '.',
    buttons: true
  })
    .then(function (proceed) {
      if (!proceed) { return }

      var table = document.getElementById('table')
      var checkboxes = table.getElementsByClassName('file-checkbox')

      for (var i = 0; i < checkboxes.length; i++) {
        if (checkboxes[i].checked) {
          checkboxes[i].checked = false
        }
      }

      page.selectedFiles = []
      localStorage.removeItem('selectedFiles')

      var selectAll = document.getElementById('selectAll')
      if (selectAll) { selectAll.checked = false }

      return swal('Cleared selection!', 'Unselected ' + count + ' ' + suffix + '.', 'success')
    })
}

page.deleteFile = function (id) {
  // TODO: Share function with bulk delete, just like 'add selected files to album' and 'add single file to album'
  swal({
    title: 'Are you sure?',
    text: 'You won\'t be able to recover the file!',
    icon: 'warning',
    dangerMode: true,
    buttons: {
      cancel: true,
      confirm: {
        text: 'Yes, delete it!',
        closeModal: false
      }
    }
  })
    .then(function (proceed) {
      if (!proceed) { return }

      axios.post('api/upload/delete', { id: id })
        .then(function (response) {
          if (!response) { return }

          if (response.data.success === false) {
            if (response.data.description === 'No token provided') {
              return page.verifyToken(page.token)
            } else {
              return swal('An error occurred!', response.data.description, 'error')
            }
          }

          swal('Deleted!', 'The file has been deleted.', 'success')
          page.getUploads(page.currentView.album, page.currentView.pageNum)
        })
        .catch(function (error) {
          console.log(error)
          return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
        })
    })
}

page.deleteSelectedFiles = function () {
  var count = page.selectedFiles.length
  if (!count) {
    return swal('An error occurred!', 'You have not selected any files.', 'error')
  }

  var suffix = 'file' + (count === 1 ? '' : 's')
  swal({
    title: 'Are you sure?',
    text: 'You won\'t be able to recover ' + count + ' ' + suffix + '!',
    icon: 'warning',
    dangerMode: true,
    buttons: {
      cancel: true,
      confirm: {
        text: 'Yes, nuke the ' + suffix + '!',
        closeModal: false
      }
    }
  })
    .then(function (proceed) {
      if (!proceed) { return }

      axios.post('api/upload/bulkdelete', {
        field: 'id',
        values: page.selectedFiles
      })
        .then(function (bulkdelete) {
          if (!bulkdelete) { return }

          if (bulkdelete.data.success === false) {
            if (bulkdelete.data.description === 'No token provided') {
              return page.verifyToken(page.token)
            } else {
              return swal('An error occurred!', bulkdelete.data.description, 'error')
            }
          }

          var deleted = count
          if (bulkdelete.data.failed && bulkdelete.data.failed.length) {
            deleted -= bulkdelete.data.failed.length
            page.selectedFiles = page.selectedFiles.filter(function (id) {
              return bulkdelete.data.failed.includes(id)
            })
          } else {
            page.selectedFiles = []
          }

          localStorage.selectedFiles = JSON.stringify(page.selectedFiles)

          swal('Deleted!', deleted + ' file' + (deleted === 1 ? ' has' : 's have') + ' been deleted.', 'success')
          return page.getUploads(page.currentView.album, page.currentView.pageNum)
        })
        .catch(function (error) {
          console.log(error)
          swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
        })
    })
}

page.deleteByNames = function () {
  page.dom.innerHTML =
    '<h2 class="subtitle">Delete by names</h2>\n' +
    '<div class="field">\n' +
    '  <label class="label">File names:</label>\n' +
    '  <div class="control">\n' +
    '    <textarea id="names" class="textarea"></textarea>\n' +
    '  </div>\n' +
    '  <p class="help">Separate each entry with a new line.</p>\n' +
    '</div>\n' +
    '<div class="field">\n' +
    '  <div class="control">\n' +
    '    <a class="button is-danger is-fullwidth" data-action="delete-file-by-names">\n' +
    '      <span class="icon">\n' +
    '        <i class="icon-trash"></i>\n' +
    '      </span>\n' +
    '      <span>Bulk delete</span>\n' +
    '    </a>\n' +
    '  </div>\n' +
    '</div>'
}

page.deleteFileByNames = function () {
  var names = document.getElementById('names').value
    .split(/\r?\n/)
    .filter(function (n) {
      return n.trim().length
    })
  var count = names.length
  if (!count) {
    return swal('An error occurred!', 'You have not entered any file names.', 'error')
  }

  var suffix = 'file' + (count === 1 ? '' : 's')
  swal({
    title: 'Are you sure?',
    text: 'You won\'t be able to recover ' + count + ' ' + suffix + '!',
    icon: 'warning',
    dangerMode: true,
    buttons: {
      cancel: true,
      confirm: {
        text: 'Yes, nuke the ' + suffix + '!',
        closeModal: false
      }
    }
  })
    .then(function (proceed) {
      if (!proceed) { return }

      axios.post('api/upload/bulkdelete', {
        field: 'name',
        values: names
      })
        .then(function (bulkdelete) {
          if (!bulkdelete) { return }

          if (bulkdelete.data.success === false) {
            if (bulkdelete.data.description === 'No token provided') {
              return page.verifyToken(page.token)
            } else {
              return swal('An error occurred!', bulkdelete.data.description, 'error')
            }
          }

          var deleted = count
          if (bulkdelete.data.failed && bulkdelete.data.failed.length) {
            deleted -= bulkdelete.data.failed.length
          }

          document.getElementById('names').value = bulkdelete.data.failed.join('\n')
          swal('Deleted!', deleted + ' file' + (deleted === 1 ? ' has' : 's have') + ' been deleted.', 'success')
        })
        .catch(function (error) {
          console.log(error)
          swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
        })
    })
}

page.addSelectedFilesToAlbum = function () {
  var count = page.selectedFiles.length
  if (!count) {
    return swal('An error occurred!', 'You have not selected any files.', 'error')
  }

  page.addFilesToAlbum(page.selectedFiles, function (failed) {
    if (!failed) { return }
    if (failed.length) {
      page.selectedFiles = page.selectedFiles.filter(function (id) {
        return failed.includes(id)
      })
    } else {
      page.selectedFiles = []
    }
    localStorage.selectedFiles = JSON.stringify(page.selectedFiles)
    page.getUploads(page.currentView.album, page.currentView.pageNum)
  })
}

page.addSingleFileToAlbum = function (id) {
  page.addFilesToAlbum([id], function (failed) {
    if (!failed) { return }
    page.getUploads(page.currentView.album, page.currentView.pageNum)
  })
}

page.addFilesToAlbum = function (ids, callback) {
  var count = ids.length
  return swal({
    title: 'Are you sure?',
    text: 'You are about to move ' + count + ' file' + (count === 1 ? '' : 's') + ' to an album.',
    buttons: {
      cancel: true,
      confirm: {
        text: 'Yes',
        closeModal: false
      }
    }
  })
    .then(function (proceed) {
      if (!proceed) { return }

      axios.get('api/albums')
        .then(function (list) {
          if (!list) { return }

          if (list.data.success === false) {
            if (list.data.description === 'No token provided') {
              page.verifyToken(page.token)
            } else {
              swal('An error occurred!', list.data.description, 'error')
            }
            return
          }

          if (!page.selectAlbumContainer) {
            // We want to this to be re-usable
            page.selectAlbumContainer = document.createElement('div')
            page.selectAlbumContainer.id = 'selectAlbum'
          }

          var options = list.data.albums
            .map(function (album) {
              return '<option value="' + album.id + '">' + album.name + '</option>'
            })
            .join('\n')

          page.selectAlbumContainer.innerHTML =
            '<div class="field">\n' +
            '  <label class="label">If a file is already in an album, it will be moved.</label>\n' +
            '  <div class="control">\n' +
            '    <div class="select is-fullwidth">\n' +
            '      <select>\n' +
            '        <option value="-1">Remove from album</option>\n' +
            '        <option value="" selected disabled>Choose an album</option>\n' +
            '        ' + options + '\n' +
            '      </select>\n' +
            '    </div>\n' +
            '</div>'

          return swal({
            content: page.selectAlbumContainer,
            buttons: {
              cancel: true,
              confirm: {
                text: 'OK',
                closeModal: false
              }
            }
          })
            .then(function (choose) {
              if (!choose) { return }

              var albumid = parseInt(page.selectAlbumContainer.getElementsByTagName('select')[0].value)
              if (isNaN(albumid)) {
                return swal('An error occurred!', 'You did not choose an album.', 'error')
              }

              axios.post('api/albums/addfiles', {
                ids: ids,
                albumid: albumid
              })
                .then(function (add) {
                  if (!add) { return }

                  if (add.data.success === false) {
                    if (add.data.description === 'No token provided') {
                      page.verifyToken(page.token)
                    } else {
                      swal('An error occurred!', add.data.description, 'error')
                    }
                    return
                  }

                  var added = ids.length
                  if (add.data.failed && add.data.failed.length) {
                    added -= add.data.failed.length
                  }

                  var suffix = 'file' + (ids.length === 1 ? '' : 's')
                  if (!added) {
                    return swal('An error occurred!', 'Could not add the ' + suffix + ' to the album.', 'error')
                  }

                  swal('Woohoo!', 'Successfully ' + (albumid < 0 ? 'removed' : 'added') + ' ' + added + ' ' + suffix + ' ' + (albumid < 0 ? 'from' : 'to') + ' the album.', 'success')
                  return callback(add.data.failed)
                })
                .catch(function (error) {
                  console.log(error)
                  return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
                })
            })
        })
        .catch(function (error) {
          console.log(error)
          return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
        })
    })
}

page.getAlbums = function () {
  axios.get('api/albums')
    .then(function (response) {
      if (!response) { return }

      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      page.albums = {}

      page.dom.innerHTML =
        '<h2 class="subtitle">Create new album</h2>\n' +
        '<div class="field">\n' +
        '  <div class="control">\n' +
        '    <input id="albumName" class="input" type="text" placeholder="Name">\n' +
        '  </div>\n' +
        '</div>\n' +
        '<div class="field">\n' +
        '  <div class="control">\n' +
        '    <a id="submitAlbum" class="button is-breeze is-fullwidth" data-action="submit-album">\n' +
        '      <span class="icon">\n' +
        '        <i class="icon-paper-plane-empty"></i>\n' +
        '      </span>\n' +
        '      <span>Create</span>\n' +
        '    </a>\n' +
        '  </div>\n' +
        '</div>\n' +
        '<hr>\n' +
        '<h2 class="subtitle">List of albums</h2>\n' +
        '<div class="table-container">\n' +
        '  <table class="table is-fullwidth is-hoverable">\n' +
        '    <thead>\n' +
        '      <tr>\n' +
        '          <th>ID</th>\n' +
        '          <th>Name</th>\n' +
        '          <th>Files</th>\n' +
        '          <th>Created at</th>\n' +
        '          <th>Public link</th>\n' +
        '          <th></th>\n' +
        '      </tr>\n' +
        '    </thead>\n' +
        '    <tbody id="table">\n' +
        '    </tbody>\n' +
        '  </table>\n' +
        '</div>'

      var homeDomain = response.data.homeDomain
      var table = document.getElementById('table')

      for (var i = 0; i < response.data.albums.length; i++) {
        var album = response.data.albums[i]
        var albumUrl = homeDomain + '/a/' + album.identifier

        page.albums[album.id] = {
          name: album.name,
          download: album.download,
          public: album.public
        }

        var tr = document.createElement('tr')
        tr.innerHTML =
          '<tr>\n' +
          '  <th>' + album.id + '</th>\n' +
          '  <th>' + album.name + '</th>\n' +
          '  <th>' + album.files + '</th>\n' +
          '  <td>' + album.date + '</td>\n' +
          '  <td><a' + (album.public ? (' href="' + albumUrl + '"') : '') + ' target="_blank" rel="noopener">' + albumUrl + '</a></td>\n' +
          '  <td style="text-align: right" data-id="' + album.id + '">\n' +
          '    <a class="button is-small is-primary" title="Edit album" data-action="edit-album">\n' +
          '      <span class="icon is-small">\n' +
          '        <i class="icon-pencil-1"></i>\n' +
          '      </span>\n' +
          '    </a>\n' +
          '    <a class="button is-small is-info clipboard-js" title="Copy link to clipboard" ' + (album.public ? ('data-clipboard-text="' + albumUrl + '"') : 'disabled') + '>\n' +
          '      <span class="icon is-small">\n' +
          '        <i class="icon-clipboard-1"></i>\n' +
          '      </span>\n' +
          '    </a>\n' +
          '    <a class="button is-small is-warning" title="Download album" ' + (album.download ? ('href="api/album/zip/' + album.identifier + '?v=' + album.editedAt + '"') : 'disabled') + '>\n' +
          '      <span class="icon is-small">\n' +
          '        <i class="icon-download"></i>\n' +
          '      </span>\n' +
          '    </a>\n' +
          '    <a class="button is-small is-danger" title="Delete album" data-action="delete-album">\n' +
          '      <span class="icon is-small">\n' +
          '        <i class="icon-trash"></i>\n' +
          '      </span>\n' +
          '    </a>\n' +
          '  </td>\n' +
          '</tr>'

        table.appendChild(tr)
      }
    })
    .catch(function (error) {
      console.log(error)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.editAlbum = function (id) {
  var album = page.albums[id]
  if (!album) { return }

  var div = document.createElement('div')
  div.innerHTML =
    '<div class="field">\n' +
    '  <label class="label">Album name</label>\n' +
    '  <div class="controls">\n' +
    '    <input id="_name" class="input" type="text" value="' + (album.name || '') + '">\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div class="field">\n' +
    '  <div class="control">\n' +
    '    <label class="checkbox">\n' +
    '      <input id="_download" type="checkbox" ' + (album.download ? 'checked' : '') + '>\n' +
    '      Enable download\n' +
    '    </label>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div class="field">\n' +
    '  <div class="control">\n' +
    '    <label class="checkbox">\n' +
    '      <input id="_public" type="checkbox" ' + (album.public ? 'checked' : '') + '>\n' +
    '      Enable public link\n' +
    '    </label>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div class="field">\n' +
    '  <div class="control">\n' +
    '    <label class="checkbox">\n' +
    '      <input id="_requestLink" type="checkbox">\n' +
    '      Request new public link\n' +
    '    </label>\n' +
    '  </div>\n' +
    '</div>'

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
  })
    .then(function (value) {
      if (!value) { return }

      axios.post('api/albums/edit', {
        id: id,
        name: document.getElementById('_name').value,
        download: document.getElementById('_download').checked,
        public: document.getElementById('_public').checked,
        requestLink: document.getElementById('_requestLink').checked
      })
        .then(function (response) {
          if (!response) { return }

          if (response.data.success === false) {
            if (response.data.description === 'No token provided') {
              return page.verifyToken(page.token)
            } else {
              return swal('An error occurred!', response.data.description, 'error')
            }
          }

          if (response.data.identifier) {
            swal('Success!', 'Your album\'s new identifier is: ' + response.data.identifier + '.', 'success')
          } else if (response.data.name !== album.name) {
            swal('Success!', 'Your album was renamed to: ' + response.data.name + '.', 'success')
          } else {
            swal('Success!', 'Your album was edited!', 'success')
          }

          page.getAlbumsSidebar()
          page.getAlbums()
        })
        .catch(function (error) {
          console.log(error)
          return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
        })
    })
}

page.deleteAlbum = function (id) {
  swal({
    title: 'Are you sure?',
    text: 'This won\'t delete your files, only the album!',
    icon: 'warning',
    dangerMode: true,
    buttons: {
      cancel: true,
      confirm: {
        text: 'Yes, delete it!',
        closeModal: false
      },
      purge: {
        text: 'Umm, delete the files too please?',
        value: 'purge',
        className: 'swal-button--danger',
        closeModal: false
      }
    }
  })
    .then(function (proceed) {
      if (!proceed) { return }
      console.log(proceed, proceed === 'purge')

      axios.post('api/albums/delete', {
        id: id,
        purge: proceed === 'purge'
      })
        .then(function (response) {
          if (response.data.success === false) {
            if (response.data.description === 'No token provided') {
              return page.verifyToken(page.token)
            } else {
              return swal('An error occurred!', response.data.description, 'error')
            }
          }

          swal('Deleted!', 'Your album has been deleted.', 'success')
          page.getAlbumsSidebar()
          page.getAlbums()
        })
        .catch(function (error) {
          console.log(error)
          return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
        })
    })
}

page.submitAlbum = function (element) {
  page.isLoading(element, true)

  axios.post('api/albums', {
    name: document.getElementById('albumName').value
  })
    .then(function (response) {
      if (!response) { return }

      page.isLoading(element, false)

      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      swal('Woohoo!', 'Album was created successfully', 'success')
      page.getAlbumsSidebar()
      page.getAlbums()
    })
    .catch(function (error) {
      console.log(error)
      page.isLoading(element, false)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.getAlbumsSidebar = function () {
  axios.get('api/albums/sidebar')
    .then(function (response) {
      if (!response) { return }

      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      var albumsContainer = document.getElementById('albumsContainer')
      albumsContainer.innerHTML = ''

      if (response.data.albums === undefined) { return }

      for (var i = 0; i < response.data.albums.length; i++) {
        var album = response.data.albums[i]
        var li = document.createElement('li')
        var a = document.createElement('a')
        a.id = album.id
        a.innerHTML = album.name

        a.addEventListener('click', function () {
          page.getAlbum(this)
        })

        li.appendChild(a)
        albumsContainer.appendChild(li)
      }
    })
    .catch(function (error) {
      console.log(error)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.getAlbum = function (album) {
  page.setActiveMenu(album)
  page.getUploads(album.id)
}

page.changeFileLength = function () {
  axios.get('api/filelength/config')
    .then(function (response) {
      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      page.dom.innerHTML =
        '<h2 class="subtitle">File name length</h2>\n' +
        '<div class="field">\n' +
        '  <div class="field">\n' +
        '    <label class="label">Your current file name length:</label>\n' +
        '    <div class="control">\n' +
        '      <input id="fileLength" class="input" type="text" placeholder="Your file length" value="' + (response.data.fileLength ? Math.min(Math.max(response.data.fileLength, response.data.config.min), response.data.config.max) : response.data.config.default) + '">\n' +
        '    </div>\n' +
        '    <p class="help">Default file name length is <b>' + response.data.config.default + '</b> characters. ' + (response.data.config.userChangeable ? ('Range allowed for user is <b>' + response.data.config.min + '</b> to <b>' + response.data.config.max + '</b> characters.') : 'Changing file name length is disabled at the moment.') + '</p>\n' +
        '  </div>\n' +
        '  <div class="field">\n' +
        '    <div class="control">\n' +
        '      <a id="setFileLength" class="button is-breeze is-fullwidth">\n' +
        '        <span class="icon">\n' +
        '          <i class="icon-paper-plane-empty"></i>\n' +
        '        </span>\n' +
        '        <span>Set file name length</span>\n' +
        '      </a>\n' +
        '    </div>\n' +
        '  <div>\n' +
        '</div>'

      document.getElementById('setFileLength').addEventListener('click', function () {
        page.setFileLength(document.getElementById('fileLength').value, this)
      })
    })
    .catch(function (error) {
      console.log(error)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.setFileLength = function (fileLength, element) {
  page.isLoading(element, true)

  axios.post('api/filelength/change', { fileLength: fileLength })
    .then(function (response) {
      page.isLoading(element, false)

      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      swal({
        title: 'Woohoo!',
        text: 'Your file length was successfully changed.',
        icon: 'success'
      })
        .then(function () {
          page.changeFileLength()
        })
    })
    .catch(function (error) {
      console.log(error)
      page.isLoading(element, false)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.changeToken = function () {
  axios.get('api/tokens')
    .then(function (response) {

      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      page.dom.innerHTML =
        '<h2 class="subtitle">Manage your token</h2>\n' +
        '<div class="field">\n' +
        '  <label class="label">Your current token:</label>\n' +
        '  <div class="field">\n' +
        '    <div class="control">\n' +
        '      <input id="token" readonly class="input" type="text" placeholder="Your token" value="' + response.data.token + '">\n' +
        '    </div>\n' +
        '  </div>\n' +
        '</div>\n' +
        '<div class="field">\n' +
        '  <div class="control">\n' +
        '    <a id="getNewToken" class="button is-breeze is-fullwidth" data-action="get-new-token">\n' +
        '      <span class="icon">\n' +
        '        <i class="icon-arrows-cw"></i>\n' +
        '      </span>\n' +
        '      <span>Request new token</span>\n' +
        '    </a>\n' +
        '  </div>\n' +
        '</div>'

    })
    .catch(function (error) {
      console.log(error)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.getNewToken = function (element) {
  page.isLoading(element, true)

  axios.post('api/tokens/change')
    .then(function (response) {
      page.isLoading(element, false)

      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      swal({
        title: 'Woohoo!',
        text: 'Your token was successfully changed.',
        icon: 'success'
      })
        .then(function () {
          axios.defaults.headers.common.token = response.data.token
          localStorage.token = response.data.token
          page.token = response.data.token
          page.changeToken()
        })
    })
    .catch(function (error) {
      console.log(error)
      page.isLoading(element, false)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.changePassword = function () {
  page.dom.innerHTML =
    '<h2 class="subtitle">Change your password</h2>\n' +
    '<div class="field">\n' +
    '  <label class="label">New password:</label>\n' +
    '  <div class="control">\n' +
    '    <input id="password" class="input" type="password">\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div class="field">\n' +
    '  <label class="label">Re-type new password:</label>\n' +
    '  <div class="control">\n' +
    '    <input id="passwordConfirm" class="input" type="password">\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div class="field">\n' +
    '  <div class="control">\n' +
    '    <a id="sendChangePassword" class="button is-breeze is-fullwidth">\n' +
    '      <span class="icon">\n' +
    '        <i class="icon-paper-plane-empty"></i>\n' +
    '      </span>\n' +
    '      <span>Set new password</span>\n' +
    '    </a>\n' +
    '  </div>\n' +
    '</div>'

  document.getElementById('sendChangePassword').addEventListener('click', function () {
    if (document.getElementById('password').value === document.getElementById('passwordConfirm').value) {
      page.sendNewPassword(document.getElementById('password').value, this)
    } else {
      swal({
        title: 'Password mismatch!',
        text: 'Your passwords do not match, please try again.',
        icon: 'error'
      })
    }
  })
}

page.sendNewPassword = function (pass, element) {
  page.isLoading(element, true)

  axios.post('api/password/change', { password: pass })
    .then(function (response) {
      page.isLoading(element, false)

      if (response.data.success === false) {
        if (response.data.description === 'No token provided') {
          return page.verifyToken(page.token)
        } else {
          return swal('An error occurred!', response.data.description, 'error')
        }
      }

      swal({
        title: 'Woohoo!',
        text: 'Your password was successfully changed.',
        icon: 'success'
      })
        .then(function () {
          page.changePassword()
        })
    })
    .catch(function (error) {
      console.log(error)
      page.isLoading(element, false)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })

}

page.setActiveMenu = function (activeItem) {
  var menu = document.getElementById('menu')
  var items = menu.getElementsByTagName('a')
  for (var i = 0; i < items.length; i++) {
    items[i].classList.remove('is-active')
  }

  activeItem.classList.add('is-active')
}

window.onload = function () {
  // Add 'no-touch' class to non-touch devices
  if (!('ontouchstart' in document.documentElement)) {
    document.documentElement.classList.add('no-touch')
  }

  var selectedFiles = localStorage.selectedFiles
  if (selectedFiles) {
    page.selectedFiles = JSON.parse(selectedFiles)
  }

  page.preparePage()

  page.clipboardJS = new ClipboardJS('.clipboard-js')

  page.clipboardJS.on('success', function () {
    return swal('Copied!', 'The link has been copied to clipboard.', 'success')
  })

  page.clipboardJS.on('error', function (event) {
    console.error(event)
    return swal('An error occurred!', 'There was an error when trying to copy the link to clipboard, please check the console for more information.', 'error')
  })

  page.lazyLoad = new LazyLoad()
}
