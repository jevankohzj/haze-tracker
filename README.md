# Haze Tracker

A progressive web app showing Singapore's air quality by region (central, north, south, east, west) from NEA's real-time data on [data.gov.sg](https://data.gov.sg):

- **24-hour PSI** (`/psi`)
- **1-hour PM2.5** (`/pm25`): NEA's hourly reading. NEA does not publish a 1-hour PSI.

Users can add it to their home screen and set an alert (region, reading and threshold). A notification is sent when the value reaches the threshold after being below it.

## How it works

- Static front end: `index.html`, `styles.css`, `app.js`, shared logic in `core.js`.
- `sw.js` caches the app for offline use and runs background alert checks where the browser allows it.
- `api/psi.js` and `api/pm25.js` are small Vercel functions that proxy NEA (cached for 2 minutes). The app falls back to calling NEA directly if they are unavailable.
- Optional: set a `NEA_API_KEY` environment variable on Vercel to send an `x-api-key` header to data.gov.sg.

## Notification limits

Alerts are checked while the app is open, and in the background on Android Chrome (installed app, roughly hourly, at the browser's discretion). iOS has no background checks for web apps. Alerts that arrive while the app is fully closed on every device need a push server, which this project does not include.

Data: National Environment Agency, Singapore Open Data Licence. Not an official NEA app.
