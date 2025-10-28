# README

## cf-purge.js

```none
$ yarn cf-purge
$ node ./scripts/cf-purge.js
Purge Cloudflare's cache.

Usage:
node scripts/cf-purge.js ...filename

filename:
Upload names separated by space (will automatically include their thumbs if available).
```

## clean-up.js

```none
$ yarn clean-up -h
$ node ./scripts/clean-up.js -h
Clean up files that are not in the database.

Usage:
node scripts/clean-up.js [mode=0|1|2]

mode:
0 = Only list names of files that are not in the database.
1 = Clean up the files.
```

## delete-expired.js

```none
$ yarn delete-expired -h
$ node ./scripts/delete-expired.js -h
Bulk delete expired files.

Usage:
node scripts/delete-expired.js [mode=0|1|2]

mode:
0 = Only list names of the expired files.
1 = Delete expired files (output file names).
2 = Delete expired files (no output).
```

## rebuild-hashes.js

```none
$ yarn rebuild-hashes -h
$ node ./scripts/rebuild-hashes.js -h
Rebuild file hashes.

Usage:
node scripts/rebuild-hashes.js <mode=0|1|2>

mode:
0 = Dry run (recalculate hashes, print them, but do NOT store to DB).
1 = Recalculate hashes and store to DB.
2 = Verbose (recalculate hashes, print them, and store to DB).
```

## thumbs.js

Thumbnails will not be automatically generated for files that were uploaded before enabling thumbnails generation in the config file.

To generate thumbnails for those files, you can use `yarn thumbs`.

```none
$ yarn thumbs
$ node ./scripts/thumbs.js
Generate thumbnails.

Usage:
node scripts/thumbs.js <mode=1|2|3> [force=0|1] [verbose=0|1] [cfcache=0|1]

mode    : 1 = images only, 2 = videos only, 3 = both images and videos
force   : 0 = no force (default), 1 = overwrite existing thumbnails
verbose : 0 = only print missing thumbs (default), 1 = print all, 2 = print nothing
cfcache : 0 = do not clear cloudflare cache (default), 1 = clear cloudflare cache
```

For example, if you only want to generate thumbnails for image files without overwriting existing ones, you can run `yarn thumbs 1`, or if you want to generate thumbnails for both image and video files, while also overwriting existsing ones, you can run `yarn thumbs 3 1`.

You will also need to use this script to overwrite existing thumbnails if you want to change thumbnail size.

## bump-versions.js

[\[...\]](https://github.com/BobbyWibowo/chibisafe/tree/safe.fiery.me/src#readme)
