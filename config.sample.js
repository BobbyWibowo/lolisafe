module.exports = {
  /*
    If set to true the user will need to specify the auto-generated token
    on each API call, meaning random strangers won't be able to use the service
    unless they have the token lolisafe provides you with.
    If it's set to false, then upload will be public for anyone to use.
  */
  private: true,

  /*
    If set, only the specified group AND any groups higher than it
    will be allowed to upload new files.
    Any other groups, assuming registered, will still be able to manage their previously uploaded files.
  */
  privateUploadGroup: null, // Other group names in controllers/permissionController.js
  privateUploadCustomResponse: null,

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
  */
  serveFilesWithNode: false,
  domain: null,

  /*
    If you serve files with node, you can optionally choose to set Content-Disposition header
    with their original file names. This allows users to download files into their original file names.

    "contentDispositionOptions" configures in-memory caching options,
    as it would otherwise have to query database every single time.

    If enabled, but "contentDispositionOptions" is missing, it will use these defaults:
    { limit: 50, strategy: 'LAST_GET_TIME' }
  */
  setContentDisposition: false,
  contentDispositionOptions: {
    limit: 50,
    /*
      Available strategies: LAST_GET_TIME, GETS_COUNT

      LAST_GET_TIME: when cache store exceeds limit, remove cache with oldest access time
      GETS_COUNT: when cache store exceeds limit, remove cache with fewest access count
    */
    strategy: 'LAST_GET_TIME'
  },

  /*
    If you serve files with node, you can optionally choose to
    override Content-Type header for certain extension names.
  */
  overrideContentTypes: {
    // 'text/plain': ['html', 'htm', 'shtml', 'xhtml']
  },

  /*
    If you are serving your files with a different domain than your lolisafe homepage,
    then fill this option with the actual domain for your lolisafe homepage.
    This will be used for Open Graph tags and wherever lolisafe need to link to internal pages.
    If any falsy value, it will inherit "domain" option.

    NOTE: If this, or the inherited "domain" option, is not set to an explicit domain,
    Open Graph tags may fail in websites that do not support relative URLs.
  */
  homeDomain: null,

  /*
    Port on which to run the server.
  */
  port: 9999,

  /*
    Pages to process for the frontend.
    To add new pages, you may create a new Nunjucks-templated pages (.njk) in "views" directory,
    or regular HTML files (.html) in "pages/custom" directory,
    then simply add the filename without its extension name into the array below.
  */
  pages: ['home', 'auth', 'dashboard', 'faq'],

  /*
    This will load public/libs/cookieconsent/cookieconsent.min.{css,js} on homepage (configured from home.js).
    You may use this if you have some specific needs, since lolisafe by itself will not use Cookies at all.
    Instead it will use Local Storage for both authentication and preferences/states in Dashboard.
    I'm not sure if Cookies Laws apply to Local Storage as well, although I suppose it makes sense if they do.
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
    Helmet security headers.
    https://github.com/helmetjs/helmet/tree/v5.0.2#how-it-works

    These headers will be applied to ALL resources, including API endpoints,
    and files if you serve them with node.
    If you need to disable some of the headers at certain routes, it's recommended
    to instead use own http server (nginx, etc.) in front of lolisafe and configure from there.

    NOTE: You may set "helmet" option as an empty object {} to disable Helmet entirely.
    Setting it as any falsy value will instead apply some default configurations.
  */
  helmet: {
    contentSecurityPolicy: false,
    // Cross-Origin-* headers were enabled by default since Helmet v5.0.0
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    /*
    hsts: {
      maxAge: 63072000, // 2 years
      includeSubDomains: true,
      preload: true
    }
    */
    hsts: false,
    // This was also enabled by default since Helmet v5.0.0
    originAgentCluster: false
  },

  /*
    Access-Control-Allow-Origin
    https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin
    These headers will be applied to ALL resources, including API endpoints,
    and files if you serve them with node.

    If set to true, it will be set as wildcard (*).
    If set to any falsy value, it will be not set altogether.
    Otherwise if any string value, it will be set as-is.

    Whether to use this in conjunction with Cross-Origin-* headers depends on your needs.
    FAQ: https://resourcepolicy.fyi/#acao
  */
  accessControlAllowOrigin: false,

  /*
    Trust proxy.
    Enable this if you are using proxy such as Cloudflare or Incapsula,
    and/or also when you are using reverse proxy such as nginx or Apache.
  */
  trustProxy: true,

  /*
    Rate limits.
    Please be aware that these apply to all users, including site owners.
    https://github.com/nfriedly/express-rate-limit/tree/v6.3.0#configuration
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
        legacyHeaders: true,
        standardHeaders: true,
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
        legacyHeaders: true,
        standardHeaders: true,
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
        max: 6,
        legacyHeaders: true,
        standardHeaders: true
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
        legacyHeaders: true,
        standardHeaders: true,
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
      Chunk size for chunked uploads. Needs to be in MB.

      If this is enabled, every files uploaded from the homepage uploader
      will forcibly be chunked by the size specified in "default".
      Users can configure the chunk size they want from the homepage uploader,
      but you can force allowed max size of each chunk with "max".
      Min size will always be 1MB.

      Users will still be able to upload bigger files with the API
      as long as they don't surpass the limit specified in the "maxSize" option above.
      Once all chunks have been uploads, their total size
      will be tested against the "maxSize" option again.

      With "timeout", you can specify how long a particular chunked upload attempt
      can remain inactive before their temporary data gets cleared out
      (partially uploaded files or other internal data).

      This option is mainly useful for hosters that use Cloudflare,
      since Cloudflare limits upload size to 100MB on their Free plan.
      https://support.cloudflare.com/hc/en-us/articles/200172516#h_51422705-42d0-450d-8eb1-5321dcadb5bc

      NOTE: Set "default" or the option itself to falsy value to disable chunked uploads.
    */
    chunkSize: {
      max: '95MB',
      default: '25MB',
      timeout: 30 * 60 * 1000 // 30 minutes
    },

    /*
      Folder where in-progress chunks should be kept temporarily.
      NOTE: When set to falsy value, defaults to "chunks" subfolder within uploads folder.
    */
    chunksFolder: null,

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
    urlProxy: 'https://external-content.duckduckgo.com/iu/?u={url}&f=1&nofb=1',

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
      attempts to set permanent upload age will be rejected.

      This only applies to new files uploaded AFTER enabling the option.
      If disabled, any existing temporary uploads will not ever be automatically deleted,
      since the safe assumes all uploads are permanent,
      and thus will not start the periodical check up task.

      DEPRECATED: Please use "retentionPeriods" option below instead.
    */
    // temporaryUploadAges: [],

    /*
      Usergroup-based file retention periods (temporary uploads ages).

      You need to at least configure the default group (_), or any one group, to enable this.
      If this is enabled, "temporaryUploadAges" option above will be completely ignored.

      It's safe to disable and remove that option completely if you plan to only use this one.
      The support for it was only kept as backwards-compatibility for older installations.

      This only applies to new files uploaded AFTER enabling the option.
      If disabled, any existing temporary uploads will not ever be automatically deleted,
      since the safe assumes all uploads are permanent,
      and thus will not start the periodical check up task.

      Please refer to the examples below about inheritances
      and how to set default retention for each groups.
    */
    retentionPeriods: {
      // Defaults that also apply to non-registered users
      _: [
        24, // 24 hours (1 day) -- first value is the group's default retention
        1 / 60 * 15, // 15 minutes
        1 / 60 * 30, // 30 minutes
        1, // 1 hour
        6, // 6 hours
        12 // 12 hours
      ],
      /*
        Inheritance is based on each group's 'values' in permissionController.js.
        Basically groups with higher 'value' will inherit retention periods
        of any groups with lower 'values'.
        You may remove all the groups below to apply the defaults above for everyone.
      */
      user: [
        24 * 7, // 168 hours (7 days) -- group's default
        24 * 2, // 48 hours (2 days)
        24 * 3, // 72 hours (3 days)
        24 * 4, // 96 hours (4 days)
        24 * 5, // 120 hours (5 days)
        24 * 6 // 144 hours (6 days)
      ],
      vip: [
        24 * 30, // 720 hours (30 days) -- group's default
        24 * 14, // 336 hours (14 days)
        24 * 21, // 504 hours (21 days)
        24 * 91 // 2184 hours (91 days)
      ],
      vvip: [
        null, // -- if null, use previous group's default as this group's default
        0, // permanent
        24 * 183 // 4392 hours (183 days)
      ],
      moderator: [
        0 // -- group's default
        /*
          vvip group also have 0 (permanent) in its retention periods,
          but duplicates are perfectly fine and will be safely 'uniquified',
          while still properly maintaining defaults when required.
        */
      ]
      /*
        Missing groups will follow the inheritance rules.
        Following the example above, admin and superadmin will have the same retention periods as moderator.
      */
    },

    /*
      Interval of the periodical check up tasks for temporary uploads (in milliseconds).
      NOTE: Set to falsy value if you prefer to use your own external script.
    */
    temporaryUploadsInterval: 1 * 60000, // 1 minute

    /*
      Scan uploads for threats with ClamAV.

      groupBypass: Name of the lowest ranked group whose files will not be scanned.
      Lowest ranked meaning that group AND any groups higher than it are included.
      Example: 'moderator' = moderators, admins & superadmins.
    */
    scan: {
      enabled: false,
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

      // Make sure this doesn't exceed size limit in your ClamAV config
      maxSize: null, // Needs to be in MB

      // https://github.com/kylefarris/clamscan/tree/v2.1.2#getting-started
      // Breaking options (do not use): removeInfected, quarantineInfected, fileList, scanRecursively
      // Untested options (may work): scanLog
      // Supported options: debugMode, clamscan, clamdscan, preference
      clamOptions: {
        debugMode: false,
        clamscan: {
          path: '/usr/bin/clamscan',
          db: null,
          scanArchives: true,
          active: true
        },
        clamdscan: {
          // When both socket and host+port are specified, it will only use socket
          socket: '/var/run/clamav/clamd.ctl',
          host: '127.0.0.1',
          port: 3310,
          timeout: 1 * 60 * 1000, // 1 minute
          localFallback: true,
          path: '/usr/bin/clamdscan',
          configFile: null,
          multiscan: true,
          reloadDb: false,
          active: true,
          bypassTest: false
        },
        preference: 'clamdscan'
      },

      /*
        Experimental .passthrough() support.
        https://github.com/kylefarris/clamscan/tree/v2.1.2#passthrough

        If enabled, StreamMaxLength in ClamAV config must be able to accommodate your
        main "maxSize" option (not to be confused with "maxSize" in "scan" options group).
        Final file size can't be determined before passthrough,
        so file of all sizes will have to be scanned regardless.

        This will only passthrough scan non-chunked file uploads.
        Chunked file uploads and URL uploads will still use the default scan method.
      */
      clamPassthrough: false
    },

    /*
      Store uploader's IPs into the database.
      NOTE: Dashboard's Manage Uploads will display IP column regardless of whether
      this is set to true or false.
    */
    storeIP: true,

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
    cacheFileIdentifiers: false,

    /*
      An alternative to caching file identifiers.

      Basically the service will instead query the database for stricter collision checks.
      Right off the bat this has the disadvantage of adding one or more SQL queries on every
      new uploads, but it has the advantage of not having to pre-cache anything.
      Essentially this reduces the service's startup time and memory usage, but slows down new uploads.

      As this is an alternative, you need to disable cacheFileIdentifiers to use this.

      You'll have to figure out which method suits your use case best.
    */
    queryDbForFileCollisions: true,

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
    */
    generateThumbs: {
      image: true,
      video: true,
      // Placeholder defaults to 'public/images/unavailable.png'.
      placeholder: null,
      size: 200
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
      force: false,
      // Supporting the extensions below requires using custom globally-installed libvips.
      // https://sharp.pixelplumbing.com/install#custom-libvips
      blacklistExtensions: [
        // GIFs require libvips compiled with ImageMagick/GraphicsMagick support.
        // https://sharp.pixelplumbing.com/api-output#gif
        '.gif'
      ]
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
      API route (e.g. homeDomain/api/album/zip/*), with this option you can limit the
      maximum total size of files in an album that can be zipped.
      It's worth nothing that Cloudflare will not cache files bigger than 512MB.
      However, it's not recommended to do that in high-bandwidth sites anyway,
      since long-caching of such huge files are against Cloudflare's Terms of Service.
      NOTE: Set to falsy value to disable max total size.
    */
    zipMaxTotalSize: '512MB',

    /*
      If you want the service to automatically use Cloudflare API to purge cache on file deletion,
      fill your zone ID below. It will only purge cache of the deleted file, and its thumbs if applicable.
      Afterwards, you will have to choose any of the supported auth methods, which are:
      API token, user service key, OR API key + email.
      If more than one are provided, it will use the first one from left to right, but it will NOT
      attempt to use the next methods even if the selected one fails (meaning there's no fallback mechanism).
      Consult https://api.cloudflare.com/#getting-started-requests for differences.
      API token configuration example: https://github.com/BobbyWibowo/lolisafe/pull/216#issue-440389284.
      After everything is ready, you can then set "purgeCache" to true.
    */
    zoneId: '',
    purgeCache: false,

    apiToken: '',

    userServiceKey: '',

    apiKey: '',
    email: ''
  },

  /*
    Enable Cache-Control header tags.
    Please consult the relevant codes in lolisafe.js to learn the specifics.
    true or 1: Cloudflare (will cache some frontend pages in CDN)
    2: Basic Cache-Control without CDNs

    NOTE: If set to Cloudflare, and auth is specified in "cloudflare" option above,
    lolisafe will automatically call Cloudflare API to purge cache of the relevant frontend pages.
  */
  cacheControl: false,

  /*
    Folder where to store logs.
    NOTE: This is currently unused.
  */
  logsFolder: 'logs',

  /*
    The following values shouldn't be touched, unless you know what you are doing.
  */
  database: {
    client: 'better-sqlite3',
    connection: { filename: './database/db.sqlite3' },
    useNullAsDefault: true
  }
}
