# Big Walk Radio

A progressive web app that behaves like the radio in Big Walk. Each channel
plays a track that loops from its time of day until the next one takes over and
blends in over the top.

No audio ships with this app. The files are served by whoever hosts it.

## Running it

```
npm install
npm run dev        # serves the app and ./music together
npm test
npm run build      # writes dist/ -- app only, ~90 kB, no audio
```

`npm run sim` drives the same engine from the command line, which is the
quickest way to check the schedule against the game:

```
npm run sim                  # what all eight channels are playing right now
npm run sim -- --at 7:12am   # at a given time of day
npm run sim -- --ch 5        # sit the dial on a channel
npm run sim -- --game 24     # a 24-real-minute broadcast day
npm run sim -- --day         # every daypart, its window and loop count
npm run sim -- --watch       # live
```

## Providing the music

Put the soundtrack at `music/` next to `index.html`, in the layout it ships
with — one folder per album, filenames unchanged:

```
index.html
assets/
music/
  aksfx - Radio- Lobby (Original Music from Big Walk)/
    aksfx - Radio- Lobby (Original Music from Big Walk) - 01 -12-00am- Motif.mp3
    aksfx - Radio- Lobby (Original Music from Big Walk) - 02 -7-12am- Leitmotif.mp3
    ...
```

The filenames are the schedule: `-7-12am-` is when that track goes on air, and
it plays on repeat until the next one starts. An album whose tracks carry no
times isn't a schedule, so it gets no channel. The app reads its channels from
`src/core/presets.ts`, which is generated from those filenames.

Two things the host's server must do:

- **Honour `Range` requests.** The player seeks constantly to stay on the
  broadcast schedule, and cannot without them.
- **Serve the audio MIME types** (`audio/mpeg` for MP3, and friends).

The dev server does both; `dist/` is a static bundle, so anything that serves
files correctly will do in production.

### A different set of music

The format doesn't matter as long as the browser can play it — MP3, FLAC,
Opus, AAC. If the files change, regenerate the dial:

```
npm run presets    # rescans ./music, rewrites src/core/presets.ts
```

It reads names, times and durations only — never the audio itself. Durations
are baked in so the schedule is right before anything loads; if `ffprobe`
isn't available, the browser reads them from the file headers instead.

## How the broadcast works

The radio is a schedule that runs whether or not anyone is listening. Playback
position is a pure function of wall-clock time, so tuning in lands mid-track
and closing the app doesn't pause anything.

- **Real time** — one broadcast day per real day, anchored to local midnight.
  A track stamped `7:12am` goes on air at 7:12am.
- **Game time** — a whole broadcast day in a few real minutes (24 by default),
  so the dayparts turn over quickly. The music still plays at normal speed; it
  is the schedule that accelerates. There's a setting to compress the track
  timeline as well, which chops the songs.

Where two dayparts meet, the outgoing track keeps playing and fades under the
incoming one on an equal-power crossfade. The blend length is adjustable on
screen.

## The controls

There are four ways in:

- a **wheel** for volume — turn it, scroll it, or use the arrow keys
- an **on/off switch**, which returns to the channel last listened to
- **forward and back buttons**, which wrap around the channels and do nothing
  while the radio is off, since the switch owns that
- a **single button** that clicks on through each channel in turn and then off
  again

They all move the same thing underneath: one position, where 0 is off and
1…n select a channel. So every change, from whichever control, is covered by
the same short burst of static that the incoming channel then rises through —
nothing ever cuts straight from one track to another, and switching off fades
the static away to silence rather than stopping dead.

The radio always opens switched off. A browser won't start audio without a
press, so a remembered position could only ever be a lie. The channel it was
left on is remembered, along with volume and the clock settings.

The scheduler can also play a program on shuffle, dealing a fresh order each
time through from the pass number rather than storing one — random to listen
to, identical for everyone, and unchanged by reloading. Nothing on the dial
uses it at the moment.

