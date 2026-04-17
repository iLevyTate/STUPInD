# STUPInD — SuperTimerUsablePerInDevice

A privacy-first Pomodoro timer + ClickUp-style task manager that runs entirely in your browser. No account, no tracking, no sync. Everything stays on your device.

<img src="icon-512.png" alt="STUPInD" width="120" />

## Features

**Pomodoro Timer**
- Focus / Short Break / Long Break phases with auto-cycling
- Quick Timers (multi-instance) with presets (1m through 1h)
- Stopwatch with lap tracking
- Repeating chimes (e.g., posture check every 15min)
- Background audio keepalive — chimes fire even when tab is minimized

**ClickUp-Style Tasks**
- Nested tasks with subtasks
- Statuses: Open / In Progress / Review / Blocked / Done
- Priorities: Urgent / High / Normal / Low (with color-coded left stripe)
- Due dates, reminders, recurring tasks (daily/weekdays/weekly/monthly)
- Tags, starred pins, time tracking per task
- Natural-language quick add: `Buy milk tomorrow @urgent #shopping !star ~daily`

**Smart Views**
- Today, Week, Overdue, Unscheduled, Starred, Completed, Archive
- Group by priority, status, due date, or list
- List / Board (kanban) / Calendar views
- Search, filter, sort

**Productivity**
- Cmd+K command palette
- Drag-drop reorder
- Swipe-to-complete on mobile
- Dark / light theme
- CSV / Markdown / TXT export
- Full offline support (PWA)

## Installation

### Quick start (local)

1. **Open directly:** Double-click `index.html` — works in any modern browser from `file://`. Data persists in localStorage.

2. **Serve locally** (recommended, enables PWA install):
   ```bash
   # Python 3
   python3 -m http.server 8080

   # Node
   npx serve .

   # Then visit http://localhost:8080
   ```

3. **Install as app:**
   - **Chrome/Edge desktop:** Click the install icon in the address bar
   - **iOS Safari:** Share button → Add to Home Screen
   - **Android Chrome:** Menu (⋮) → Install app
   - **Firefox:** Address bar → install icon (desktop only)

### Deploy to the web

See [DEPLOY.md](DEPLOY.md) for step-by-step guides for:
- GitHub Pages
- Netlify (drag-and-drop)
- Vercel
- Cloudflare Pages
- Your own server

## File structure

```
stupind-pwa/
├── index.html                  Main app (single-file, self-contained)
├── manifest.json               PWA manifest
├── sw.js                       Service worker (offline cache)
├── icon-192.png                PWA icon (Android)
├── icon-512.png                PWA icon (Android splash)
├── icon-maskable-512.png       PWA icon (adaptive masking)
├── apple-touch-icon.png        iOS home screen icon (180×180)
├── favicon-32.png              Browser tab icon
├── README.md                   This file
└── DEPLOY.md                   Deployment guides
```

## Browser support

| Browser | Local use | PWA install | Background audio | Offline |
|---------|-----------|-------------|------------------|---------|
| Chrome desktop | ✓ | ✓ | ✓ (while open) | ✓ |
| Chrome Android | ✓ | ✓ | ✓ (while open) | ✓ |
| Safari macOS | ✓ | ✓ | ✓ | ✓ |
| Safari iOS | ✓ | ✓ (Add to Home) | ⚠ limited | ✓ |
| Firefox | ✓ | desktop only | ✓ | ✓ |
| Edge | ✓ | ✓ | ✓ | ✓ |

## Privacy

**STUPInD does not:**
- Collect any data
- Send anything to any server
- Use analytics, tracking, or cookies
- Require an account or login
- Sync across devices (intentionally — your data never leaves your device)

**All data is stored in:** `localStorage` (current state) and IndexedDB (none used). Clearing site data wipes everything.

## Background audio — how it works

The timer keeps playing chimes when the tab is minimized/backgrounded by:
1. Pre-scheduling audio events on the Web Audio clock (unaffected by setInterval throttling)
2. Playing a silent 20Hz oscillator at 0.0001 gain to keep the tab "active" in the browser's eyes
3. Registering with the Media Session API (appears in OS media controls)
4. Requesting a Wake Lock on mobile

**Limitation:** When the browser is *fully closed*, nothing runs. Install as a PWA for the OS to treat it more like a standalone app.

## License

MIT. Do what you want.

## Credits

Built with vanilla JavaScript, HTML, CSS — no frameworks, no build step, no dependencies. One file.
