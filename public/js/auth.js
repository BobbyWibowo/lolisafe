/* global swal, axios */

var page = {
  // user token
  token: localStorage.token,

  // HTML elements
  user: null,
  pass: null
}

page.do = function (dest) {
  var user = page.user.value
  var pass = page.pass.value

  if (!user) {
    return swal('Error', 'You need to specify a username', 'error')
  }

  if (!pass) {
    return swal('Error', 'You need to specify a username', 'error')
  }

  axios.post('api/' + dest, {
    username: user,
    password: pass
  })
    .then(function (response) {
      if (response.data.success === false) {
        return swal('Error', response.data.description, 'error')
      }

      localStorage.token = response.data.token
      window.location = 'dashboard'
    })
    .catch(function (error) {
      console.error(error)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

page.verify = function () {
  if (!page.token) { return }

  axios.post('api/tokens/verify', {
    token: page.token
  })
    .then(function (response) {
      if (response.data.success === false) {
        return swal('Error', response.data.description, 'error')
      }

      window.location = 'dashboard'
    })
    .catch(function (error) {
      console.error(error)
      return swal('An error occurred!', 'There was an error with the request, please check the console for more information.', 'error')
    })
}

window.onload = function () {
  page.verify()

  page.user = document.getElementById('user')
  page.pass = document.getElementById('pass')

  document.getElementById('loginBtn').addEventListener('click', function () {
    page.do('login')
  })

  document.getElementById('registerBtn').addEventListener('click', function () {
    page.do('register')
  })
}
