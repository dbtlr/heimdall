### Fixed

- **Dashboard pages read each Session's cost once** (HMD-96). The fleet overview and System detail looked up a Session's totals once per stretch, re-pricing every request of the Session each time. They now look each Session up once, through one shared stretches read. On the live archive the 24-hour overview drops from about 22 to 7 seconds and the 7-day overview from 31 to 12.
