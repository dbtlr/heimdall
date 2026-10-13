### Changed

- **The Hub no longer serves a page** (HMD-92). `GET /` and `/?unpaired` on the Hub answer 404; the dashboard shows everything the page showed. Point the Hub's public web name at the dashboard (Fleet ask A13 in `docs/fleet.md`). Upgrade only once the dashboard is declared (A11) and the web name points at it (A13); until then the web name answers 404.
