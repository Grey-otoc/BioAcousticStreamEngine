# BASE Viewer

An ambient live-detection display that subscribes to a BASE MQTT feed and shows incoming species detections as a full-screen photo gallery with sounds. Designed for kiosk screens, public displays, remote monitoring rooms, and Yodeck deployments.

Served automatically at `http://localhost:8000/viewer/` when the BASE web UI is running. Also works as a standalone page (`viewer/index.html`) opened directly in a browser against any accessible MQTT broker.

---

## What the viewer shows

Each species detected by BASE appears as a card in the gallery:

| Card element | Description |
|---|---|
| **Photo** | Species photograph — bundled stock image or your own upload |
| **Common name** | e.g. *Robin* |
| **Scientific name** | e.g. *Erithacus rubecula* |
| **Confidence badge** | Colour-coded: green ≥70%, amber ≥45%, red below |
| **Detection count** | `×N` — how many times detected this session |
| **Location** | `Site · Monitoring Location` (e.g. *Charlbury · Garden*) |
| **First / last seen** | Timestamps of first and most recent detection |

Cards are sorted most-recent-first and reorder live as new detections arrive. When more cards are present than fit in three rows the gallery scrolls.

Detections from **different sites are always kept on separate cards** — a Robin at Charlbury and a Robin at Weaveley Solar will appear as two distinct cards and never merge.

---

## Animated listening state

When no species have been detected yet (or after the gallery has fully expired), the viewer shows a pulsing bar animation with the label *Listening…* to confirm the system is live and connected.

---

## Getting started

### Via BASE (recommended)

1. Start the BASE web server: `bash start_web.sh`
2. Open `http://localhost:8000/viewer/` in a browser
3. Click **⚙ Settings** and enter your MQTT broker URL and topic prefix
4. Click **Save & Connect**
5. Click the sound button to enable audio playback (required by browser security policy)

The viewer is served from the same origin as the BASE API, so it automatically picks up the monitoring location configuration from the API.

### Standalone (no BASE server)

Open `viewer/index.html` directly in Chrome, Firefox, or Edge. The MQTT broker must be reachable via WebSocket (`wss://` or `ws://`). Configure connection details in **⚙ Settings**.

---

## Connection settings

| Setting | Description |
|---|---|
| **Broker URL** | WebSocket URL of your MQTT broker — must start with `wss://`, `ws://`, or `mqtts://`. Example: `wss://your-broker:8084/mqtt` |
| **Topic prefix** | Must match `topic_prefix` in BASE `settings.yaml` (default: `bioacoustics`) |
| **Username / Password** | Broker credentials — stored only in the browser, never sent to any server |

Settings are saved in the browser's `localStorage` and persist across page reloads.

---

## URL parameters

The viewer accepts URL parameters to pre-configure behaviour — useful for kiosk deployments where you cannot interact with the settings panel.

| Parameter | Description | Example |
|---|---|---|
| `broker` | Broker WebSocket URL — auto-connects on load | `?broker=wss://host:8084/mqtt` |
| `prefix` | Topic prefix (default: `bioacoustics`) | `?prefix=bioacoustics` |
| `probability` | Confidence threshold (0–1) pre-set on load | `?probability=0.65` |

Do not include broker credentials in the URL if the URL will be visible to others or stored in a shared system. Enter credentials once through the Settings panel instead — they are stored locally in the browser.

---

## Confidence filter

A slider in the header controls the minimum confidence score required for a card to appear. Cards below the threshold are hidden but not deleted — raising the slider again brings them back.

The threshold is remembered in `localStorage` across sessions. It can also be pre-set via the `probability` URL parameter (see above).

---

## Detection retention

Cards are automatically removed once a species hasn't been detected for longer than the configured retention period. A background check runs every 2 minutes.

The retention period is set in **⚙ Settings → Keep detections for**:

| Option | Description |
|---|---|
| 1 hour | Short kiosk sessions or high-throughput sites |
| 6 hours | Half-day monitoring window |
| **1 day** | **Default** — cards persist through a full recording day |
| 3 days | Multi-day deployments |
| 7 days | Week-long field surveys |
| Unlimited | Cards never expire automatically |

The setting is saved in `localStorage`. When the page is reloaded, cached entries older than the current retention period are discarded immediately.

---

## Sounds

Upload up to 5 audio recordings per species (MP3, WAV, OGG). Each time that species is detected, one is chosen at random and played. Up to 3 sounds can play simultaneously to create a natural ambient soundscape.

1. Click any species card to open the detail panel
2. Under **Sounds**, click **+ Upload** and select files
3. Click **▶** to preview; **✕** to delete
4. Default sounds (if present in `assets/sounds/<species>.mp3`) play automatically before any custom recordings are uploaded

Sounds are stored in the browser's IndexedDB and persist across sessions on the same device.

---

## Photos

108 UK species stock images are bundled in `assets/images/`, sourced from Wikimedia Commons under open licences.

To replace a stock image or add one for a new species:

1. Click a species card → detail panel opens
2. Click **+ Upload your own** (or **↑ Replace photo**) and select a JPEG, PNG, or WebP file
3. The photo is stored in IndexedDB and replaces the stock image immediately

Photos persist across sessions on the same browser and device but are not shared across devices.

---

## Explainer panel

A collapsible **How BASE Works** section introduces the system to visitors unfamiliar with bioacoustic monitoring. On desktop, click **✕** in the panel header to hide it — the viewer remembers this preference. Click **ℹ** in the top-right of the header to show it again. On mobile it opens as a centred modal.

---

## Local Mosquitto (WebSocket)

If connecting to a local Mosquitto broker, add WebSocket support to `/etc/mosquitto/mosquitto.conf`:

```
listener 9001
protocol websockets
```

Restart Mosquitto: `sudo systemctl restart mosquitto`

Then use `ws://localhost:9001` (or the machine's IP) as the broker URL in the viewer settings.

---

## Browser storage

| Storage type | What is stored |
|---|---|
| `localStorage` | Settings (broker URL, prefix, sound on/off, confidence threshold, explainer state), today's species gallery cache |
| `IndexedDB` | Custom species photos and uploaded sound clips |

Clearing browser storage (DevTools → Application → Storage → Clear) will remove all photos, sounds, the gallery cache, and saved settings.
