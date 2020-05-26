module.exports = {
  /*
    If set to true the user will need to specify the auto-generated token
    on each API call, meaning random strangers won't be able to use the service
    unless they have the token lolisafe provides you with.
    If it's set to false, then upload will be public for anyone to use.
  */
  private: true,

  /*
    If true, users will be able to create accounts and access their uploaded files.
  */
  enableUserAccounts: true,

  /*
    Here you can decide if you want lolisafe to serve the files or if you prefer doing so via nginx.
    The main difference between the two is the ease of use and the chance of analytics in the future.
    If you set it to `true`, the uploaded files will be located after the host like:
      https://lolisafe.moe/yourFile.jpg

    If you set it to `false`, you need to set nginx to directly serve whatever folder it is you are serving your
    downloads in. This also gives you the ability to serve them, for example, like this:
      https://files.lolisafe.moe/yourFile.jpg

    Both cases require you to type the domain where the files will be served on the `domain` key below.
    Which one you use is ultimately up to you.

    Leave this as "false" if using docker.
  */
  serveFilesWithNode: false,
  domain: 'https://lolisafe.moe',

  /*
    If you are serving your files with a different domain than your lolisafe homepage,
    then fill this option with your lolisafe homepage, otherwise any falsy value.
    This will be used when listing album links in the dashboard.
  */
  homeDomain: null,

  /*
    Port on which to run the server. Do not change this if using docker. Change in .env.
  */
  port: 9999,

  /*
    Pages to process for the frontend.
  */
  pages: ['home', 'auth', 'dashboard', 'faq'],

  /*
    This will load public/libs/cookieconsent/cookieconsent.min.{css,js} on homepage (configured from home.js).
    You may use this if you have some specific needs, since lolisafe by itself will not use Cookies at all.
    Instead it will use Local Storage for both authentication and preferences/states in Dashboard.
    I'm not sure if Cookies Laws apply to Local Storage as well, although I supppose it makes sense if they do.
    NOTE: Enabling this will automatically push 'cookiepolicy' to pages array above.
  */
  cookiePolicy: false,

  /*
    This can be either 'blacklist' or 'whitelist', which should be self-explanatory.
    When this is set to neither, this will fallback to 'blacklist'.
  */
  extensionsFilterMode: 'blacklist',

  extensionsFilter: [
    '.bash_profile',
    '.bash',
    '.bashrc',
    '.bat',
    '.bsh',
    '.cmd',
    '.com',
    '.csh',
    '.exe',
    '.exec',
    '.jar',
    '.msi',
    '.nt',
    '.profile',
    '.ps1',
    '.psm1',
    '.scr',
    '.sh'
  ],

  /*
    If set to true, files with no extensions will always be rejected.
  */
  filterNoExtension: false,

  /*
    If set to true, files with zero bytes size will always be rejected.
    NOTE: Even if the files only contain whitespaces, as long as they aren't
    zero bytes, they will be accepted.
  */
  filterEmptyFile: true,

  /*
    Show hash of the current git commit in homepage.
  */
  showGitHash: false,

  /*
    Path to error pages. Only 404 and 500 will be used.
    NOTE: rootDir can either be relative or absolute path.
  */
  errorPages: {
    rootDir: './pages/error',
    404: '404.html',
    500: '500.html'
  },

  /*
    HTTP Strict Transport Security (HSTS).
    This doesn't enforce HTTP users to switch to HTTPS.
    It only tells HTTPS users to stick around (i.e. not to downgrade to HTTP).
    When set, it's also added to HTTP responses because the header will be ignored anyway.
    https://helmetjs.github.io/docs/hsts/#the-code
  */
  hsts: {
    // maxAge: 63072000, // 2 years
    // includeSubDomains: true,
    // preload: true
  },

  /*
    Trust proxy.
    Enable this if you are using proxy such as Cloudflare or Incapsula,
    and/or also when you are using reverse proxy such as nginx or Apache.
  */
  trustProxy: true,

  /*
    Rate limits.
    Please be aware that these apply to all users, including site owners.
    https://github.com/nfriedly/express-rate-limit#configuration-options
  */
  rateLimits: [
    {
      // 10 requests in 1 second
      routes: [
        '/api/'
      ],
      config: {
        windowMs: 1000,
        max: 10,
        message: {
          success: false,
          description: 'Rate limit reached, please try again in a while.'
        }
      }
    },
    {
      // 2 requests in 5 seconds
      routes: [
        '/api/login',
        '/api/register'
      ],
      config: {
        windowMs: 5 * 1000,
        max: 2,
        message: {
          success: false,
          description: 'Rate limit reached, please try again in 5 seconds.'
        }
      }
    },
    {
      // 6 requests in 30 seconds
      routes: [
        '/api/album/zip'
      ],
      config: {
        windowMs: 30 * 1000,
        max: 6
      }
    },
    {
      // 1 request in 60 seconds
      routes: [
        '/api/tokens/change'
      ],
      config: {
        windowMs: 60 * 1000,
        max: 1,
        message: {
          success: false,
          description: 'Rate limit reached, please try again in 60 seconds.'
        }
      }
    }
  ],

  /*
    Uploads config.
  */
  uploads: {
    /*
      Folder where files should be stored.
    */
    folder: 'uploads',

    /*
      Max file size allowed. Needs to be in MB.
      NOTE: When maxSize is greater than 1 MiB and using nginx as reverse proxy,
      you must set client_max_body_size to the same as maxSize.
      https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size
    */
    maxSize: '512MB',

    /*
      Max file size allowed for upload by URLs. Needs to be in MB.
      NOTE: Set to falsy value to disable upload by URLs.
    */
    urlMaxSize: '32MB',

    /*
      Proxy URL uploads.
      NOTE: Set to falsy value to disable.

      Available templates:
      {url} = full URL (encoded & with protocol)
      {url-noprot} = URL without protocol (images.weserv.nl prefers this format)

      Example:
      https://images.weserv.nl/?url={url-noprot}
      will become:
      https://images.weserv.nl/?url=example.com%2Fassets%2Fimage.png
    */
    urlProxy: 'https://proxy.duckduckgo.com/iu/?u={url}',

    /*
     Disclaimer message that will be printed underneath the URL uploads form.
     Supports HTML. Be safe though.
    */
    urlDisclaimerMessage: 'URL uploads are being proxied by <a href="https://duckduckgo.com/" target="_blank" rel="noopener">DuckDuckGo</a>.',

    /*
     Filter mode for URL uploads.
     Can be 'blacklist', 'whitelist', or 'inherit'.
     'inherit' => inherit primary extensions filter (extensionsFilter option).
     The rest are paired with urlExtensionsFilter option below and should be self-explanatory.
     When this is not set to any of the 3 values, this will fallback to 'inherit'.
    */
    urlExtensionsFilterMode: 'whitelist',

    /*
     Mainly intended for URL proxies that only support certain extensions.
     This will parse the extensions from the URLs, so URLs that do not end with
     the file's extensions will always be rejected.
     Queries and segments in the URLs will be bypassed.
     NOTE: Can not be empty when using either 'blacklist' or 'whitelist' mode.
    */
    urlExtensionsFilter: [
      '.webp',
      '.jpg',
      '.jpeg',
      '.bmp',
      '.gif',
      '.png',
      '.tiff',
      '.tif',
      '.svg'
    ],

    /*
      An array of allowed ages for uploads (in hours).

      Default age will be the value at the very top of the array.
      If the array is populated but do not have a zero value,
      permanent uploads will be rejected.
      This only applies to new files uploaded after enabling the option.

      If the array is empty or is set to falsy value, temporary uploads
      feature will be disabled, and all uploads will be permanent (original behavior).

      When temporary uploads feature is disabled, any existing temporary uploads
      will not ever be automatically deleted, since the safe will not start the
      periodical checkup task.
    */
    temporaryUploadAges: [
      0, // permanent
      1 / 60 * 15, // 15 minutes
      1 / 60 * 30, // 30 minutes
      1, // 1 hour
      6, // 6 hours
      12, // 12 hours
      24, // 24 hours (1 day)
      24 * 2, // 48 hours (2 days)
      24 * 3, // 72 hours (3 days)
      24 * 4, // 96 hours (4 days)
      24 * 5, // 120 hours (5 days)
      24 * 6, // 144 hours (6 days)
      24 * 7 // 168 hours (7 days)
    ],

    /*
      Interval of the periodical check up tasks for temporary uploads (in milliseconds).
      NOTE: Set to falsy value if you prefer to use your own external script.
    */
    temporaryUploadsInterval: 1 * 60000, // 1 minute

    /*
      Scan files using ClamAV through clamd.
      https://github.com/NingLin-P/clamdjs#scannerscanfilepath-timeout-chunksize

      groupBypass: Name of the lowest ranked group whose files will not be scanned.
      Lowest ranked meanning that group AND any groups higher than it are included.
      Example: 'moderator' = moderators, admins & superadmins.
    */
    scan: {
      enabled: false,

      ip: '127.0.0.1',
      port: 3310,
      timeout: 180 * 1000,
      chunkSize: 64 * 1024,

      groupBypass: 'admin', // Other group names in controllers/permissionController.js
      whitelistExtensions: null, /* [
        '.webp',
        '.jpg',
        '.jpeg',
        '.gif',
        '.png',
        '.tiff',
        '.tif',
        '.svg',
        '.webm',
        '.mp4',
        '.wmv',
        '.avi',
        '.mov',
        '.mkv'
      ], */
      maxSize: null // '25MB' // Needs to be in MB
    },

    /*
      Store uploader's IPs into the database.
      NOTE: Dashboard's Manage Uploads will display IP column regardless of whether
      this is set to true or false.
    */
    storeIP: true,

    /*
      Chunk size for chunk uploads. Needs to be in MB.
      If this is enabled, every files uploaded from the homepage uploader will forcibly be chunked
      by the size specified in "chunkSize". People will still be able to upload bigger files with
      the API as long as they don't surpass the limit specified in the "maxSize" option above.
      Total size of the whole chunks will also later be checked against the "maxSize" option.
      NOTE: Set to falsy value to disable chunked uploads.
    */
    chunkSize: '10MB',

    /*
      The length of the randomly generated identifier for uploaded files.
      If "force" is set to true, files will always use "default".
    */
    fileIdentifierLength: {
      min: 4,
      max: 32,
      default: 8,
      force: false
    },

    /*
      Cache file identifiers.

      They will be used for stricter collision checks, such that a single identifier
      may not be used by more than a single file (e.g. if "abcd.jpg" already exists, a new PNG
      file may not be named as "abcd.png").

      If this is enabled, the safe will query files from the database during first launch,
      parse their names, then cache the identifiers into memory.
      Its downside is that it will use a bit more memory.

      If this is disabled, collision check will become less strict.
      As in, the same identifier may be used by multiple different extensions (e.g. if "abcd.jpg"
      already exists, new files can be possibly be named as "abcd.png", "abcd.mp4", etc).
      Its downside will be, in the rare chance that multiple image/video files are sharing the same
      identifier, they will end up with the same thumbnail in dashboard, since thumbnails will
      only be saved as PNG in storage (e.g. "abcd.jpg" and "abcd.png" will share a single thumbnail
      named "abcd.png" in thumbs directory, in which case, the file that's uploaded the earliest will
      be the source for the thumbnail).

      Unless you do not use thumbnails, it is highly recommended to enable this feature.
    */
    cacheFileIdentifiers: true,

    /*
      The length of the randomly generated identifier for albums.
    */
    albumIdentifierLength: 8,

    /*
      This option will limit how many times it will try to
      generate a new random name when a collision occurs.
      Generally, the shorter the length is, the higher the chance for a collision to occur.
      This applies to both file name and album identifier.
    */
    maxTries: 3,

    /*
      Thumbnails are only used in the dashboard and album's public pages.
      You need to install a separate binary called ffmpeg (https://ffmpeg.org/) for video thumbnails.
      NOTE: Placeholder defaults to 'public/images/unavailable.png'.
    */
    generateThumbs: {
      image: true,
      video: false,
      placeholder: null
    },

    /*
      Strip tags (e.g. EXIF).

      "default" decides whether to strip tags or not by default,
      as the behavior can be configured by users from home uploader's Config tab.
      If "force" is set to true, the default behavior will be enforced.

      "video" decides whether to also strip tags of video files
      (of course only if the default behavior is to strip tags).
      However, this also requires ffmpeg (https://ffmpeg.org/),
      and is still experimental (thus use at your own risk!).

      NOTE: Other than setting "default" to false, and "force" to true,
      you can also set stripTags option itself to any falsy value to completely
      disable this feature. This will also remove the option from
      home uploader's Config tab, as the former would only grey out the option.
    */
    stripTags: {
      default: false,
      video: false,
      force: false
    },

    /*
      Allow users to download a ZIP archive of all files in an album.
      The file is generated when the user clicks the download button in the view
      and is re-used if the album has not changed between download requests.
    */
    generateZips: true,

    /*
      JSZip's options to use when generating album ZIPs.
      https://stuk.github.io/jszip/documentation/api_jszip/generate_async.html
      NOTE: Changing this option will not re-generate existing ZIPs.
    */
    jsZipOptions: {
      streamFiles: true,
      compression: 'DEFLATE',
      compressionOptions: {
        level: 1
      }
    }
  },

  /*
    Cloudflare support.
  */
  cloudflare: {
    /*
      No-JS uploader page will not chunk the uploads, so it's recommended to change this
      into the maximum upload size you have in Cloudflare.
      This limit will only be applied to the subtitle in the page.
      NOTE: Set to falsy value to inherit "maxSize" option.
    */
    noJsMaxSize: '100MB',

    /*
      If you have a Page Rule in Cloudflare to cache everything in the album zip
      API route (homeDomain/api/album/zip/*), with this option you can limit the
      maximum total size of files in an album that can be zipped.
      Cloudflare will not cache files bigger than 512MB.
      NOTE: Set to falsy value to disable max total size.
    */
    zipMaxTotalSize: '512MB',

    /*
      If you want to make it automatically call Cloudflare's API to purge cache on file delete,
      fill your API key, email and your site's zone ID below, then set "purgeCache" to true.
      This will only purge cache of the deleted file and its associated thumb.
    */
    apiKey: '',
    email: '',
    zoneId: '',
    purgeCache: false
  },

  /*
    ADVANCED: Use safe.fiery.me-exclusive cache control.
    This will only work properly with certain settings in nginx reverse proxy and Cloudflare.
    Do NOT enable unless you know what you are doing.
    true: With CDN (Cloudflare)
    2: When NOT using Cloudflare
  */
  cacheControl: false,

  /*
    Enable Linux-only extended disk stats in Dashboard's Statistics.
    This will use "du" binary to query disk usage of each directories within uploads directory.
    Disabled by default as I personally found it to be very slow with +100k uploads
    with my ancient potato server.
  */
  linuxDiskStats: false,

  /*
    Folder where to store logs.
    NOTE: This is currently unused.
  */
  logsFolder: 'logs',

  /*
    The following values shouldn't be touched, unless you know what you are doing.
  */
  database: {
    client: 'sqlite3',
    connection: { filename: './database/db' },
    useNullAsDefault: true
  }
}
