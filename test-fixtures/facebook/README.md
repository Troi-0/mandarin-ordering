# Historical Facebook benchmark images

These are resized public menu images exposed by the exact Facebook permalinks.
They exist only to make non-publishing model regression tests reproducible after
Facebook rotates old posts out of its logged-out Page feed.

| Date | Facebook post | SHA-256 |
| --- | --- | --- |
| 2026-08-24 | `1697831445682461` | `2bfc03e5b38d9635e78e6be79da5ef879e48fff894a3ea508017b7e7da007867` |
| 2026-08-25 | `1698896525575953` | `890ec67f6690203b6cc02de2cba695d062887f7f2c76f37d3526fffef511b532` |

The workflow accepts these files only together with the matching human-verified
`data/menus/YYYY-MM-DD.json` reference and only in dry-run mode. They are never
used by the daily publishing path.
