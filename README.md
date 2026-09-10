# Big Walk Radio

A progressive web app that behaves like the radio in Big Walk. Each channel
plays a track that loops from its time of day until the next one takes over and
blends in over the top.

No audio ships with this app. Buy the soundtrack from the composer at
<https://aksfx.bandcamp.com/> and put the files in place; whoever hosts the app
serves them.

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

To put it on a server, see [DEPLOY.md](DEPLOY.md).

## Providing the music

Buy the soundtrack from <https://aksfx.bandcamp.com/>. **Choose Ogg Vorbis**
when Bandcamp asks for a format — see [Seams](#seams) for why it matters here.

Unzip each album into `music/`, next to `index.html`, keeping the folder and
the filenames exactly as they come:

```
index.html
assets/
audio/     <- the switch and channel-change sounds
music/
  aksfx - Radio- Lobby (Original Music from Big Walk)/
    aksfx - Radio- Lobby (Original Music from Big Walk) - 01 -12-00am- Motif.ogg
    aksfx - Radio- Lobby (Original Music from Big Walk) - 02 -7-12am- Leitmotif.ogg
    ...
```

The filenames are the schedule: `-7-12am-` is when that track goes on air, and
it plays on repeat until the next one starts. Don't rename anything. An album
whose tracks carry no times isn't a schedule, so it gets no channel — which is
why B-Sides doesn't get one. Tracks have to sit inside an album folder; a file
loose in `music/` is ignored.

Seven albums make seven channels, and the whole set is about 200 MB as Ogg.
The app reads its channels from `src/core/presets.ts`, generated from those
filenames.

The radio's own noises go in `audio/` alongside, named
`sfx_prop_radio_<action>_<nn>.wav` — the action groups the takes, and the
number just distinguishes them, so adding a fifth channel-change take is a
matter of dropping the file in and regenerating. They stay as WAV: all ten come
to 220 KB, and they are short sharp clicks, which is exactly the material a
lossy codec smears. If they are missing the radio still works, quietly.

Two things the host's server must do:

- **Honour `Range` requests.** The player seeks constantly to stay on the
  broadcast schedule, and cannot without them.
- **Serve the audio MIME types** (`audio/ogg` for Ogg, `audio/mpeg` for MP3).

The dev server does both; `dist/` is a static bundle, so anything that serves
files correctly will do in production.

### A different set of music

Any format the browser can play will work — Ogg, MP3, FLAC, Opus, AAC — though
the loop seams are cleanest with one that doesn't pad. If the files change,
regenerate the dial:

```
npm run presets    # rescans ./music, rewrites src/core/presets.ts
```

It reads names, times and durations only — never the audio itself, and it
rewrites the sound effect list at the same time. Durations are baked in so the
schedule is right before anything loads; if `ffprobe` isn't available, the
browser reads them from the file headers instead.

## How the broadcast works

The radio is a schedule that runs whether or not anyone is listening. Playback
position is a pure function of wall-clock time, so tuning in lands mid-track
and closing the app doesn't pause anything.

- **Real time** — one broadcast day per real day, anchored to local midnight.
  A track stamped `7:12am` goes on air at 7:12am.
- **Game time** — a whole broadcast day in a few real minutes (24 by default),
  so the dayparts turn over quickly. The music still plays at normal speed; it
  is the schedule that accelerates. There's a setting to compress the track
  timeline as well, which chops the songs; it isn't on the face, and defaults
  to off.

Where two dayparts meet, the outgoing track keeps playing and fades under the
incoming one on an equal-power crossfade, eight seconds long by default.

### Seams

A track repeating for hours has to come round without a gap, and simply
restarting it leaves one: media elements don't restart sample-accurately, and
lossy formats pad both ends of the file. MP3 is the worst of these — LAME
writes about 25 ms of encoder delay plus tail padding, which a decoder that
ignores the header plays as silence at every loop.

So a track never restarts. Where one gives way to the next — including where it
gives way to itself — the two overlap on a short equal-power crossfade, and the
next one is fetched and cued several seconds early so it can come in on time
over a slow connection. A pass through the playlist is therefore one seam
shorter than the tracks it contains, which keeps the whole thing exact.

The seam is 20 ms by default. Formats differ in how much they need it —
measured by decoding each back to PCM and counting samples against a 4:41
track:

| Format | Padding per loop | Size | |
| --- | --- | --- | --- |
| **Ogg Vorbis** | none | 6.7 MB | **what Bandcamp gives you; use this** |
| Opus | none | 3.9 MB | smallest, but needs re-encoding |
| FLAC | none | 27.3 MB | exact, and about 4x the size |
| MP3 | ~29 ms | 9.3 MB | LAME delay plus tail padding |
| AAC | ~23 ms | 4.7 MB | container-dependent |

Ogg is the reason 20 ms is enough. With MP3 the seam has ~29 ms of inserted
silence to cover before it can even start hiding the restart.

Even with a gapless format the overlap is worth keeping, because the restart
itself isn't sample-accurate. The seam, the blend and the length of a game day
are settings rather than controls: they live in `DEFAULT_SETTINGS`, and a
browser that has stored a value of its own keeps it over any change to the
default.

### Tuning in quickly

Because the broadcast is a function of the clock, tuning in almost never means
playing a file from the start: it means starting a few minutes into one. Ogg
carries no seek index, so a browser asked to do that from cold has to open the
file, read its headers, then bisect it with a series of range requests before
it can decode a note. Over a network that is most of what makes a change feel
slow, so three things are arranged to avoid it.

The channels either side of the one you are on are held open, cued and paused,
never sounded. Stepping to one reuses the stream that is already on the file
instead of opening it from cold; stepping back does the same, because the
channel you left becomes a neighbour in its turn. Only a jump of more than one
channel pays the full cost.

A stream is seeked before it is played, not after. Calling `play()` first makes
the browser buffer from the top of the file and then throw that away when the
seek lands, which is two trips for one channel.

The rise is scheduled on the audio clock in one go at the moment of the switch,
rather than sampled on the scheduler's tick. The tick is 250 ms and the fade is
200 ms, so sampling one with the other used to stretch a 320 ms envelope out to
something nearer half a second.

`test/latency.test.ts` holds all three to account. It measures rather than
times: how many times the browser was sent to find a file, in what order it was
asked to seek and play, and what the tuning gain reaches at a given moment —
all exact, and none of it needing a network or a speaker.

## Listening offline

The app shell is cached on first visit, so the radio opens with no connection.
The music is not: it streams from the host, and 145 MB is not something to
collect on anyone's behalf without asking.

The welcome sheet — the **i** in the top left — has a button that fetches the
lot into a cache of its own, with a progress bar, and a **Remove** to give the
space back. The service worker answers `/music/` and `/audio/` out of that
cache when it holds the file, slicing byte ranges itself so a stored track is
still seekable; anything it doesn't hold falls through to the host. It never
puts anything there on its own.

Two things worth knowing:

- **Install it to the home screen first.** An installed PWA gets its own
  storage, so a copy downloaded in the browser tab does not follow it across.
  The sheet says so above the button.
- **The service worker only registers in a production build.** `npm run dev`
  will happily fill the cache, but nothing reads it back; test offline against
  `npm run build && npm run preview`.

The download is resumable — files already held are skipped — and survives a
deploy. The shell cache is versioned and cleared on activation; the audio cache
is deliberately left alone, since a changed stylesheet is no reason to refetch
145 MB. Sizes come from `src/core/presets.ts`, measured at generation time, so
the total can be quoted before a single byte moves.

## The controls

The unit is a single screen. A lamp and a power switch sit to the left of the
display, which shows a lit tick per channel and a red marker on the tuning
dial; the speaker fills the middle, and a tray along the bottom holds the rest:

- a **volume knob** — turn it, scroll it, or use the arrow keys
- an **on/off switch**, which returns to the channel last listened to
- **seek buttons**, which wrap around the channels and do nothing while the
  radio is off, since the switch owns that
- a **rocker** switching the clock between real time and game time

The **speaker grille** is a button too: pressing it clicks on through each
channel in turn and then round to off again — the whole radio worked from one
place, without aiming at anything small.

The switch and the seek buttons are also available from outside the page:
**play** and **pause** work the on/off switch, and **previous** and **next
track** step between channels — from the lock screen, a headphone button, a
Bluetooth remote or the keyboard's media keys. Stop counts as off. Like the
seek buttons on screen, the track buttons do nothing while the radio is off —
and switching off pauses everything, so the platform drops the now-playing
widget and there is nothing left to press. That is expected: turning the radio
back on is done in the app.

The switch, the seek buttons and the grille all move the same thing underneath:
one position, where 0 is off and 1…n select a channel. So every change, from
whichever control, is covered by the radio's own click, which the incoming
channel then comes up under — nothing ever cuts straight from one track to
another.
Switching on, switching off and changing channel each have several takes to
choose between, picked at random but never the same one twice running, so
working the switch doesn't sound like one recording on repeat.

The radio always opens switched off. A browser won't start audio without a
press, so a remembered position could only ever be a lie. The channel it was
left on is remembered, along with volume and the clock settings.

The scheduler can also play a program on shuffle, dealing a fresh order each
time through from the pass number rather than storing one — random to listen
to, identical for everyone, and unchanged by reloading. Nothing on the dial
uses it at the moment.

